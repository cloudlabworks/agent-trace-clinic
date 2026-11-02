// Property-based tests (fast-check): node --test test/property.test.js
// Generates arbitrary and trace-shaped inputs and checks invariants of the
// normaliser and the full analyse() pipeline that the case files cannot cover.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { normalise, canonicalJSON, canonicalArgs, TraceFormatError } from '../normalise.js';
import { analyse } from '../analyse.js';

// ------------------------------------------------------------------ generators

// Any JSON value, with keys that commonly break hand-written object code.
const awkwardKey = fc.oneof(fc.string(), fc.constantFrom('__proto__', 'constructor', 'toString', 'hasOwnProperty'));
const json = fc.letrec((tie) => ({
  value: fc.oneof({ depthSize: 'small' },
    fc.constant(null), fc.boolean(), fc.integer(), fc.double({ noNaN: true, noDefaultInfinity: true }), fc.string(),
    fc.array(tie('value'), { maxLength: 4 }),
    fc.dictionary(awkwardKey, tie('value'), { maxKeys: 4 })),
})).value;

// Either a well-formed value or anything at all, so generated traces reach the
// deep branches of the parser and also hit every "wrong type here" case.
const or = (arb) => fc.oneof(arb, json);
const text = fc.oneof(fc.string(), fc.constantFrom('Error: denied', 'Traceback (most recent call last)', '{"error":"x"}', ''));
const usage = fc.record({ prompt_tokens: or(fc.nat()), completion_tokens: or(fc.nat()), input_tokens: or(fc.nat()),
  output_tokens: or(fc.nat()), cache_read_input_tokens: or(fc.nat()) }, { requiredKeys: [] });

const openaiMessage = fc.record({
  role: fc.constantFrom('system', 'developer', 'user', 'assistant', 'tool'),
  content: or(fc.oneof(text, fc.constant(null), fc.array(fc.record({ type: fc.constantFrom('text', 'refusal'), text: or(text), refusal: or(text) }, { requiredKeys: ['type'] })))),
  tool_calls: or(fc.array(or(fc.record({ id: or(fc.constantFrom('a', 'b')), type: fc.constant('function'),
    function: or(fc.record({ name: or(fc.constantFrom('read_file', 'run_tests')), arguments: or(fc.oneof(text, json.map((v) => JSON.stringify(v)))) })) })), { maxLength: 3 })),
  tool_call_id: or(fc.constantFrom('a', 'b')),
  is_error: json,
  usage: or(usage),
}, { requiredKeys: ['role'] });

const anthropicBlock = fc.oneof(
  fc.record({ type: fc.constant('text'), text: or(text) }, { requiredKeys: ['type'] }),
  fc.record({ type: fc.constant('tool_use'), id: or(fc.constantFrom('a', 'b')), name: or(fc.constantFrom('bash', 'edit')), input: json }, { requiredKeys: ['type'] }),
  fc.record({ type: fc.constant('tool_result'), tool_use_id: or(fc.constantFrom('a', 'b')), content: or(fc.oneof(text, fc.array(fc.record({ type: fc.constant('text'), text: or(text) })))), is_error: json }, { requiredKeys: ['type'] }),
  fc.record({ type: fc.constantFrom('thinking', 'image') }),
  json,
);
const anthropicMessage = fc.record({
  role: fc.constantFrom('user', 'assistant'),
  content: or(fc.oneof(text, fc.array(anthropicBlock, { maxLength: 4 }))),
  usage: or(usage),
}, { requiredKeys: ['role', 'content'] });

const otlpAnyValue = fc.letrec((tie) => ({
  v: fc.oneof({ depthSize: 'small' },
    fc.record({ stringValue: or(text) }), fc.record({ intValue: or(fc.nat().map(String)) }), fc.record({ boolValue: json }),
    fc.record({ arrayValue: or(fc.record({ values: or(fc.array(tie('v'), { maxLength: 3 })) }, { requiredKeys: [] })) }),
    fc.record({ kvlistValue: or(fc.record({ values: or(fc.array(or(fc.record({ key: awkwardKey, value: tie('v') })), { maxLength: 3 })) }, { requiredKeys: [] })) }),
    json),
})).v;
const genaiKey = fc.constantFrom('gen_ai.operation.name', 'gen_ai.tool.name', 'gen_ai.tool.call.arguments', 'gen_ai.tool.call.result',
  'gen_ai.output.messages', 'gen_ai.system_instructions', 'gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens', 'error.type');
const genaiValue = fc.oneof(fc.constantFrom('chat', 'execute_tool', 'invoke_agent', 'bash'), text,
  json.map((v) => JSON.stringify(v)), fc.constant('[{"parts":[{"type":"text","content":"done"},{"type":"tool_call","name":"bash","arguments":"{}"}]}]'));
