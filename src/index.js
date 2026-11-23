import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const TAG = '<!-- discussion-curator:v1 -->';
export const SUMMARY = `${TAG}\n<!-- summary -->`;
export const CONTEXT = `${TAG}\n<!-- context -->`;
const fields = 'id body createdAt author{login} viewerCanUpdate';
export const hash = text => createHash('sha256').update(text).digest('hex');
export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const byCreated = (a, b) => compare(a.createdAt, b.createdAt) || compare(a.id, b.id);

export async function request(url, token, payload, method, fetcher = fetch) {
  let response;
  try {
    response = await fetcher(url, {
      method: method ?? (payload === undefined ? 'GET' : 'POST'),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json', 'User-Agent': 'discussion-curator' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(120000), redirect: 'error',
    });
  } catch {
    throw new Error(`Request failed for ${new URL(url).host}; check network and endpoint`);
  }
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} from ${new URL(url).host}`);
    error.status = response.status;
    throw error;
  }
  // Do not log provider bodies or request headers (may contain secrets).
  try { return await response.json(); } catch { throw new Error('API returned invalid JSON'); }
}

export class GitHub {
  constructor(env = process.env, transport = request) {
    this.token = env.GH_TOKEN;
    this.repo = env.GITHUB_REPOSITORY;
    this.transport = transport;
  }
  async gql(query, variables = {}) {
    const result = await this.transport('https://api.github.com/graphql', this.token, { query, variables });
    if (result.errors?.length) {
      const operation = query.match(/(?:mutation|query).*?\{\s*(\w+)/s)?.[1] ?? 'unknown';
      const details = result.errors.map(e => `${e.type ?? 'GRAPHQL'} ${e.message ?? ''}`.slice(0, 300)).join('; ');
      throw new Error(`GitHub GraphQL ${operation} failed: ${details}`);
    }
    return result.data;
  }
  async connection(id, field, selection = fields) {
    const type = field === 'comments' ? 'Discussion' : 'DiscussionComment';
    const nodes = [];
    let cursor = null;
    do {
      const data = await this.gql(`query($id:ID!,$cursor:String){node(id:$id){... on ${type}{${field}(first:100,after:$cursor){nodes{${selection}}pageInfo{hasNextPage endCursor}}}}}`, { id, cursor });
      const page = data.node[field];
      nodes.push(...page.nodes);
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);
    return nodes;
  }
  async discussions() {
    const [owner, name] = this.repo.split('/');
    const discussions = [];
    let cursor = null, meta;
    do {
      const data = await this.gql(`query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){
        id discussionCategories(first:100){nodes{id name isAnswerable}}
        discussions(first:100,after:$cursor,orderBy:{field:CREATED_AT,direction:ASC}){
        nodes{id number title body url createdAt author{login} category{id name}}pageInfo{hasNextPage endCursor}}}}`, { owner, name, cursor });
      meta = data.repository;
      discussions.push(...meta.discussions.nodes);
      cursor = meta.discussions.pageInfo.hasNextPage ? meta.discussions.pageInfo.endCursor : null;
    } while (cursor);
    return { meta, discussions };
  }
  async create(repositoryId, categoryId, title, body) {
    const data = await this.gql('mutation($input:CreateDiscussionInput!){createDiscussion(input:$input){discussion{id number body}}}', {
      input: { repositoryId, categoryId, title, body },
    });
    return data.createDiscussion.discussion;
  }
  async comment(discussionId, body, existing) {
    if (existing) {
      await this.gql('mutation($input:UpdateDiscussionCommentInput!){updateDiscussionComment(input:$input){comment{id}}}', { input: { commentId: existing, body } });
      return existing;
    }
    const data = await this.gql('mutation($input:AddDiscussionCommentInput!){addDiscussionComment(input:$input){comment{id}}}', { input: { discussionId, body } });
    return data.addDiscussionComment.comment.id;
  }
  async doc(key, body) {
    const url = `https://api.github.com/repos/${this.repo}/contents/doc/discussions/${key}.md`;
    let old;
    try { old = await this.transport(url, this.token); } catch (error) { if (error.status !== 404) throw error; }
    if (old && Buffer.from(old.content, 'base64').equals(Buffer.from(body))) return;
    await this.transport(url, this.token, {
      message: `docs: sync discussion summary ${key}`,
      content: Buffer.from(body).toString('base64'), ...(old ? { sha: old.sha } : {}),
    }, 'PUT');
  }
}

