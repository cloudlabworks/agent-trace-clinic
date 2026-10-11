// Agent Trace Clinic: trace normaliser.
// Turns one agent trace into a flat list of steps. Plain ES module, no Node
// built-ins, so the same file runs in a browser and under Node.
//
// Accepted inputs (see README.md for the exact rules):
//   openai     OpenAI chat-completions message arrays (tool_calls / role "tool")
//   anthropic  Anthropic Messages arrays (tool_use / tool_result content blocks)
//   chat-text  text-only role/content arrays (no tool use; same result either way)
//   otel-genai OpenTelemetry GenAI spans: OTLP JSON or a flat array of spans
//   Any of the above as JSONL, one message or span (or OTLP export) per line.
//
// Step shape:
//   { i, role, kind: "message"|"tool_call"|"tool_result", tool, args, text,
//     tokens_in, tokens_out, error }
// args is a canonical JSON string (keys sorted, no whitespace) or null.
// Tokens are null when the trace does not record them; nothing is estimated.
//
// System/developer instructions travel beside the steps, never as extra steps
// (extra steps would shift every step index):
//   instructions: [{ step, text, per_call }]
// step is the first step the text applies to; per_call is true for OTel
// gen_ai.system_instructions, which are recorded per model call.

export class TraceFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TraceFormatError';
  }
}

const ACCEPTED =
  'Accepted: OpenAI chat-completions messages (tool_calls / role "tool"), ' +
  'Anthropic Messages (tool_use / tool_result blocks), OpenTelemetry GenAI spans ' +
  '(OTLP JSON or a flat span array with gen_ai.* attributes), or JSONL of any of these.';

function fail(why) {
  throw new TraceFormatError(`Unrecognised trace format: ${why}. ${ACCEPTED}`);
}

// ---------------------------------------------------------------- canonical JSON

export function canonicalJSON(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (v[k] !== undefined) out[k] = sortKeys(v[k]);
    }
    return out;
  }
  return v === undefined ? null : v;
}

// Arguments may arrive as an object or as a JSON string (OpenAI, some OTel
// exporters). A string that does not parse is kept as a JSON string literal.
export function canonicalArgs(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s === '') return canonicalJSON({});
    try {
      return canonicalJSON(JSON.parse(s));
    } catch {
      return JSON.stringify(raw);
    }
  }
  return canonicalJSON(raw);
}

// ---------------------------------------------------------------- parsing

// Returns { data, container: "json"|"jsonl" }.
export function parseTraceText(text) {
  if (typeof text !== 'string') fail('input is not text');
  const body = text.replace(/^﻿/, '').trim();
  if (body === '') fail('input is empty');
  try {
    return { data: JSON.parse(body), container: 'json' };
  } catch {
    // fall through to JSONL
  }
  const lines = body.split(/\r?\n/);
  const values = [];
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim();
    if (line === '') continue;
    try {
      values.push(JSON.parse(line));
    } catch (e) {
      fail(`not valid JSON, and line ${n + 1} is not valid JSON either (${e.message})`);
    }
  }
  if (values.length === 0) fail('no JSON values found');
  // JSONL of OTLP exports (one resourceSpans document per line): merge.
  if (values.every((v) => isPlainObject(v) && Array.isArray(v.resourceSpans))) {
    return { data: { resourceSpans: values.flatMap((v) => v.resourceSpans) }, container: 'jsonl' };
  }
  return { data: values, container: 'jsonl' };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------- entry point

// input: trace text (JSON or JSONL) or an already-parsed value.
// Returns { format, container, steps, instructions }.
export function normalise(input) {
  let data;
  let container = 'json';
  if (typeof input === 'string') {
    ({ data, container } = parseTraceText(input));
  } else {
    data = input;
  }

  if (isPlainObject(data) && Array.isArray(data.resourceSpans)) {
    return finish('otel-genai', container, otelSteps(otlpSpans(data)));
  }
  if (isPlainObject(data) && Array.isArray(data.spans)) data = data.spans;
  let topSystem = null; // Anthropic {system, messages}
  if (isPlainObject(data) && Array.isArray(data.messages)) {
    topSystem = systemText(data.system);
    data = data.messages;
  }
  // A single message or span on its own (e.g. a one-line JSONL file).
  if (isPlainObject(data) && (typeof data.role === 'string' || isSpanLike(data))) data = [data];

  if (!Array.isArray(data)) {
    fail('expected an array of messages or spans, an object with "messages" or "spans", or an OTLP "resourceSpans" document');
  }
  if (data.length === 0) fail('the trace is an empty list');

  if (data.every(isSpanLike)) {
    return finish('otel-genai', container, otelSteps(data.map(flatSpan)));
  }
  if (data.every((m) => isPlainObject(m) && typeof m.role === 'string')) {
    const format = classifyMessages(data);
    const steps = format === 'anthropic' ? anthropicSteps(data) : openaiSteps(data);
    const out = finish(format, container, steps);
    if (topSystem) out.instructions.unshift({ step: 0, text: topSystem, per_call: false });
    return out;
  }
  const bad = data.findIndex((m) => !(isPlainObject(m) && (typeof m.role === 'string' || isSpanLike(m))));
  fail(`item ${bad >= 0 ? bad : 0} is neither a chat message (no "role") nor a span (no "attributes"), or the list mixes messages and spans`);
}

