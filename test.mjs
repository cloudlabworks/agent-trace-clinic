// Agent Trace Clinic tests: node test.mjs
// Runs every case in cases/ against cases/expected.json, plus unit checks, plus the
// model-pass parser against fixtures/labeller-parser.json (no model is loaded).
// Prints pass/fail counts and exits non-zero on any failure.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalise, canonicalJSON, canonicalArgs, openaiToolError, TraceFormatError } from './normalise.js';
import {
  runDetectors,
  detectToolLoops,
  detectRetryStorms,
  detectContextGrowth,
  detectUnhandledErrors,
  detectUnprovenCompletion,
  findClaim,
  isCheckCall,
  RULES,
} from './detectors.js';
import { usage } from './usage.js';
import { MAST_MODES, buildMessages, parseLabels, toFindings, loadLabeller, stepLine } from './labeller.js';

const here = dirname(fileURLToPath(import.meta.url));
const casesDir = join(here, 'cases');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) pass++;
  else {
    fail++;
    failures.push(`${name}${detail ? `: ${detail}` : ''}`);
  }
}

function throwsFormat(name, input, contains) {
  try {
    normalise(input);
    check(name, false, 'expected a TraceFormatError, got none');
  } catch (e) {
    check(name, e instanceof TraceFormatError && e.message.includes(contains), e.message);
  }
}

const key = (f) => `${f.id}|${f.severity}|${f.steps.join(',')}`;

// ------------------------------------------------------------------ cases

const expected = JSON.parse(readFileSync(join(casesDir, 'expected.json'), 'utf8'));
const files = readdirSync(casesDir).filter((f) => f !== 'expected.json' && f !== 'mast-expected.json' && /\.(json|jsonl)$/.test(f)).sort();
check('every case file has an expected entry', files.every((f) => f in expected), files.filter((f) => !(f in expected)).join(', '));
check('every expected entry has a case file', Object.keys(expected).filter((k) => !k.startsWith('_')).every((k) => files.includes(k)));

let caseCount = 0;
for (const file of files) {
  const exp = expected[file];
  if (!exp) continue;
  caseCount++;
  const text = readFileSync(join(casesDir, file), 'utf8');
  if (exp.error) {
    throwsFormat(`case ${file} rejects`, text, exp.error);
    continue;
  }
  let result;
  try {
    result = normalise(text);
  } catch (e) {
    check(`case ${file} parses`, false, e.message);
    continue;
  }
  check(`case ${file} format`, result.format === exp.format, `got ${result.format}`);
  check(`case ${file} container`, result.container === exp.container, `got ${result.container}`);
  check(`case ${file} step count`, result.steps.length === exp.step_count, `got ${result.steps.length}`);
  const got = runDetectors(result.steps);
  const gotKeys = got.map(key).sort();
  const expKeys = exp.findings.map(key).sort();
  check(`case ${file} findings`, JSON.stringify(gotKeys) === JSON.stringify(expKeys), `expected ${JSON.stringify(expKeys)} got ${JSON.stringify(gotKeys)}`);
  for (const ef of exp.findings) {
    const f = got.find((g) => key(g) === key(ef));
    if (f && ef.evidence_contains) {
      check(`case ${file} ${ef.id} evidence`, f.evidence.includes(ef.evidence_contains), `evidence was "${f.evidence}"`);
    }
  }
  for (const f of got) {
    check(`case ${file} ${f.id} has explain`, typeof f.explain === 'string' && f.explain.length > 20);
    check(`case ${file} ${f.id} evidence is short`, f.evidence.length <= 80, f.evidence);
  }
}

// ------------------------------------------------------------------ unit: canonical JSON