export function blacklist(raw = '{}') {
  const value = JSON.parse(raw || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('BOT_BLACKLIST must be a JSON object');
  for (const key of ['users', 'discussions', 'categories']) {
    value[key] ??= [];
    if (!Array.isArray(value[key]) || value[key].some(item => key === 'discussions' ? !Number.isInteger(item) : typeof item !== 'string')) {
      throw new Error(`Invalid BOT_BLACKLIST.${key}`);
    }
  }
  return value;
}
export function excluded(item, blocked) {
  const login = item.author?.login ?? '';
  return (blocked.users ?? []).some(x => x.toLowerCase() === login.toLowerCase()) || login.endsWith('[bot]') || (item.body ?? '').startsWith(TAG);
}
export async function systemPrompt(env = process.env) {
  return env.BOT_SYSTEM_PROMPT?.trim() ? env.BOT_SYSTEM_PROMPT : readFile(new URL('../.github/prompts/system.md', import.meta.url), 'utf8');
}
export function messages(prompt, rules, context, source) {
  return [{ role: 'system', content: prompt }, { role: 'system', content: rules },
    ...context.map(c => ({ role: 'system', content: c.body })),
    { role: 'user', content: stable(source) }];
}
export function validateResult(value) {
  if (!value || typeof value.summary !== 'string' || !value.summary.trim()) throw new Error('Model response missing summary');
  const reply = value.reply;
  if (reply != null && (!['ask', 'critical_error'].includes(reply.reason) || typeof reply.body !== 'string' || !reply.body.trim())) throw new Error('Invalid model reply');
  if (value.summary.length > 55000 || (reply?.body.length ?? 0) > 55000) throw new Error('Model response too long for GitHub');
  return value;
}
export async function generate(msg, env = process.env, transport = request) {
  const endpoint = (env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  if (new URL(endpoint).protocol !== 'https:') throw new Error('LLM_BASE_URL must use HTTPS');
  const response = await transport(`${endpoint}/chat/completions`, env.LLM_API_KEY, {
    model: env.LLM_MODEL, messages: msg, response_format: { type: 'json_object' },
  });
  let value;
  try { value = JSON.parse(response.choices[0].message.content); } catch { throw new Error('Model response is not a JSON object'); }
  return validateResult(value);
}

export async function main({ env = process.env, gh = new GitHub(env), event, llm, rules, prompt } = {}) {
  const blocked = blacklist(env.BOT_BLACKLIST);
  event ??= JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  const actor = event.sender?.login ?? '';
  if (excluded({ author: { login: actor } }, blocked)) return;
  const target = event.discussion ?? {};
  if (blocked.discussions.includes(target.number) || blocked.categories.includes(target.category?.name)) return;
  const { meta, discussions } = await gh.discussions();
  const roots = {};
  for (const [kind, marker] of [['summary', SUMMARY], ['context', CONTEXT]]) {
    const matches = discussions.filter(d => d.body.startsWith(marker));
    if (matches.length > 1) throw new Error(`Duplicate ${kind} discussions; resolve before continuing`);
    if (matches.length) roots[kind] = matches[0];
    else {
      const categories = meta.discussionCategories.nodes;
      const category = env.BOT_CATEGORY ? categories.find(c => c.name === env.BOT_CATEGORY) : categories.find(c => !c.isAnswerable);
      if (!category) throw new Error('Enable Discussions and configure BOT_CATEGORY as an open category');
      const description = kind === 'summary' ? '自动总结索引：每个板块一条回复；正文与 doc/discussions 完全一致。' :
        '固定上下文入口。主帖不进入模型上下文。管理员在下面追加稳定背景或规则；脚本按创建时间、ID 顺序读取所有一级回复作为可信上下文。模型无权修改本帖或回复。修改旧回复将影响后续缓存。';
      roots[kind] = await gh.create(meta.id, category.id, `Discussion Bot — ${kind}`, `${marker}\n\n${description}`);
    }
  }
  const ownIds = new Set(Object.values(roots).map(d => d.id));
  if (ownIds.has(target.node_id) || target.body?.startsWith(TAG)) return;
  if (env.BOT_INIT_ONLY === 'true') { console.log('Bot discussions initialized.'); return; }
  if (!env.LLM_API_KEY || !env.LLM_MODEL) {
    console.log('Configure LLM_API_KEY secret and LLM_MODEL variable to enable generation.');
    return;
  }
  const context = (await gh.connection(roots.context.id, 'comments')).sort(byCreated);
  const existing = await gh.connection(roots.summary.id, 'comments');
  const groups = new Map(meta.discussionCategories.nodes.map(c => [c.id, []]));
  for (const discussion of discussions) {
    if (ownIds.has(discussion.id) || excluded(discussion, blocked) || blocked.discussions.includes(discussion.number) || blocked.categories.includes(discussion.category.name)) continue;
    const clean = [];
    for (const comment of await gh.connection(discussion.id, 'comments')) {
      clean.push(...(await gh.connection(comment.id, 'replies')).filter(r => !excluded(r, blocked)));
      if (!excluded(comment, blocked)) clean.push(comment);
    }
    discussion.comments = clean.sort(byCreated);
    if (!groups.has(discussion.category.id)) groups.set(discussion.category.id, []);
    groups.get(discussion.category.id).push(discussion);
  }
  prompt ??= await systemPrompt(env);
  rules ??= await readFile(env.BOT_RULES_PATH || '.github/discussion-bot/rules.md', 'utf8');
  llm ??= msg => generate(msg, env);
  for (const [category, items] of [...groups].sort(([a], [b]) => compare(a, b))) {
    const key = hash(category).slice(0, 16);
    const marker = `<!-- category:${key} -->`;
    const prefix = `${TAG}\n${marker}`;
    const previous = existing.find(c => c.body.startsWith(prefix));
    if (!items.length && !previous) continue;
    const source = { discussions: items };
    const fingerprint = hash(stable([messages(prompt, rules, context, source), env.LLM_MODEL, env.LLM_BASE_URL]));
    const stamp = `<!-- input:${fingerprint} -->`;
    if (previous?.body.includes(stamp)) { await gh.doc(key, previous.body); continue; }
    if (previous?.viewerCanUpdate === false) {
      throw new Error('GitHub token cannot edit the summary comment. Configure BOT_GITHUB_TOKEN with Discussions and Contents read/write for this repository. No LLM request was sent for this section.');
    }
    const trigger = { discussion: target.number ?? null, comment: event.comment?.node_id ?? null,
      body: (event.comment ?? target).body ?? '', active: items.some(d => d.number === target.number) };
    source.trigger = trigger;
    const result = validateResult(items.length ? await llm(messages(prompt, rules, context, source)) : { summary: '本板块当前没有可总结的有效讨论。', reply: null });
    const pending = `${prefix}\n${stamp.replace('input:', 'pending:')}\n\n${result.summary}`;
    const savedId = await gh.comment(roots.summary.id, pending, previous?.id);
    if (trigger.active) {
      const origin = trigger.comment || target.node_id;
      const replyPrefix = `${TAG}\n<!-- reply:${origin} -->`;
      const current = items.find(d => d.number === target.number);
      const old = (await gh.connection(current.id, 'comments')).find(c => c.body.startsWith(replyPrefix));
      const reply = result.reply;
      const allowed = reply && (reply.reason === 'critical_error' || /^\s*\/ask\b/m.test(trigger.body));
      if (allowed) await gh.comment(current.id, `${replyPrefix}\n\n${reply.body}`, old?.id);
      else if (old) await gh.comment(current.id, `${replyPrefix}\n\n原发言已更新，先前的自动回复已撤回。`, old.id);
    }
    const body = `${prefix}\n${stamp}\n\n${result.summary}`;
    // Final stamp is published only after doc/reply writes succeed, allowing safe retries.
    await gh.doc(key, body);
    await gh.comment(roots.summary.id, body, savedId);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