function finish(format, container, steps) {
  if (steps.length === 0) fail(`no steps could be read from this ${format} trace`);
  steps.forEach((s, i) => (s.i = i));
  const instructions = [];
  for (const s of steps) {
    if (s.instructions !== undefined) {
      instructions.push({ step: s.i, text: s.instructions, per_call: true });
      delete s.instructions;
    } else if (s.kind === 'message' && (s.role === 'system' || s.role === 'developer') && s.text.trim() !== '') {
      instructions.push({ step: s.i, text: s.text, per_call: false });
    }
  }
  return { format, container, steps, instructions };
}

// System text as a string, from a string, a list of text blocks/parts, or a
// JSON string holding such a list (OTel gen_ai.system_instructions). null if none.
export function systemText(v) {
  v = maybeJSON(v);
  if (typeof v === 'string') return v.trim() === '' ? null : v;
  if (Array.isArray(v)) {
    const t = v
      .map((p) => (typeof p === 'string' ? p : p && (p.type === undefined || p.type === 'text') ? p.content ?? p.text ?? '' : ''))
      .filter((x) => typeof x === 'string' && x !== '')
      .join('\n');
    return t.trim() === '' ? null : t;
  }
  return null;
}

function step(fields) {
  return {
    i: -1,
    role: fields.role,
    kind: fields.kind,
    tool: fields.tool ?? null,
    args: fields.args ?? null,
    text: fields.text ?? '',
    tokens_in: fields.tokens_in ?? null,
    tokens_out: fields.tokens_out ?? null,
    error: Boolean(fields.error),
  };
}

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Put a message's token counts on the first step it produced (never repeated).
function attachTokens(steps, from, tokens_in, tokens_out) {
  if (from < steps.length) {
    steps[from].tokens_in = tokens_in;
    steps[from].tokens_out = tokens_out;
  } else if (tokens_in !== null || tokens_out !== null) {
    steps.push(step({ role: 'assistant', kind: 'message', text: '', tokens_in, tokens_out }));
  }
}

// ---------------------------------------------------------------- chat messages

const OPENAI_ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);
const ANTHROPIC_ROLES = new Set(['user', 'assistant']);
const ANTHROPIC_IGNORED_BLOCKS = new Set(['thinking', 'redacted_thinking', 'image', 'document']);

function classifyMessages(msgs) {
  let openai = false;
  let anthropic = false;
  for (const m of msgs) {
    if (m.role === 'function' || m.function_call) {
      fail('legacy OpenAI "function_call" / role "function" messages are not supported; use tool_calls');
    }
    if (Array.isArray(m.tool_calls) || m.role === 'tool') openai = true;
    if (Array.isArray(m.content) && m.content.some((b) => b && (b.type === 'tool_use' || b.type === 'tool_result'))) {
      anthropic = true;
    }
  }
  if (openai && anthropic) fail('the messages mix OpenAI tool_calls and Anthropic tool_use/tool_result blocks');
  if (anthropic) {
    for (const [n, m] of msgs.entries()) {
      if (!ANTHROPIC_ROLES.has(m.role)) fail(`Anthropic message ${n} has role "${m.role}" (expected user or assistant)`);
    }
    return 'anthropic';
  }
  for (const [n, m] of msgs.entries()) {
    if (!OPENAI_ROLES.has(m.role)) fail(`message ${n} has unknown role "${m.role}"`);
  }
  if (openai) return 'openai';
  // No tool use anywhere: require plain text content so we do not guess.
  for (const [n, m] of msgs.entries()) {
    const ok =
      typeof m.content === 'string' ||
      m.content === null ||
      (Array.isArray(m.content) && m.content.every((p) => p && p.type === 'text'));
    if (!ok) fail(`message ${n} has content that is neither text nor a recognised tool block`);
  }
  return 'chat-text';
}

function openaiText(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && (p.type === 'text' || p.type === 'refusal'))
      .map((p) => (p.type === 'refusal' ? p.refusal : p.text) ?? '')
      .join('\n');
  }
  if (isPlainObject(content)) return canonicalJSON(content);
  return String(content);
}

function usageIn(u) {
  if (!isPlainObject(u)) return null;
  return num(u.prompt_tokens ?? u.input_tokens);
}
function usageOut(u) {
  if (!isPlainObject(u)) return null;
  return num(u.completion_tokens ?? u.output_tokens);
}