check('canonicalJSON sorts keys recursively', canonicalJSON({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } }) === '{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}');
check('canonicalArgs parses a JSON string', canonicalArgs('{ "b": 2, "a": 1 }') === '{"a":1,"b":2}');
check('canonicalArgs equal for reordered keys', canonicalArgs('{"x":1,"y":[2,3]}') === canonicalArgs({ y: [2, 3], x: 1 }));
check('canonicalArgs keeps an unparseable string as a JSON string', canonicalArgs('not json') === '"not json"');
check('canonicalArgs of empty string is {}', canonicalArgs('') === '{}');
check('canonicalArgs of null is null', canonicalArgs(null) === null);

// ------------------------------------------------------------------ unit: normaliser

{
  const r = normalise([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'Looking.', tool_calls: [{ id: 'a', type: 'function', function: { name: 'f', arguments: '{"k":1}' } }, { id: 'b', type: 'function', function: { name: 'g', arguments: '{}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    { role: 'tool', tool_call_id: 'b', content: 'Traceback (most recent call last): boom' },
    { role: 'tool', tool_call_id: 'a', content: 'fine' },
  ]);
  const s = r.steps;
  check('openai: one text step then N tool_call steps', s.map((x) => x.kind).join() === 'message,message,tool_call,tool_call,tool_result,tool_result');
  check('openai: tokens on the first step of the message only', s[1].tokens_in === 10 && s[1].tokens_out === 5 && s[2].tokens_in === null && s[3].tokens_in === null);
  check('openai: result tool name mapped by tool_call_id', s[4].tool === 'g' && s[5].tool === 'f' && s[5].args === '{"k":1}');
  check('openai: Traceback result is an error', s[4].error === true && s[5].error === false);
  check('openai: indices are 0..n-1', s.every((x, n) => x.i === n));
  check('openai: missing tokens are null, not 0', s[0].tokens_in === null && s[0].tokens_out === null);
}
check('openai error rule: is_error flag', openaiToolError({ is_error: true }, 'ok') === true);
check('openai error rule: JSON error key', openaiToolError({}, '{"error": {"code": 500}}') === true);
check('openai error rule: JSON error null is fine', openaiToolError({}, '{"error": null}') === false);
check('openai error rule: "error" mid-text is not an error', openaiToolError({}, 'no error found') === false);
check('openai error rule: leading Error', openaiToolError({}, '  error: boom') === true);
{
  const r = normalise({
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', id: 't', name: 'x', input: { b: 1, a: 2 } }], usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 25, output_tokens: 7 } },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: [{ type: 'text', text: 'nope' }] }, { type: 'text', text: 'and also' }] },
    ],
  });
  const s = r.steps;
  check('anthropic: format', r.format === 'anthropic');
  check('anthropic: thinking ignored, tool_use is first step of turn and carries tokens', s[1].kind === 'tool_call' && s[1].tokens_in === 175 && s[1].tokens_out === 7);
  check('anthropic: args canonical', s[1].args === '{"a":2,"b":1}');
  check('anthropic: tool_result is_error, name mapped, text from blocks', s[2].kind === 'tool_result' && s[2].error && s[2].tool === 'x' && s[2].text === 'nope');
  check('anthropic: trailing user text after result is a message', s[3].kind === 'message' && s[3].role === 'user' && s[3].text === 'and also');
}
{
  const r = normalise({
    resourceSpans: [{ scopeSpans: [{ spans: [
      { name: 'execute_tool t', startTimeUnixNano: '1791590400000000002', status: { code: 'STATUS_CODE_ERROR' }, attributes: [{ key: 'gen_ai.operation.name', value: { stringValue: 'execute_tool' } }, { key: 'gen_ai.tool.name', value: { stringValue: 't' } }] },
      { name: 'chat m', startTimeUnixNano: '1791590400000000001', attributes: [{ key: 'gen_ai.operation.name', value: { stringValue: 'chat' } }, { key: 'gen_ai.usage.input_tokens', value: { intValue: '9007199254740993' } }] },
    ] }] }],
  });
  check('otel: spans sorted by start time (BigInt-safe)', r.steps[0].kind === 'message' && r.steps[1].kind === 'tool_call');
  check('otel: STATUS_CODE_ERROR marks the result as an error', r.steps[2].error === true);
  check('otel: intValue strings become numbers', typeof r.steps[0].tokens_in === 'number');
  check('otel: execute_tool without arguments has args null', r.steps[1].args === null);
}
check('a single message on its own is a one-step trace', normalise('{"role": "user", "content": "hi"}').steps.length === 1);
throwsFormat('rejects empty input', '   ', 'empty');
throwsFormat('rejects an empty list', '[]', 'empty list');
throwsFormat('rejects a bare string', '"hello"', 'Unrecognised trace format');
throwsFormat('rejects legacy function_call', [{ role: 'assistant', function_call: { name: 'x', arguments: '{}' } }], 'function_call');
throwsFormat('rejects unknown roles', [{ role: 'robot', content: 'x' }], 'unknown role');
throwsFormat('rejects unknown Anthropic block types', [{ role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'x', input: {} }, { type: 'hologram' }] }], 'hologram');
throwsFormat('rejects spans with no gen_ai attributes', [{ name: 'GET', attributes: { 'http.method': 'GET' } }], 'gen_ai.operation.name');
throwsFormat('rejects a list mixing messages and spans', [{ role: 'user', content: 'x' }, { name: 'chat', attributes: {} }], 'mixes');

