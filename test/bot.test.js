import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHub, main, TAG, SUMMARY, CONTEXT, blacklist, excluded, messages, systemPrompt, validateResult, generate, request } from '../src/index.js';

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
  async create(repo, category, title, body) { const row = { id: title, number: this.rows.length + 1, body }; this.rows.push(row); return row; }
  async connection(id) { return structuredClone(this.comments.get(id) ?? []); }
  async comment(discussion, body, existing) {
    if (!this.comments.has(discussion)) this.comments.set(discussion, []);
    if (existing) this.comments.get(discussion).find(c => c.id === existing).body = body;
    else { existing = String(++this.created); this.comments.get(discussion).push({ id: existing, body, createdAt: '0' }); }
    return existing;
  }
  async doc(key, body) { this.docs.set(key, body); }
}
const fixture = () => ({ gh: new FakeGitHub(), env: { LLM_API_KEY: 'test', LLM_MODEL: 'model' },
  prompt: 'system', rules: 'rules', event: { sender: { login: 'alice' }, discussion: { number: 1, node_id: 'human', body: '/ask what?' } } });
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
  options.llm = async () => ({ summary: 'summary', reply: { reason: 'ask', body: 'should not send' } });
  await main(options); assert.equal(options.gh.comments.get('human'), undefined);
  options.gh.rows[0].body = 'major error';
  options.llm = async () => ({ summary: 'summary', reply: { reason: 'critical_error', body: 'correction with evidence' } });
  await main(options); assert.match(options.gh.comments.get('human')[0].body, /correction/);
});
test('trusted context is sorted, introduction is omitted and model cannot write context', async () => {
  const options = fixture();
  options.gh.rows.push({ id: 'ctx', number: 2, body: CONTEXT });
  options.gh.comments.set('ctx', [{ id: 'b', createdAt: '2', body: 'second' }, { id: 'a', createdAt: '1', body: 'first' }]);
  options.llm = async msg => {
    assert.deepEqual(msg.slice(2, 4).map(m => m.content), ['first', 'second']);
    assert.ok(!msg.some(m => m.content === CONTEXT));
    return { summary: 'summary', reply: null };
  };
  const old = structuredClone(options.gh.comments.get('ctx'));
  await main(options);
  assert.deepEqual(options.gh.comments.get('ctx'), old);
});
test('failed doc write is retried by editing existing summary instead of duplicating', async () => {
  const options = fixture(); let fail = true;
  const doc = options.gh.doc.bind(options.gh);
  options.gh.doc = async (...args) => { if (fail) throw new Error('temporary'); await doc(...args); };
  options.llm = async () => ({ summary: 'summary', reply: null });
  await assert.rejects(main(options), /temporary/);
  fail = false; await main(options);
  assert.equal(options.gh.created, 1);
  assert.equal(options.gh.docs.size, 1);
});
test('uneditable pending summary fails before consuming another LLM call', async () => {
  const options = fixture();
  options.gh.rows.push({ id: 'summary', number: 2, body: SUMMARY });
  const { hash } = await import('../src/index.js');
  options.gh.comments.set('summary', [{ id: 'existing', body: `${TAG}\n<!-- category:${hash('general').slice(0, 16)} -->\n<!-- pending:old -->`, viewerCanUpdate: false }]);
  options.llm = async () => { assert.fail('LLM should not be called when editing is forbidden'); };
  await assert.rejects(main(options), /Configure BOT_GITHUB_TOKEN/);
});