// OpenAI has no error flag on tool messages. Rule (stated in README):
// error if the message sets is_error/error true, or the content is a JSON
// object with a top-level "error" key, or the content starts with
// "Error", "Exception" or "Traceback" (case-insensitive).
export function openaiToolError(m, text) {
  if (m.is_error === true || m.error === true) return true;
  const t = text.trim();
  if (/^(error|exception|traceback)\b/i.test(t)) return true;
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t);
      if (isPlainObject(o) && Object.prototype.hasOwnProperty.call(o, 'error') && o.error !== null && o.error !== false) {
        return true;
      }
    } catch {
      // not JSON; not an error by this rule
    }
  }
  return false;
}

function openaiSteps(msgs) {
  const steps = [];
  const calls = new Map(); // tool_call_id -> {tool, args}
  for (const m of msgs) {
    const from = steps.length;
    if (m.role === 'assistant') {
      const text = openaiText(m.content);
      const tcs = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      if (text.trim() !== '' || tcs.length === 0) steps.push(step({ role: 'assistant', kind: 'message', text }));
      for (const tc of tcs) {
        const fn = tc.function || {};
        if (typeof fn.name !== 'string') fail('an OpenAI tool_call has no function.name');
        const args = canonicalArgs(fn.arguments ?? {});
        if (tc.id) calls.set(tc.id, { tool: fn.name, args });
        steps.push(step({ role: 'assistant', kind: 'tool_call', tool: fn.name, args }));
      }
      attachTokens(steps, from, usageIn(m.usage), usageOut(m.usage));
    } else if (m.role === 'tool') {
      const text = openaiText(m.content);
      const call = calls.get(m.tool_call_id) || { tool: m.name ?? null, args: null };
      steps.push(step({ role: 'tool', kind: 'tool_result', tool: call.tool, args: call.args, text, error: openaiToolError(m, text) }));
    } else {
      steps.push(step({ role: m.role, kind: 'message', text: openaiText(m.content) }));
    }
  }
  return steps;
}

function anthropicResultText(content) {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b && b.type === 'text').map((b) => b.text ?? '').join('\n');
  }
  return canonicalJSON(content);
}