// ------------------------------------------------------------------ unit: detectors

const S = (i, kind, extra = {}) => ({ i, role: kind === 'tool_result' ? 'tool' : 'assistant', kind, tool: null, args: null, text: '', tokens_in: null, tokens_out: null, error: false, ...extra });

check('loop: two identical calls is not a loop', detectToolLoops([S(0, 'tool_call', { tool: 'a', args: '{}' }), S(1, 'tool_call', { tool: 'a', args: '{}' })]).length === 0);
check('loop: three identical calls, not adjacent, is a loop', detectToolLoops([S(0, 'tool_call', { tool: 'a', args: '{}' }), S(1, 'tool_call', { tool: 'b', args: '{}' }), S(2, 'tool_call', { tool: 'a', args: '{}' }), S(3, 'tool_call', { tool: 'a', args: '{}' })]).map(key).join() === 'tool_loop|high|0,2,3');
check('loop: same tool, different args, no loop', detectToolLoops([0, 1, 2].map((i) => S(i, 'tool_call', { tool: 'a', args: `{"n":${i}}` }))).length === 0);
check('retry: two errors is not a storm', detectRetryStorms([S(0, 'tool_result', { tool: 'a', error: true }), S(1, 'tool_result', { tool: 'a', error: true })]).length === 0);
check('retry: three errors on one tool, any args', detectRetryStorms([0, 1, 2].map((i) => S(i, 'tool_result', { tool: 'a', args: `{"n":${i}}`, error: true }))).map(key).join() === 'retry_storm|high|0,1,2');
check('retry: errors split across tools do not add up', detectRetryStorms([S(0, 'tool_result', { tool: 'a', error: true }), S(1, 'tool_result', { tool: 'b', error: true }), S(2, 'tool_result', { tool: 'a', error: true })]).length === 0);
const curve = (xs) => xs.map((t, i) => S(i, 'message', { tokens_in: t }));
check('growth: under 2x is quiet, however steep', detectContextGrowth(curve([1000, 1500, 1999])).length === 0);
check('growth: exactly 2x at exactly 300 per call is medium', detectContextGrowth(curve([600, 900, 1200])).map(key).join() === 'context_growth|medium|0,1,2');
check('growth: 2x but under 300 per call is quiet', detectContextGrowth(curve([500, 749, 999])).length === 0);
check('growth: 5x is high', detectContextGrowth(curve([1000, 3000, 5000]))[0]?.severity === 'high');
check('growth: a dip (compaction) is not rising', detectContextGrowth(curve([1000, 4000, 3000, 9000])).length === 0);
check('growth: two points are not a curve', detectContextGrowth(curve([1000, 9000])).length === 0);
check('growth: data carries the curve, the multiple and the per-call growth', (() => {
  const d = detectContextGrowth(curve([1000, 2000, 4000]))[0].data;
  return d.multiple === 4 && d.per_call === 1500 && d.curve.length === 3;
})());
check('growth: thresholds are 2x and 300 per call', RULES.growthMultiple === 2 && RULES.growthMinPerCall === 300 && RULES.growthMinPoints === 3);
// The patient's clean docs-answer curve (stub estimates), and the same curve with
// its 1,100-token system prompt taken out: a small first call. The old 2x rule
// fired on the second; growth per call is the same, so the new rule does not.
check('growth: patient clean curve is quiet', detectContextGrowth(curve([1222, 1333, 1498, 1665, 1779, 1935])).length === 0);
check('growth: same curve with a small first call is quiet', detectContextGrowth(curve([122, 233, 398, 565, 679, 835])).length === 0);
check('growth: patient context_growth curve fires', detectContextGrowth(curve([1220, 1332, 3431, 3531, 3674])).length === 1);
check('unhandled: error on the last step is unhandled', detectUnhandledErrors([S(0, 'tool_call', { tool: 'a', args: '{}' }), S(1, 'tool_result', { tool: 'a', args: '{}', error: true })]).map(key).join() === 'unhandled_tool_error|medium|1');
check('unhandled: changed args after an error is handled', detectUnhandledErrors([S(0, 'tool_result', { tool: 'a', args: '{}', error: true }), S(1, 'tool_call', { tool: 'a', args: '{"x":1}' })]).length === 0);
check('unhandled: a message after the error, then nothing, is not flagged', detectUnhandledErrors([S(0, 'tool_result', { tool: 'a', args: '{}', error: true }), S(1, 'message', { text: 'It failed.' })]).length === 0);
check('claim: "Fixed." is a claim', findClaim('Fixed.') === 'Fixed.');
check('claim: negated is not a claim', findClaim('This is not fixed yet.') === null);
check('claim: contraction negation', findClaim("I haven't deployed it.") === null);
check('claim: future is not a claim', findClaim('I will get it done today.') === null);
check('claim: question is not a claim', findClaim('Is the deploy done?') === null);
check('claim: second sentence found', findClaim('Looked at it. Deployed to staging.') === 'Deployed to staging.');
check('claim: "pushed to main and deployed" is a claim', findClaim('Pushed to main and deployed.') === 'Pushed to main and deployed.');
check('unproven: a later check clears the claim', detectUnprovenCompletion([S(0, 'message', { text: 'Done.' }), S(1, 'tool_call', { tool: 'check', args: '{}' })]).length === 0);
check('unproven: user text is never a claim', detectUnprovenCompletion([S(0, 'message', { role: 'user', text: 'Done.' })]).length === 0);
{
  const change = (i, extra = {}) => S(i, 'tool_call', { tool: 'update_config', args: '{}', ...extra });
  const changeOk = (i) => S(i, 'tool_result', { tool: 'update_config', args: '{}', text: 'ok' });
  const read = (i) => S(i, 'tool_call', { tool: 'get_config', args: '{}' });
  const readRes = (i, error = false) => S(i, 'tool_result', { tool: 'get_config', args: '{}', error });
  const done = (i) => S(i, 'message', { text: 'Done.' });
  const flagged = (steps) => detectUnprovenCompletion(steps).map((f) => f.steps.join()).join('|');
  check('unproven: change, check, claim is proven', flagged([change(0), changeOk(1), read(2), readRes(3), done(4)]) === '');
  check('unproven: change, claim, check is proven', flagged([change(0), changeOk(1), done(2), read(3), readRes(4)]) === '');
  check('unproven: change, claim and nothing else is flagged', flagged([change(0), changeOk(1), done(2)]) === '2');
  check("unproven: the change's own ok result is not a receipt", flagged([read(0), readRes(1), change(2), changeOk(3), done(4)]) === '4');
  check('unproven: a check before the last change does not count', flagged([change(0), changeOk(1), read(2), readRes(3), change(4), changeOk(5), done(6)]) === '6');
  check('unproven: a later change is not a receipt', flagged([change(0), changeOk(1), done(2), change(3), changeOk(4)]) === '2');
  check('unproven: a failed change still needs a check', flagged([change(0), S(1, 'tool_result', { tool: 'update_config', args: '{}', error: true }), done(2)]) === '2');
  check('unproven: a check that errors proves nothing', flagged([change(0), changeOk(1), read(2), readRes(3, true), done(4)]) === '4');
  check('unproven: no tools at all is flagged', flagged([done(0)]) === '0');
  check('unproven: only checks, no change, is proven', flagged([read(0), readRes(1), done(2)]) === '');
  check('unproven: an unknown tool name counts as a change', flagged([S(0, 'tool_call', { tool: 'run_migration', args: '{}' }), done(1)]) === '1');
}
{
  const c = (tool, args = '{}') => isCheckCall({ tool, args });
  check('check words: get_ticket, readFile, run_tests, http_get, index_status are checks', ['get_ticket', 'readFile', 'run_tests', 'http_get', 'index_status'].every((t) => c(t)));
  check('change words win: update_status, set_check, http_post are changes', !c('update_status') && !c('set_check') && !c('http_post'));
  check('unknown names are changes: run_migration, rotate_api_key, drop_table', !c('run_migration') && !c('rotate_api_key') && !c('drop_table'));
  check('shell: git status, pytest -q, curl GET, cat | grep are checks', ['git status', 'pytest -q', 'curl -s https://x.test/healthz', 'cat a.txt | grep x', 'npm run test'].every((cmd) => c('bash', JSON.stringify({ command: cmd }))));
  check('shell: writes, POST, rm and mixed chains are changes', ['echo x > a.txt', 'curl -X POST https://x.test', 'rm -rf build', 'git status && git push', 'sed -i s/a/b/ f'].every((cmd) => !c('run_command', JSON.stringify({ command: cmd }))));
  check('shell: a shell tool without a command string is a change', !c('bash', '{}'));
}

