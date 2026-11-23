import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentLinks, allowedURL, publicAddress, prepareMedia, decodeAttachment, repositoryAsset, downloadHeaders } from '../src/media.js';
import { readFile } from 'node:fs/promises';
import { messages } from '../src/index.js';

test('extracts Markdown, HTML images, file links and naked GitHub attachments, deduplicated', () => {
  const url = 'https://github.com/user-attachments/assets/example';
  assert.deepEqual(attachmentLinks(`![图](${url})\n<img src="${url}">\n${url}\n[附件](https://github.com/user-attachments/files/1/a.pdf)`), [url, 'https://github.com/user-attachments/files/1/a.pdf']);
  assert.equal(attachmentLinks('```\n![example](https://example.org/x.png)\n```').length, 0);
});
test('rejects local/private addresses, URL credentials, HTTP and unapproved hosts', () => {
  for (const url of ['http://github.com/a.png', 'https://127.0.0.1/x', 'https://user:pass@github.com/x', 'https://unknown.test/x']) assert.throws(() => allowedURL(url));
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1']) assert.equal(publicAddress(address), false);
  assert.equal(publicAddress('8.8.8.8'), true);
});
test('downloads image bytes once and sends an actual image part, not an inaccessible link', async () => {
  const png = Buffer.from([137,80,78,71,13,10,26,10,0]); let calls = 0;
  const items = [{ id: 'd', body: '![图](https://github.com/user-attachments/assets/x)', comments: [{ id: 'c', body: '![图](https://github.com/user-attachments/assets/x)' }] }];
  const result = await prepareMedia(items, {}, async () => { calls++; return { bytes: png, type: 'image/png' }; });
  assert.equal(calls, 1); assert.equal(result.manifest[0].status, 'included');
  assert.ok(result.parts[1].image_url.url.startsWith('data:image/png;base64,'));
  const msg = messages('system', 'rules', [], { discussions: items }, result.parts);
  assert.equal(msg.at(-1).content[1].type, 'text');
  assert.equal(msg.at(-1).content[2].type, 'image_url');
});
test('unread attachments retain explicit errors and never fake contents', async () => {
  const result = await prepareMedia([{ id: 'd', body: '![private](https://github.com/user-attachments/assets/x) [zip](https://github.com/a.zip)' }], {}, async () => { throw new Error('http_404'); });
  assert.equal(result.parts.length, 0); assert.ok(result.manifest.every(x => x.status === 'http_404'));
});
test('PDF uses actual base64 and text extraction is bounded with truncation flag', () => {
  const pdf = Buffer.from('%PDF-1.4\nfixture');
  const result = decodeAttachment(pdf, 'application/pdf', 'https://github.com/a.pdf', { LLM_BASE_URL: 'https://ark.cn-beijing.volces.com/api/v3' });
  assert.equal(result.part.type, 'file'); assert.equal(result.part.file.file_data, pdf.toString('base64'));
  const text = decodeAttachment(Buffer.from('x'.repeat(50000)), 'text/plain', 'https://github.com/notes.txt');
  assert.equal(text.truncated, true); assert.equal(text.part.text.length, 40000);
  assert.throws(() => decodeAttachment(Buffer.from([0,1,2]), 'application/zip', 'https://github.com/archive.zip'), /unsupported/);
});
test('GitHub authorization remains scoped and never follows a signed redirect', () => {
  const env = { GH_TOKEN: 'sensitive', GITHUB_REPOSITORY: 'owner/repo' };
  const asset = 'https://github.com/user-attachments/assets/123';
  assert.equal(downloadHeaders(asset, env).Authorization, 'Bearer sensitive');
  assert.equal(downloadHeaders('https://private-user-images.githubusercontent.com/123?jwt=signature', env, 1, asset).Authorization, undefined);
  const path = repositoryAsset('https://raw.githubusercontent.com/owner/repo/main/image.png', env);
  assert.equal(path, 'https://api.github.com/repos/owner/repo/contents/image.png?ref=main');
  assert.equal(downloadHeaders(path, env).Authorization, 'Bearer sensitive');
  assert.equal(downloadHeaders('https://api.github.com/repos/other/repo/contents/private.png', env).Authorization, undefined);
});
test('extracts real Word fixture text without executing or installing document software', async () => {
  const bytes = await readFile(new URL('./fixtures/document.docx', import.meta.url));
  assert.match(decodeAttachment(bytes, '', 'https://github.com/document.docx').part.text, /MAPLE-913/);
});