const span = fc.record({
  name: or(fc.string()),
  startTimeUnixNano: or(fc.oneof(fc.bigInt({ min: 0n, max: 2n ** 63n }).map(String), fc.nat())),
  status: or(fc.record({ code: or(fc.constantFrom(0, 1, 2, 'STATUS_CODE_ERROR')), message: or(text) }, { requiredKeys: [] })),
  attributes: fc.oneof(
    fc.array(or(fc.record({ key: fc.oneof(genaiKey, awkwardKey), value: fc.oneof(genaiValue.map((s) => ({ stringValue: s })), otlpAnyValue) })), { maxLength: 6 }),
    fc.dictionary(fc.oneof(genaiKey, awkwardKey), fc.oneof(genaiValue, json), { maxKeys: 6 }),
    json),
}, { requiredKeys: ['attributes'] });
// A span that names a GenAI operation, so most of these reach the step builder.
const genaiSpan = fc.tuple(span, fc.constantFrom('chat', 'execute_tool', 'invoke_agent'), fc.dictionary(genaiKey, fc.oneof(genaiValue, json), { maxKeys: 6 }))
  .map(([s, op, attrs]) => ({ ...s, attributes: { ...attrs, 'gen_ai.operation.name': op } }));
const anySpan = fc.oneof(genaiSpan, span);
const otlpDocument = fc.record({
  resourceSpans: fc.array(or(fc.record({ scopeSpans: or(fc.array(or(fc.record({ spans: or(fc.array(anySpan, { maxLength: 4 })) })), { maxLength: 2 })) })), { minLength: 1, maxLength: 2 }),
});

const traceValue = fc.oneof(
  fc.array(openaiMessage, { minLength: 1, maxLength: 6 }),
  fc.array(anthropicMessage, { minLength: 1, maxLength: 6 }),
  fc.record({ system: or(text), messages: fc.array(anthropicMessage, { minLength: 1, maxLength: 4 }) }),
  fc.array(anySpan, { minLength: 1, maxLength: 5 }),
  fc.array(genaiSpan, { minLength: 1, maxLength: 5 }),
  otlpDocument,
  json,
);
const traceText = fc.oneof(
  fc.string(),
  traceValue.map((v) => JSON.stringify(v)),
  traceValue.map((v) => (Array.isArray(v) ? v.map((x) => JSON.stringify(x)).join('\n') : JSON.stringify(v))),
);

// ------------------------------------------------------------------ helpers

// Result of fn(), or the error it threw, so two runs can be compared.
function outcome(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return { ok: false, error: e };
  }
}

function assertTraceShape(r) {
  assert(['openai', 'anthropic', 'chat-text', 'otel-genai'].includes(r.format), r.format);
  assert(['json', 'jsonl'].includes(r.container));
  assert(r.steps.length > 0);
  r.steps.forEach((s, i) => {
    assert.equal(s.i, i);
    assert(['message', 'tool_call', 'tool_result'].includes(s.kind));
    assert.equal(typeof s.role, 'string');
    assert.equal(typeof s.text, 'string', `step ${i} text is ${typeof s.text}`);
    assert.equal(typeof s.error, 'boolean');
    assert(s.tool === null || typeof s.tool === 'string');
    if (s.args !== null) JSON.parse(s.args);
    for (const t of [s.tokens_in, s.tokens_out]) assert(t === null || Number.isFinite(t), `tokens ${t}`);
  });
  for (const ins of r.instructions) {
    assert(Number.isInteger(ins.step) && ins.step >= 0 && ins.step < r.steps.length);
    assert.equal(typeof ins.text, 'string');
  }
}

// ------------------------------------------------------------------ properties

test('normalise never crashes: any text gives a valid trace or a TraceFormatError', () => {
  fc.assert(fc.property(traceText, (input) => {
    const r = outcome(() => normalise(input));
    if (r.ok) assertTraceShape(r.value);
    else assert(r.error instanceof TraceFormatError, `${r.error?.name}: ${r.error?.message}`);
  }), { numRuns: 2000 });
});

test('analyse never crashes: findings and usage are computed for every accepted trace', () => {
  fc.assert(fc.property(traceText, (input) => {
    const r = outcome(() => analyse(input));
    if (r.ok) {
      assert(Array.isArray(r.value.findings));
      assert.equal(typeof r.value.usage, 'object');
    } else assert(r.error instanceof TraceFormatError, `${r.error?.name}: ${r.error?.message}`);
  }), { numRuns: 1000 });
});

test('a leading byte order mark and CRLF line endings do not change the result', () => {
  fc.assert(fc.property(traceText, (input) => {
    const plain = outcome(() => normalise(input));
    for (const variant of ['﻿' + input, input.replace(/\n/g, '\r\n')]) {
      const other = outcome(() => normalise(variant));
      assert.equal(other.ok, plain.ok);
      if (plain.ok) assert.deepEqual(other.value, plain.value);
      else assert.equal(other.error.message, plain.error.message);
    }
  }), { numRuns: 500 });
});

