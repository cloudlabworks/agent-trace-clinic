// Agent Trace Clinic tests: node test.mjs
// Runs every case in cases/ against cases/expected.json, plus unit checks.
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
} from './detectors.js';
import { usage } from './usage.js';

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
const files = readdirSync(casesDir).filter((f) => f !== 'expected.json' && /\.(json|jsonl)$/.test(f)).sort();
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
check('growth: under 2x is quiet', detectContextGrowth(curve([100, 150, 199])).length === 0);
check('growth: exactly 2x is medium', detectContextGrowth(curve([100, 150, 200])).map(key).join() === 'context_growth|medium|0,1,2');
check('growth: 5x is high', detectContextGrowth(curve([100, 300, 500]))[0]?.severity === 'high');
check('growth: a dip (compaction) is not rising', detectContextGrowth(curve([100, 400, 300, 900])).length === 0);
check('growth: two points are not a curve', detectContextGrowth(curve([100, 900])).length === 0);
check('growth: data carries the curve and the multiple', detectContextGrowth(curve([100, 200, 400]))[0].data.multiple === 4);
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
check('unproven: a later tool call clears the claim', detectUnprovenCompletion([S(0, 'message', { text: 'Done.' }), S(1, 'tool_call', { tool: 'check', args: '{}' })]).length === 0);
check('unproven: user text is never a claim', detectUnprovenCompletion([S(0, 'message', { role: 'user', text: 'Done.' })]).length === 0);

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

// ------------------------------------------------------------------ report

for (const f of failures) console.log(`FAIL ${f}`);
console.log(`${caseCount} cases, ${pass + fail} checks: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
