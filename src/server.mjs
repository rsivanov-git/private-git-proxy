import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 1024 * 1024;
export function config(env = process.env) {
  let apiUrl;
  try {
    const url = new URL(env.GIT_URL);
    if (url.protocol !== 'https:' || url.hostname !== 'raw.githubusercontent.com' || url.port || url.username || url.password || url.search || url.hash) throw new Error();
    const parts = url.pathname.slice(1).split('/').map(decodeURIComponent);
    const [owner, repo] = parts;
    if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) throw new Error();
    let rest = parts.slice(2);
    if (rest[0] === 'refs' && ['heads', 'tags'].includes(rest[1])) rest = rest.slice(2);
    const [ref, ...file] = rest;
    if (!ref || !file.length || file.some(x => !x || x === '.' || x === '..' || /[\\/\x00-\x1f]/.test(x)) || /[\x00-\x1f]/.test(ref)) throw new Error();
    apiUrl = new URL(`https://api.github.com/repos/${owner}/${repo}/contents/${file.map(encodeURIComponent).join('/')}`);
    apiUrl.searchParams.set('ref', ref);
  } catch { throw new Error('GIT_URL must be an HTTPS raw.githubusercontent.com/OWNER/REPO/REF/FILE URL without credentials, query or fragment.'); }
  if (env.GIT_TOKEN && !/^[A-Za-z0-9_]+$/.test(env.GIT_TOKEN)) throw new Error('GIT_TOKEN must be a nonempty GitHub access token.');
  return { url: apiUrl.href, token: env.GIT_TOKEN };
}
function requestToken(authorization, fallback) {
  if (authorization === undefined) return fallback;
  const match = /^Basic +([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
  if (!match) return;
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.toString('base64') !== match[1]) return;
  const parts = /^([A-Za-z0-9_]+):([A-Za-z0-9_]+)$/.exec(bytes.toString('latin1'));
  if (parts) return parts[1] + parts[2];
}
export function createApp(settings, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(body);
    };
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); reply(405, 'Method not allowed\n'); return; }
    if (req.url === '/healthz') { reply(200, 'ok\n'); return; }
    if (req.url !== '/') { reply(404, 'Not found\n'); return; }
    const token = requestToken(req.headers.authorization, settings.token);
    if (!token) {
      res.setHeader('WWW-Authenticate', 'Basic realm="proxy-list"');
      reply(401, 'GitHub credentials required\n');
      return;
    }
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnect);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    try {
      const upstream = await fetchImpl(settings.url, {
        redirect: 'error', cache: 'no-store', signal,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'private-git-proxy', 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' },
      });
      if (upstream.status !== 200 || !upstream.body) throw new Error('Upstream failure');
      const chunks = []; let size = 0;
      for await (const chunk of upstream.body) {
        size += chunk.length;
        if (size > MAX_BYTES) throw new Error('Upstream too large');
        chunks.push(chunk);
      }
      const plain = Buffer.concat(chunks);
      if (!res.destroyed) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': plain.length });
        res.end(plain);
      }
    } catch {
      controller.abort();
      if (!res.destroyed) reply(502, 'Unable to retrieve the upstream file\n');
    } finally { res.off('close', disconnect); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const server = createApp(config());
    server.listen(8080, '0.0.0.0', () => console.log('private-git-proxy listening on port 8080'));
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
