import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { config, createApp } from '../src/server.mjs';
const env = { GIT_URL: 'https://raw.githubusercontent.com/owner/repo/main/folder/file.txt', GIT_TOKEN: 'github_pat_test_only' };
test('raw URLs become fixed-origin API requests without token in URL', () => {
  const c = config(env);
  assert.equal(c.url, 'https://api.github.com/repos/owner/repo/contents/folder/file.txt?ref=main');
  assert.equal(c.token, env.GIT_TOKEN);
  assert.equal(config({ ...env, GIT_URL: env.GIT_URL.replace('/main/', '/refs/heads/main/') }).url, c.url);
  assert.equal(new URL(config({ ...env, GIT_URL: env.GIT_URL.replace('/main/', '/feature%2Ftest/') }).url).searchParams.get('ref'), 'feature/test');
  for (const url of ['http://raw.githubusercontent.com/a/b/main/f', 'https://example.com/a/b/main/f', env.GIT_URL+'?token=secret', env.GIT_URL+'#secret', 'https://user:secret@raw.githubusercontent.com/a/b/main/f', 'https://raw.githubusercontent.com/a/b/main', 'https://raw.githubusercontent.com/a/b/main/a%2Fb', 'https://raw.githubusercontent.com/a/b/main/%00']) {
    assert.throws(() => config({ ...env, GIT_URL: url }), e => !e.message.includes('secret'));
  }
  for (const token of ['', undefined, 'bad\r\nheader', 'a b']) assert.throws(() => config({ ...env, GIT_TOKEN: token }));
});
async function serve(t, fetchImpl, timeoutMs = 15000) {
  const app = createApp(config(env), { fetchImpl, timeoutMs });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  return `http://127.0.0.1:${app.address().port}`;
}
test('each root request fetches fresh bytes; token only in upstream header', async t => {
  let count = 0;
  const url = await serve(t, async (target, options) => {
    assert.equal(target, config(env).url); assert.ok(!target.includes(env.GIT_TOKEN));
    assert.equal(options.headers.Authorization, `Bearer ${env.GIT_TOKEN}`);
    assert.equal(options.headers.Accept, 'application/vnd.github.raw+json');
    assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
    return new Response(Buffer.from([0, 255, ++count]), { headers: { 'X-Secret': env.GIT_TOKEN } });
  });
  for (let i = 1; i <= 2; i++) {
    const res = await fetch(url+'/', { headers: { Authorization: 'untrusted', 'If-None-Match': '*' } });
    assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-secret'), null); assert.equal(res.headers.get('content-disposition'), null);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), Buffer.from([0, 255, i]));
  }
  assert.equal((await fetch(url+'/healthz')).status, 200);
  for (const path of ['/file.txt','/Proxy-List.txt','/?url=https://example.com']) assert.equal((await fetch(url+path)).status, 404);
  assert.equal((await fetch(url+'/', { method: 'POST' })).status, 405);
  assert.equal(count, 2);
});
test('upstream errors and redirects never become successful content or leak credentials', async t => {
  let response = () => new Response('good');
  const url = await serve(t, async () => response());
  assert.equal(await (await fetch(url+'/')).text(), 'good');
  const variants = [401,403,404,429,500,302,304].map(status => () => new Response(null, { status }));
  variants.push(() => new Response('x'.repeat(1024*1024+1)), () => { throw new Error(env.GIT_TOKEN); });
  for (const variant of variants) {
    response = variant; const res = await fetch(url+'/');
    assert.equal(res.status, 502); assert.equal(await res.text(), 'Unable to retrieve the upstream file\n');
  }
});
test('empty file is returned successfully', async t => {
  const url = await serve(t, async () => new Response(''));
  const res = await fetch(url+'/'); assert.equal(res.status,200); assert.equal(await res.text(),'');
});
test('timeout aborts upstream', async t => {
  const url = await serve(t, (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once:true })), 20);
  assert.equal((await fetch(url+'/')).status,502);
});