test('a trace read as JSON text, as JSONL lines, or as a parsed value gives the same steps', () => {
  fc.assert(fc.property(fc.oneof(fc.array(openaiMessage, { minLength: 1, maxLength: 6 }),
    fc.array(anthropicMessage, { minLength: 1, maxLength: 6 }), fc.array(anySpan, { minLength: 1, maxLength: 5 })), (msgs) => {
    const asValue = outcome(() => normalise(JSON.parse(JSON.stringify(msgs))));
    const asJson = outcome(() => normalise(JSON.stringify(msgs)));
    const asJsonl = outcome(() => normalise(msgs.map((m) => JSON.stringify(m)).join('\n')));
    for (const r of [asJson, asJsonl]) {
      assert.equal(r.ok, asValue.ok);
      if (r.ok) {
        assert.equal(r.value.format, asValue.value.format);
        assert.deepEqual(r.value.steps, asValue.value.steps);
        assert.deepEqual(r.value.instructions, asValue.value.instructions);
      }
    }
  }), { numRuns: 500 });
});

test('canonicalJSON round-trips every JSON value and ignores key order', () => {
  fc.assert(fc.property(json, (v) => {
    const c = canonicalJSON(v);
    assert.deepEqual(JSON.parse(c), JSON.parse(JSON.stringify(v)));
    assert.equal(canonicalJSON(JSON.parse(c)), c);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const reversed = JSON.parse(`{${Object.keys(v).reverse().map((k) => `${JSON.stringify(k)}:${JSON.stringify(v[k])}`).join(',')}}`);
      assert.equal(canonicalJSON(reversed), c);
    }
  }), { numRuns: 1000 });
});

test('canonicalArgs gives the same answer for a value and for its JSON string', () => {
  // null itself means "no arguments" (args: null).
  // A string is itself read as JSON text, so only non-string values are compared.
  fc.assert(fc.property(json.filter((v) => v !== null && typeof v !== 'string'), (v) => {
    assert.equal(canonicalArgs(JSON.stringify(v)), canonicalArgs(JSON.parse(JSON.stringify(v))));
  }));
  // A string that is not JSON is kept verbatim as a JSON string literal.
  fc.assert(fc.property(fc.string().filter((s) => s.trim() !== '' && outcome(() => JSON.parse(s.trim())).ok === false), (s) => {
    assert.equal(JSON.parse(canonicalArgs(s)), s);
  }));
});

// ------------------------------------------------------------------ regressions

// Counterexamples fast-check found. Each threw a TypeError (a crash with a stack
// trace in the CLI) before normalise.js checked these types.
test('malformed traces that used to crash now give a TraceFormatError', () => {
  const inputs = [
    '{"resourceSpans":[{"scopeSpans":{}}]}',
    '{"resourceSpans":[null]}',
    '{"resourceSpans":[{"scopeSpans":[{"spans":[null]}]}]}',
    '[{"name":"","attributes":[{"key":"x","value":{"arrayValue":{"values":{}}}}]}]',
    '[{"role":"user","content":[{"type":"text","text":[]},{"type":"tool_result"}]}]',
    '{"role":"system","content":[{"type":"refusal","refusal":{"toString":[]}}]}',
    '{"role":"assistant","tool_calls":[null]}',
  ];
  for (const input of inputs) assert.throws(() => normalise(input), TraceFormatError, input);
});

test('odd but readable values no longer crash the parser', () => {
  // Token counts that are objects are "not recorded", not a crash.
  const anthropic = normalise('[{"role":"assistant","content":[{"type":"tool_use","name":"bash","input":{}}],"usage":{"input_tokens":3,"cache_read_input_tokens":{"toString":null}}}]');
  assert.equal(anthropic.steps[0].tokens_in, 3);
  // A null arrayValue reads as an empty list.
  const otel = normalise('[{"name":"a","attributes":[{"key":"gen_ai.operation.name","value":{"stringValue":"chat"}},{"key":"x","value":{"arrayValue":null}}]}]');
  assert.equal(otel.format, 'otel-genai');
  // An error.type that is an object is left out of the error text.
  const tool = normalise('[{"name":"t","status":{"code":2,"message":"denied"},"attributes":{"gen_ai.operation.name":"execute_tool","gen_ai.tool.name":"bash","error.type":{"toString":null}}}]');
  assert.equal(tool.steps[1].text, 'denied');
  assert.equal(tool.steps[1].error, true);
});

test('a "__proto__" key is kept as data in arguments and attributes', () => {
  assert.equal(canonicalArgs('{"__proto__":{"a":1},"b":2}'), '{"__proto__":{"a":1},"b":2}');
  // Before: the kvlist key replaced the attribute object's prototype, so the
  // span gained a gen_ai.operation.name it never set and became a chat step.
  assert.throws(() => normalise(JSON.stringify([{ name: 'x', attributes: [{ key: '__proto__', value: { kvlistValue: { values: [{ key: 'gen_ai.operation.name', value: { stringValue: 'chat' } }] } } }] }])),
    /no span carries a gen_ai.operation.name/);
});
