import { analyse } from './analyse.js';
import { renderHtml } from './report.js';
const el = id => document.getElementById(id);
const MAX = 2 * 1024 * 1024;
let current = null;
function clear() { current = null; el('html').disabled = true; el('json').disabled = true; el('report').srcdoc = ''; }
function inspect() {
  clear();
  try {
    if (new Blob([el('trace').value]).size > MAX) throw new Error('Trace exceeds the 2 MiB preview limit.');
    current = analyse(el('trace').value);
    el('report').srcdoc = renderHtml(current);
    el('html').disabled = false; el('json').disabled = false;
    el('status').textContent = current.steps.length + ' steps inspected; ' + current.findings.filter(f => f.severity !== 'info').length + ' findings.';
  } catch (e) { el('status').textContent = e.message; }
}
el('analyse').onclick = inspect;
el('trace').oninput = () => { clear(); el('status').textContent = 'Trace changed. Inspect again to refresh the report.'; };
el('load').onclick = async () => {
  clear(); el('status').textContent = 'Loading example…';
  try {
    const response = await fetch('/cases/' + el('sample').value);
    if (!response.ok) throw new Error('Example unavailable.');
    el('trace').value = await response.text(); inspect();
  } catch (e) { el('status').textContent = e.message; }
};
el('file').onchange = async event => {
  clear(); el('status').textContent = 'Reading trace…';
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > MAX) throw new Error('Trace exceeds the 2 MiB preview limit.');
    el('trace').value = await file.text(); inspect();
  } catch (e) { el('status').textContent = e.message; }
};
function download(kind) {
  if (!current) return;
  const url = URL.createObjectURL(new Blob([kind === 'html' ? renderHtml(current) : JSON.stringify(current, null, 2)], { type: kind === 'html' ? 'text/html' : 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = 'clinic-report.' + kind; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
el('html').onclick = () => download('html'); el('json').onclick = () => download('json');
