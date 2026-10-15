import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { analyse } from './analyse.js';
import { renderHtml } from './report.js';
import { createPreviewServer } from './server.mjs';
test('HTML report escapes trace text and links actual evidence steps', () => {
  const report = analyse(readFileSync(new URL('cases/openai-unproven-completion.json', import.meta.url),'utf8'));
  report.steps[0].text = '<img src=x onerror="alert(1)"> & </pre><script>bad()</script>';
  const html = renderHtml(report);
  assert(!html.includes('<script>')); assert(!html.includes('<img')); assert(html.includes('&lt;img'));
  for (const finding of report.findings) for (const i of finding.steps) assert(html.includes('id="step-' + i + '"'));
  assert(html.includes("default-src 'none'"));
});
test('clean trace has no problem findings; unknown usage remains unknown', () => {
  const report = analyse('[{"role":"user","content":"Hello"},{"role":"assistant","content":"Hello"}]');
  assert.equal(report.findings.length, 0);
  assert(renderHtml(report).includes('UNKNOWN: token usage'));
});
test('CLI HTML and JSON exports and invalid-input exit codes', () => {
  const run = args => spawnSync(process.execPath,['cli.mjs',...args],{cwd:new URL('.',import.meta.url),encoding:'utf8'});
  const html = run(['cases/openai-tool-loop.json','--html']); assert.equal(html.status,0); assert(html.stdout.startsWith('<!doctype html>'));
  assert.equal(JSON.parse(run(['cases/openai-clean.json','--json']).stdout).format,'openai');
  assert.equal(run(['cases/unknown-format.json','--html']).status,2);
  assert.equal(run(['cases/openai-clean.json','--html','--json']).status,2);
});
test('preview serves allowlisted assets only, rejects writes, supports health and HEAD', async () => {
  const server = createPreviewServer();
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const root = await fetch(base); assert.equal(root.status,200); assert((await root.text()).includes('Find the failure'));
    assert((root.headers.get('content-security-policy')).includes("script-src 'self'"));
    for (const path of ['/app.js','/analyse.js','/report.js','/style.css','/cases/openai-clean.json']) assert.equal((await fetch(base+path)).status,200);
    for (const path of ['/.git/config','/bakeoff/results/x.json','/package.json','/%2e%2e/package.json']) assert.equal((await fetch(base+path)).status,404);
    assert.equal((await fetch(base,{method:'POST',body:'trace'})).status,405);
    assert.equal(await (await fetch(base+'/healthz')).text(),'ok');
    assert.equal(await (await fetch(base,{method:'HEAD'})).text(),'');
  } finally { await new Promise(r => server.close(r)); }
});
