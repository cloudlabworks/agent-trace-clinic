import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const files = new Set(['index.html','app.js','style.css','analyse.js','normalise.js','detectors.js','usage.js','report.js',
'cases/openai-tool-loop.json','cases/anthropic-retry-storm.json','cases/openai-unproven-completion.json','cases/openai-clean.json']);
const types = {html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',json:'application/json'};
export function createPreviewServer() {
  return createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src 'self' about:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Cache-Control','no-store');
    if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405,{Allow:'GET, HEAD'}); return res.end(); }
    const path = req.url.split('?')[0];
    if (path === '/healthz') { res.writeHead(200,{'Content-Type':'text/plain'}); return res.end(req.method === 'HEAD' ? undefined : 'ok'); }
    const name = path === '/' ? 'index.html' : path.slice(1);
    if (!files.has(name)) { res.writeHead(404); return res.end('Not found'); }
    try { const data = await readFile(new URL(name, import.meta.url)); res.writeHead(200,{'Content-Type':types[name.split('.').pop()]}); res.end(req.method === 'HEAD' ? undefined : data); }
    catch { res.writeHead(500); res.end('Asset unavailable'); }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createPreviewServer();
  server.listen(Number(process.env.PORT || 8080), process.env.HOST || '127.0.0.1', () => console.error('Clinic preview listening on port ' + server.address().port));
  for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => server.close());
}