// ------------------------------------------------------------------ unit: usage

{
  const steps = [S(0, 'message', { tokens_in: 1000, tokens_out: 200 }), S(1, 'message', { tokens_in: 3000, tokens_out: 800 })];
  const u = usage(steps);
  check('usage: per task totals', u.per_task.tokens_in === 4000 && u.per_task.tokens_out === 1000 && u.per_task.total === 5000);
  check('usage: per day at 10 and 1,000 tasks', u.per_day.map((d) => `${d.tasks}:${d.total}`).join() === '10:50000,1000:5000000');
  check('usage: no price, no cost anywhere', u.price === null && u.cost_per_task === null && u.per_day.every((d) => !('cost' in d)));
  const p = usage(steps, { price: { per_million_in: 2, per_million_out: 10 } });
  // 4000/1e6*2 + 1000/1e6*10 = 0.008 + 0.01 = 0.018 per task
  check('usage: split price per task', Math.abs(p.cost_per_task - 0.018) < 1e-12);
  check('usage: split price per day', Math.abs(p.per_day[0].cost - 0.18) < 1e-12 && Math.abs(p.per_day[1].cost - 18) < 1e-9);
  const one = usage(steps, { price: { per_million: 4 } });
  check('usage: single price for all tokens', Math.abs(one.cost_per_task - 0.02) < 1e-12);
  check('usage: custom tasks per day', usage(steps, { tasksPerDay: [3] }).per_day[0].total === 15000);
  let threw = false;
  try {
    usage(steps, { price: { per_million_in: -1, per_million_out: 1 } });
  } catch (e) {
    threw = e instanceof RangeError;
  }
  check('usage: negative price rejected', threw);
  threw = false;
  try {
    usage(steps, { price: { per_million_in: 1 } });
  } catch (e) {
    threw = e instanceof RangeError;
  }
  check('usage: half a split price rejected', threw);
  check('usage: incomplete counts are flagged', usage([S(0, 'message', { tokens_in: 5 })]).per_task.complete === false);
}

