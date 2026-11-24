// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Anitier2005. See LICENSE for terms and warranty disclaimer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHub, main, TAG, SUMMARY, CONTEXT, blacklist, excluded, messages, systemPrompt, validateResult, generate, request, appendContext, readContext, summaryBatches } from '../src/index.js';

test('stable prefix preserves system and context when source changes', () => {
  const a = messages('prompt', 'rules', [{ body: 'context' }], { body: 'old' });
  const b = messages('prompt', 'rules', [{ body: 'context' }], { body: 'new' });
  assert.deepEqual(a.slice(0, -1), b.slice(0, -1));
  assert.notDeepEqual(a.at(-1), b.at(-1));
});
test('blacklist validates types and ignores user case, bot identities and generated content', () => {
  assert.throws(() => blacklist('{"users":"alice"}'));
  assert.throws(() => blacklist('{"discussions":["1"]}'));
  const blocked = blacklist('{"users":["Alice"]}');
  assert.ok(excluded({ author: { login: 'alice' } }, blocked));
  assert.ok(excluded({ author: { login: 'github-actions[bot]' } }, blocked));
  assert.ok(excluded({ author: { login: 'custom-app', __typename: 'Bot' } }, blocked));
  assert.ok(excluded({ body: `${TAG}\nsummary` }, blocked));
  assert.ok(!excluded({ author: null, body: 'human' }, blocked));
});
test('system prompt variable overrides independent Markdown fallback', async () => {
  assert.equal(await systemPrompt({ BOT_SYSTEM_PROMPT: 'custom' }), 'custom');
  assert.match(await systemPrompt({ BOT_SYSTEM_PROMPT: '  ' }), /Discussion/);
});
test('model result validation and single response extraction', async () => {
  assert.throws(() => validateResult({ summary: 'ok', reply: { reason: 'spam', body: 'bad' } }));
  assert.throws(() => validateResult({ summary: '' }));
  assert.throws(() => validateResult({ summary: 'a'.repeat(55001) }));
  const env = { LLM_BASE_URL: 'https://provider.example/v1/', LLM_MODEL: 'model', LLM_API_KEY: 'test' };
  let calls = 0;
  const result = await generate([], env, async (url, token, payload) => {
    calls++;
    assert.equal(url, 'https://provider.example/v1/chat/completions');
    assert.equal(payload.model, 'model');
    return { choices: [{ message: { content: '{"summary":"one canonical document","reply":null}' } }] };
  });
  assert.equal(calls, 1);
  assert.equal(result.summary, 'one canonical document');
});
test('HTTP failure does not expose provider body or token', async () => {
  await assert.rejects(request('https://provider.example/v1', 'secret-value', {}, undefined,
    async () => ({ ok: false, status: 401, text: async () => 'secret-value' })), /^Error: HTTP 401 from provider.example$/);
});
test('model accepts fenced JSON and reports empty output without logging provider text', async () => {
  const response = content => ({ choices: [{ finish_reason: 'stop', message: { content } }] });
  assert.equal((await generate([], {}, async () => response('```json\n{"summary":"done"}\n```'))).summary, 'done');
  await assert.rejects(generate([], {}, async () => response('')), /no text \(finish_reason=stop\)/);
});
test('model retries gateway timeouts and honors provider backoff', async () => {
  const delays = [];
  const responses = [new Response(null, { status: 524, headers: { 'Retry-After': '120' } }), new Response(null, { status: 429, headers: { 'Retry-After': '8' } }),
    Response.json({ choices: [{ message: { content: '{"summary":"done"}' } }] })];
  const result = await generate([], {}, (url, token, payload) => request(url, token, payload, undefined, async () => responses.shift()),
    async delay => { delays.push(delay); });
  assert.equal(result.summary, 'done');
  assert.equal(delays.length, 2);
  assert.equal(delays[0], 120000);
  assert.equal(delays[1], 8000);
});
test('model limits transient attempts and fails fast on permanent errors or long cooldowns', async () => {
  for (const [status, retryAfter, expectedCalls] of [[524, undefined, 3], [401, undefined, 1], [429, '181', 1]]) {
    let calls = 0;
    await assert.rejects(generate([], {}, async () => {
      calls++;
      throw Object.assign(new Error('provider failed'), { status, retryAfter });
    }, async () => {}), /provider failed/);
    assert.equal(calls, expectedCalls);
  }
});
test('GitHub paginates all comments', async () => {
  const gh = new GitHub({});
  let calls = 0;
  gh.gql = async (query, vars) => {
    calls++;
    assert.match(query, /on Discussion\{/);
    assert.equal(vars.cursor, calls === 1 ? null : 'next');
    return { node: { comments: { nodes: [{ id: String(calls) }], pageInfo: { hasNextPage: calls === 1, endCursor: 'next' } } } };
  };
  assert.deepEqual(await gh.connection('root', 'comments'), [{ id: '1' }, { id: '2' }]);
});
test('doc copies exact UTF-8 bytes and skips identical writes', async () => {
  const body = `${TAG}\n\n中文 Markdown\n`;
  const calls = [];
  const gh = new GitHub({ GH_TOKEN: 'test', GITHUB_REPOSITORY: 'owner/repo' }, async (...args) => {
    calls.push(args);
    if (calls.length === 1) throw Object.assign(new Error('missing'), { status: 404 });
    return {};
  });
  await gh.doc('category', body);
  assert.equal(Buffer.from(calls[1][2].content, 'base64').toString(), body);
  gh.transport = async (...args) => { assert.equal(args.length, 2); return { content: Buffer.from(body).toString('base64') }; };
  await gh.doc('category', body);
});

class FakeGitHub {
  rows = [{ id: 'human', number: 1, title: 'Question', body: '/ask what?', url: 'https://example.test/1', createdAt: '0', author: { login: 'alice' }, category: { id: 'general', name: 'General' } }];
  comments = new Map(); docs = new Map(); created = 0;
  async discussions() { return { meta: { id: 'repo', discussionCategories: { nodes: [{ id: 'general', name: 'General', isAnswerable: false }] } }, discussions: structuredClone(this.rows) }; }
  async create(repo, category, title, body) { const row = { id: title, number: this.rows.length + 1, body, author: { login: 'discussion-curator', __typename: 'Bot' } }; this.rows.push(row); return row; }
  async connection(id) { return structuredClone(this.comments.get(id) ?? []); }
  async comment(discussion, body, existing, replyToId) {
    const destination = replyToId || discussion;
    if (!this.comments.has(destination)) this.comments.set(destination, []);
    if (existing) [...this.comments.values()].flat().find(c => c.id === existing).body = body;
    else { existing = String(++this.created); this.comments.get(destination).push({ id: existing, body, createdAt: '0', author: { login: 'discussion-curator', __typename: 'Bot' } }); }
    return existing;
  }
  async deleteComment(id) { for (const [key, rows] of this.comments) this.comments.set(key, rows.filter(c => c.id !== id)); }
  async doc(key, body) { this.docs.set(key, body); }
}
const fixture = () => ({ gh: new FakeGitHub(), env: { LLM_API_KEY: 'test', LLM_MODEL: 'model' },
  prompt: 'system', rules: 'rules', event: { sender: { login: 'alice' }, discussion: { number: 1, node_id: 'human', body: '/ask what?' } } });
test('published context contains no literal mention and restores the original message', async () => {
  const gh = new FakeGitHub();
  const record = { id: 'record', repo: 'owner/repo', messages: [{ role: 'user', content: '@alice @owner/team alice@example.org' }] };
  await appendContext(gh, 'context', [], record, 'discussion-curator');
  const rows = gh.comments.get('context');
  assert.doesNotMatch(rows[0].body, /@/);
  assert.deepEqual(readContext(rows, record.repo, 'discussion-curator')[0].messages, record.messages);
});
test('oversize discussions retain all Unicode text and original evidence IDs across bounded fragments', () => {
  const root = { id: 'root', number: 1, body: '文'.repeat(4000), comments: [{ id: 'comment', parentId: 'parent', body: '📎'.repeat(6000) }] };
  const fragments = summaryBatches([root], 1).flat();
  assert.equal(fragments.map(item => item.body).join(''), root.body);
  assert.equal(fragments.flatMap(item => item.comments).map(comment => comment.body).join(''), root.comments[0].body);
  assert.ok(fragments.every(item => item.id === root.id && Buffer.byteLength(JSON.stringify(item)) <= 12000));
  assert.ok(fragments.flatMap(item => item.comments).every(comment => comment.id === 'comment' && comment.parentId === 'parent'));
});
test('interrupted batch runs resume from App-owned checkpoints and publish only a complete summary', async () => {
  const options = fixture();
  options.event = {};
  Object.assign(options.env, { GITHUB_REPOSITORY: 'owner/repo', BOT_APP_LOGIN: 'discussion-curator', BOT_BATCH_THREADS: '2' });
  const first = options.gh.rows[0];
  for (let number = 2; number <= 5; number++) options.gh.rows.push({ ...first, id: `thread-${number}`, number });
  const calls = [];
  let fail = true;
  options.llm = async msg => {
    const payload = JSON.parse(msg.at(-1).content);
    const key = payload.drafts ? 'merge' : payload.discussions.map(d => d.number).join(',');
    calls.push(key);
    if (fail && key === '3,4') throw Object.assign(new Error('HTTP 524'), { status: 524 });
    if (payload.drafts) assert.ok(payload.drafts.every(d => d.summary.endsWith(' @alice')));
    return { summary: `${key} @alice`, reply: null };
  };
  await assert.rejects(main(options), /rerun to resume deferred batches/);
  assert.equal(options.gh.docs.size, 0);
  assert.equal(options.gh.comments.get('Discussion Bot — summary'), undefined);
  for (const row of options.gh.comments.get('Discussion Bot — context')) assert.doesNotMatch(row.body, /@/);
  fail = false;
  await main(options);
  assert.deepEqual(calls, ['1,2', '3,4', '5', '3,4', 'merge']);
  assert.equal(options.gh.comments.get('Discussion Bot — summary')[0].body, [...options.gh.docs.values()][0]);
  await main(options);
  assert.equal(calls.length, 5);
});
test('proposal summaries rebuild matching legacy cache and publish source-backed rows', async () => {
  const options = fixture();
  options.event = {};
  options.rules = '议题、方案、状态、提出者、判定依据、来源';
  options.gh.rows[0].body = '先提议用粗粒度锁，现明确撤回该方案。';
  const proposal = { topic: '并发控制', plan: '粗粒度锁', status: '已放弃', proposer_ids: ['human'],
    evidence_id: 'human', evidence_quote: '现明确撤回该方案', basis: '提出者明确撤回' };
  let calls = 0;
  options.llm = async () => {
    calls++;
    return { summary: '## 测试\n\n由 @alice 提出。\n\n<!-- proposal-table -->', proposals: [proposal], reply: null };
  };
  await main(options);
  const root = options.gh.rows.find(d => d.body.startsWith(SUMMARY));
  const comment = options.gh.comments.get(root.id)[0];
  assert.match(comment.body, /粗粒度锁 \| 已放弃 \| alice/);
  assert.match(comment.body, /由 alice 提出/);
  assert.doesNotMatch(comment.body, /@alice/);
  assert.match(comment.body, /\[#1\]\(https:\/\/example.test\/1\)/);
  assert.equal(comment.body, [...options.gh.docs.values()][0]);
  await main(options);
  assert.equal(calls, 2);

  // Keep the matching input stamp to exercise the cache path.
  comment.body = comment.body.split('\n\n')[0] + '\n\n### 决定与共识\n\n旧版总结';
  const previousDoc = [...options.gh.docs.values()][0];
  const validLlm = options.llm;
  options.llm = async () => ({ summary: '<!-- proposal-table -->', proposals: [{ ...proposal, evidence_quote: '不存在的引用' }] });
  await assert.rejects(main(options), /evidence quote/);
  assert.match(comment.body, /旧版总结/);
  assert.equal([...options.gh.docs.values()][0], previousDoc);
  options.llm = validLlm;
  await main(options);
  assert.equal(calls, 4);
  assert.equal(comment.body, previousDoc);
});
test('batch summaries repair missing proposal data and insert missing table markers', async () => {
  const options = fixture();
  options.event = {};
  options.env.BOT_BATCH_THREADS = '1';
  options.rules = '议题、方案、状态、提出者、判定依据、来源';
  options.gh.rows.push({ ...options.gh.rows[0], id: 'other', number: 2 });
  let repairs = 0;
  options.llm = async msg => {
    const source = JSON.parse(msg.at(-1).content);
    if (source.validation_error) repairs++;
    if (source.discussions?.[0].id === 'human' && !source.validation_error) return { summary: 'missing proposals' };
    return { summary: 'draft\n### 方案状态\n| 议题 | 方案 | 状态 |\n| --- | --- | --- |\n| fabricated row | x | y |\n<!-- proposal-table -->\n<!-- proposal-table -->', proposals: [] };
  };
  await main(options);
  assert.equal(repairs, 1);
  const doc = [...options.gh.docs.values()][0];
  assert.equal(doc.match(/### 方案状态/g).length, 1);
  assert.doesNotMatch(doc, /fabricated row/);
});
test('reconcile summarizes once, syncs bytes, reuses replies on edit and removes deleted sources', async () => {
  const options = fixture(); let calls = 0;
  options.llm = async () => { calls++; return { summary: '# 共识\n需要证据', reply: { reason: 'ask', body: 'answer' } }; };
  await main(options);
  assert.equal(calls, 1); assert.equal(options.gh.created, 2);
  const root = options.gh.rows.find(d => d.body.startsWith(SUMMARY));
  assert.equal(options.gh.comments.get(root.id)[0].body, [...options.gh.docs.values()][0]);
  await main(options); assert.equal(calls, 1);
  options.gh.rows[0].body = '/ask edited?'; await main(options);
  assert.equal(calls, 2); assert.equal(options.gh.created, 2);
  options.gh.rows.shift(); options.event = {}; await main(options);
  assert.match([...options.gh.docs.values()][0], /没有可总结/);
});
test('normal speech does not receive an ask reply without command; critical errors may be corrected', async () => {
  const options = fixture(); options.event.discussion.body = 'ordinary comment';
  options.gh.rows[0].body = 'ordinary comment';
  options.llm = async () => ({ summary: 'summary', reply: { reason: 'ask', body: 'should not send' } });
  await main(options); assert.equal(options.gh.comments.get('human'), undefined);
  options.gh.rows[0].body = 'major error';
  options.llm = async () => ({ summary: 'summary', reply: { reason: 'critical_error', body: 'correction with evidence' } });
  await main(options); assert.match(options.gh.comments.get('human')[0].body, /correction/);
});
test('current vague ask is explicit, replies in its thread, and edits reuse the same reply', async () => {
  const options = fixture();
  options.gh.comments.set('human', [{ id: 'ask', body: '/ask 回复我', createdAt: '1', author: { login: 'alice' } }]);
  options.event.comment = { node_id: 'ask', body: '/ask 回复我' };
  options.llm = async msg => {
    const input = JSON.parse(msg.at(-1).content);
    assert.equal(input.trigger.body, '/ask 回复我');
    assert.equal(input.trigger.explicit_ask, true);
    return { summary: 'summary', reply: null };
  };
  await main(options);
  assert.equal(options.gh.comments.get('ask').length, 1);
  assert.match(options.gh.comments.get('ask')[0].body, /请告诉我具体/);
  const replyId = options.gh.comments.get('ask')[0].id;
  options.gh.comments.get('human')[0].body = '/ask 新问题';
  options.llm = async msg => {
    assert.equal(JSON.parse(msg.at(-1).content).trigger.body, '/ask 新问题');
    return { summary: 'updated', reply: { reason: 'ask', body: 'answer to new question' } };
  };
  await main(options);
  assert.equal(options.gh.comments.get('ask').length, 1);
  assert.equal(options.gh.comments.get('ask')[0].id, replyId);
});
test('an ask still receives its own answer when a schedule already summarized it', async () => {
  const options = fixture();
  options.gh.comments.set('human', [{ id: 'ask', body: '/ask current question', createdAt: '1', author: { login: 'alice' } }]);
  const original = options.event;
  options.event = {};
  options.llm = async () => ({ summary: 'summary', reply: null });
  await main(options);
  options.event = { ...original, comment: { node_id: 'ask', body: '/ask current question' } };
  options.llm = async () => ({ summary: 'summary', reply: { reason: 'ask', body: 'current answer' } });
  await main(options);
  assert.match(options.gh.comments.get('ask')[0].body, /current answer/);
});
test('trusted context is sorted, introduction is omitted and model cannot write context', async () => {
  const options = fixture();
  options.env.BOT_APP_LOGIN = 'discussion-curator'; options.env.GITHUB_REPOSITORY = 'owner/repo';
  const author = { login: 'discussion-curator', __typename: 'Bot' };
  const row = (id, time, content, role = 'user') => ({ id, createdAt: time, author, body: `${TAG}\n<!-- context-record:v1 -->\n` + JSON.stringify({ repo: 'owner/repo', id, messages: [{ role, content }] }) });
  options.gh.rows.push({ id: 'ctx', number: 2, body: CONTEXT, author });
  options.gh.comments.set('ctx', [row('b', '2', 'second', 'assistant'), row('a', '1', 'first')]);
  options.llm = async msg => {
    assert.deepEqual(msg.slice(2, 4).map(m => m.content), ['first', 'second']);
    assert.ok(!msg.some(m => m.content === CONTEXT));
    return { summary: 'summary', reply: null };
  };
  const old = structuredClone(options.gh.comments.get('ctx'));
  await main(options);
  assert.deepEqual(options.gh.comments.get('ctx').slice(0, 2), old);
  assert.equal(options.gh.comments.get('ctx').length, 3);
  const count = options.gh.created;
  await main(options);
  assert.equal(options.gh.created, count);
});
test('context rejects humans, other apps, foreign repositories and human edits', () => {
  const author = { login: 'discussion-curator', __typename: 'Bot' };
  const body = `${TAG}\n<!-- context-record:v1 -->\n` + JSON.stringify({ repo: 'owner/repo', id: 'event', messages: [{ role: 'user', content: 'untrusted human data remains user' }] });
  const good = { id: '1', createdAt: '1', author, body };
  assert.equal(readContext([good], 'owner/repo', author.login).length, 1);
  for (const row of [{ ...good, author: { login: 'human', __typename: 'User' } }, { ...good, author: { login: 'other', __typename: 'Bot' } }, { ...good, editor: { login: 'human', __typename: 'User' } }]) {
    assert.equal(readContext([row], 'owner/repo', author.login).length, 0);
  }
  assert.equal(readContext([good], 'owner/other-repo', author.login).length, 0);
});
test('failed doc write is retried by editing existing summary instead of duplicating', async () => {
  const options = fixture(); let fail = true;
  const doc = options.gh.doc.bind(options.gh);
  options.gh.doc = async (...args) => { if (fail) throw new Error('temporary'); await doc(...args); };
  options.llm = async () => ({ summary: 'summary', reply: null });
  await assert.rejects(main(options), /temporary/);
  fail = false; await main(options);
  assert.equal(options.gh.created, 2); // one summary and one explicit-ask acknowledgement, both reused
  assert.equal(options.gh.docs.size, 1);
});
test('uneditable pending summary fails before consuming another LLM call', async () => {
  const options = fixture();
  options.gh.rows.push({ id: 'summary', number: 2, body: SUMMARY });
  const { hash } = await import('../src/index.js');
  options.gh.comments.set('summary', [{ id: 'existing', body: `${TAG}\n<!-- category:${hash('general').slice(0, 16)} -->\n<!-- pending:old -->`, viewerCanUpdate: false }]);
  options.llm = async () => { assert.fail('LLM should not be called when editing is forbidden'); };
  await assert.rejects(main(options), /Check its installation/);
});
test('App creates its own roots and ignores old bot roots without modifying them', async () => {
  const options = fixture();
  options.env.BOT_APP_LOGIN = 'discussion-curator';
  options.gh.rows.push({ id: 'old-summary', number: 2, body: SUMMARY, author: { login: 'github-actions', __typename: 'Bot' } });
  options.gh.rows.push({ id: 'old-context', number: 3, body: CONTEXT, author: { login: 'github-actions', __typename: 'Bot' } });
  const create = options.gh.create.bind(options.gh);
  options.gh.create = async (...args) => { const row = await create(...args); row.author = { login: 'discussion-curator', __typename: 'Bot' }; return row; };
  options.llm = async () => ({ summary: 'summary', reply: null });
  await main(options);
  assert.equal(options.gh.rows.length, 5);
  assert.equal(options.gh.comments.has('old-summary'), false);
  assert.equal(options.gh.comments.has('old-context'), false);
  await main(options);
  assert.equal(options.gh.rows.length, 5);
});
test('App generated events stop before reads or model calls', async () => {
  const options = fixture();
  options.event.sender = { login: 'discussion-curator[bot]', type: 'Bot' };
  options.gh.discussions = async () => assert.fail('Must not fetch bot-triggered events');
  options.llm = async () => assert.fail('Must not summarize App events');
  await main(options);
});
test('legacy misplaced answer is replaced once with a reply beneath the source comment', async () => {
  const options = fixture();
  options.gh.comments.set('human', [
    { id: 'ask', body: '/ask 回复我', createdAt: '1', author: { login: 'alice' } },
    { id: 'legacy', body: `${TAG}\n<!-- reply:ask -->\n\nold answer`, createdAt: '2', author: { login: 'app', __typename: 'Bot' } },
  ]);
  options.event.comment = { node_id: 'ask', body: '/ask 回复我' };
  options.llm = async () => ({ summary: 'summary', reply: { reason: 'ask', body: '我在，请告诉我具体想问什么。' } });
  await main(options);
  assert.equal(options.gh.comments.get('human').length, 1);
  assert.equal(options.gh.comments.get('ask').length, 1);
  await main(options);
  assert.equal(options.gh.comments.get('ask').length, 1);
});