function anthropicSteps(msgs) {
  const steps = [];
  const calls = new Map(); // tool_use id -> {tool, args}
  for (const m of msgs) {
    const from = steps.length;
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    if (!Array.isArray(blocks)) fail('an Anthropic message has content that is neither a string nor a block list');
    let pendingText = null;
    const flushText = () => {
      if (pendingText !== null && pendingText.trim() !== '') {
        steps.push(step({ role: m.role, kind: 'message', text: pendingText }));
      }
      pendingText = null;
    };
    for (const b of blocks) {
      if (!isPlainObject(b) || typeof b.type !== 'string') fail('an Anthropic content block has no "type"');
      if (b.type === 'text') {
        pendingText = pendingText === null ? b.text ?? '' : `${pendingText}\n${b.text ?? ''}`;
      } else if (b.type === 'tool_use') {
        flushText();
        if (typeof b.name !== 'string') fail('an Anthropic tool_use block has no "name"');
        const args = canonicalArgs(b.input ?? {});
        if (b.id) calls.set(b.id, { tool: b.name, args });
        steps.push(step({ role: 'assistant', kind: 'tool_call', tool: b.name, args }));
      } else if (b.type === 'tool_result') {
        flushText();
        const call = calls.get(b.tool_use_id) || { tool: null, args: null };
        steps.push(step({ role: 'tool', kind: 'tool_result', tool: call.tool, args: call.args, text: anthropicResultText(b.content), error: b.is_error === true }));
      } else if (!ANTHROPIC_IGNORED_BLOCKS.has(b.type)) {
        fail(`unknown Anthropic content block type "${b.type}"`);
      }
    }
    flushText();
    if (m.role === 'assistant') {
      const u = m.usage;
      let tin = null;
      if (isPlainObject(u) && u.input_tokens !== undefined) {
        // Anthropic reports cached input separately; context size is the sum.
        tin = num(u.input_tokens) + (num(u.cache_read_input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0);
      }
      attachTokens(steps, from, tin, isPlainObject(u) ? num(u.output_tokens) : null);
    }
  }
  return steps;
}

// ---------------------------------------------------------------- OpenTelemetry

function isSpanLike(v) {
  if (!isPlainObject(v) || !('attributes' in v)) return false;
  return 'name' in v || 'spanId' in v || 'span_id' in v || 'traceId' in v || 'context' in v;
}

function otlpValue(v) {
  if (!isPlainObject(v)) return v;
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('boolValue' in v) return Boolean(v.boolValue);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(otlpValue);
  if ('kvlistValue' in v) {
    const o = {};
    for (const kv of v.kvlistValue.values || []) o[kv.key] = otlpValue(kv.value);
    return o;
  }
  if ('bytesValue' in v) return v.bytesValue;
  return null;
}

function flatAttributes(attrs) {
  if (Array.isArray(attrs)) {
    const o = {};
    for (const kv of attrs) if (kv && typeof kv.key === 'string') o[kv.key] = otlpValue(kv.value);
    return o;
  }
  return isPlainObject(attrs) ? { ...attrs } : {};
}

function flatSpan(s) {
  return {
    name: s.name,
    start: s.startTimeUnixNano ?? s.start_time_unix_nano ?? s.startTime ?? s.start_time ?? null,
    status: s.status || {},
    attrs: flatAttributes(s.attributes),
  };
}

function otlpSpans(doc) {
  const out = [];
  for (const rs of doc.resourceSpans) {
    for (const ss of rs.scopeSpans || rs.instrumentationLibrarySpans || []) {
      for (const s of ss.spans || []) out.push(flatSpan(s));
    }
  }
  if (out.length === 0) fail('the OTLP document contains no spans');
  return out;
}

function sortKey(start) {
  if (start === null || start === undefined) return null;
  if (typeof start === 'number' && Number.isFinite(start)) return BigInt(Math.trunc(start));
  if (typeof start === 'string' && /^\d+$/.test(start)) return BigInt(start);
  const t = Date.parse(String(start));
  return Number.isNaN(t) ? null : BigInt(t) * 1000000n;
}

function isErrorStatus(status, attrs) {
  const c = status && status.code;
  if (c === 2 || c === '2' || c === 'STATUS_CODE_ERROR' || c === 'ERROR') return true;
  return attrs['error.type'] !== undefined && attrs['error.type'] !== null && attrs['error.type'] !== '';
}

function maybeJSON(v) {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

const INFERENCE_OPS = new Set(['chat', 'text_completion', 'generate_content']);

function otelSteps(spans) {
  const genai = spans.filter((s) => typeof s.attrs['gen_ai.operation.name'] === 'string');
  if (genai.length === 0) fail('no span carries a gen_ai.operation.name attribute');
  // Order by start time when every span has one; otherwise keep input order.
  const keys = genai.map((s) => sortKey(s.start));
  let ordered = genai;
  if (keys.every((k) => k !== null)) {
    ordered = genai
      .map((s, n) => ({ s, n, k: keys[n] }))
      .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.n - b.n))
      .map((x) => x.s);
  }
  const hasToolSpans = ordered.some((s) => s.attrs['gen_ai.operation.name'] === 'execute_tool');
  const steps = [];
  for (const s of ordered) {
    const a = s.attrs;
    const op = a['gen_ai.operation.name'];
    if (op === 'execute_tool') {
      const tool = a['gen_ai.tool.name'];
      if (typeof tool !== 'string') fail('an execute_tool span has no gen_ai.tool.name');
      const args = canonicalArgs(a['gen_ai.tool.call.arguments']);
      const error = isErrorStatus(s.status, a);
      let text = a['gen_ai.tool.call.result'];
      if (text === undefined || text === null) {
        text = error ? [a['error.type'], s.status && s.status.message].filter(Boolean).join(': ') : '';
      } else if (typeof text !== 'string') {
        text = canonicalJSON(text);
      }
      steps.push(step({ role: 'assistant', kind: 'tool_call', tool, args }));
      steps.push(step({ role: 'tool', kind: 'tool_result', tool, args, text, error }));
    } else if (INFERENCE_OPS.has(op)) {
      const from = steps.length;
      const out = maybeJSON(a['gen_ai.output.messages']);
      const first = Array.isArray(out) ? out[0] : null; // first choice only
      const parts = first && Array.isArray(first.parts) ? first.parts : [];
      const text = parts
        .filter((p) => p && p.type === 'text')
        .map((p) => p.content ?? '')
        .join('\n');
      steps.push(step({ role: 'assistant', kind: 'message', text }));
      const sys = systemText(a['gen_ai.system_instructions']);
      if (sys !== null) steps[from].instructions = sys; // moved out of the step by finish()
      if (!hasToolSpans) {
        for (const p of parts) {
          if (p && p.type === 'tool_call' && typeof p.name === 'string') {
            steps.push(step({ role: 'assistant', kind: 'tool_call', tool: p.name, args: canonicalArgs(maybeJSON(p.arguments) ?? {}) }));
          }
        }
      }
      attachTokens(steps, from, num(a['gen_ai.usage.input_tokens']), num(a['gen_ai.usage.output_tokens']));
    }
    // Other operations (invoke_agent, embeddings, retrieval, memory, ...) are
    // containers or side lookups and do not become steps.
  }
  return steps;
}