// ------------------------------------------------------------------ model pass (no model)

{
  const fx = JSON.parse(readFileSync(join(here, 'fixtures', 'labeller-parser.json'), 'utf8'));
  for (const f of fx.fixtures) {
    const r = parseLabels(f.raw, fx.steps);
    const got = r.labels.map((l) => [l.mode, l.step]);
    check(`parser: ${f.name}: status`, r.status === f.status, `${r.status} (${r.reason})`);
    check(`parser: ${f.name}: labels`, JSON.stringify(got) === JSON.stringify(f.labels), JSON.stringify(got));
    check(`parser: ${f.name}: dropped`, r.dropped.length === f.dropped, `${r.dropped.length}: ${r.dropped.map((d) => d.why).join('; ')}`);
    if ('reason' in f) check(`parser: ${f.name}: reason`, r.reason === f.reason, String(r.reason));
    if ('step_given' in f) check(`parser: ${f.name}: step_given`, r.labels[0]?.step_given === f.step_given);
    if (r.status !== 'ok') check(`parser: ${f.name}: no opinion has no labels`, r.labels.length === 0);
  }
  check('parser: null input', parseLabels(null, fx.steps).status === 'no_model_opinion');

  const ids = MAST_MODES.map((m) => m.id);
  check('MAST: 14 modes', ids.length === 14 && new Set(ids).size === 14);
  check('MAST: ids FM-1.1..1.5, 2.1..2.6, 3.1..3.3', ids.join(',') === 'FM-1.1,FM-1.2,FM-1.3,FM-1.4,FM-1.5,FM-2.1,FM-2.2,FM-2.3,FM-2.4,FM-2.5,FM-2.6,FM-3.1,FM-3.2,FM-3.3');

  const { steps } = normalise(readFileSync(join(casesDir, 'anthropic-false-done-after-error.json'), 'utf8'));
  const msgs = buildMessages(steps);
  const all = msgs.map((m) => m.content).join('\n');
  check('prompt: every mode id and definition is in the prompt', MAST_MODES.every((m) => all.includes(`${m.id} ${m.name}: ${m.definition}`)));
  check('prompt: every step line is in the prompt', steps.every((st) => all.includes(`#${st.i} ${stepLine(st)}`)));
  check('prompt: detector findings are not in the prompt', !/unproven_completion|tool_loop|retry_storm|receipt/.test(all));
  check('prompt: /no_think only when thinking is off', msgs[0].content.endsWith('/no_think') && !buildMessages(steps, { thinking: true })[0].content.includes('/no_think'));
  check('prompt: deterministic', JSON.stringify(buildMessages(steps)) === JSON.stringify(msgs));

  const ok = parseLabels('[{"mode": "FM-3.2", "step": 3, "quote": "Done"}]', steps);
  const fnd = toFindings(ok);
  check('findings: model opinion is marked as such', fnd.length === 1 && fnd[0].source === 'model_opinion' && fnd[0].id === 'mast:FM-3.2' && fnd[0].severity === 'opinion' && /Model opinion/.test(fnd[0].explain));
  check('findings: no model opinion gives no findings', toFindings(parseLabels('nonsense', steps)).length === 0);
  check('findings: detectors never emit model opinions', runDetectors(steps).every((d) => !d.id.startsWith('mast:') && d.source !== 'model_opinion'));

  let msg = '';
  try {
    await loadLabeller();
  } catch (e) {
    msg = e.message;
  }
  check('loadLabeller: under Node it asks for the transformers module', msg.includes('pass { transformers }'), msg);
}

// ------------------------------------------------------------------ report

for (const f of failures) console.log(`FAIL ${f}`);
console.log(`${caseCount} cases, ${pass + fail} checks: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
