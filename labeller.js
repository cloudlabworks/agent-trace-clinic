// Agent Trace Clinic: optional model pass.
//
// A small language model reads the normalised steps and names MAST failure modes
// (Cemri et al., "Why Do Multi-Agent LLM Systems Fail?", arXiv:2503.13657v3, Appendix A,
// https://arxiv.org/abs/2503.13657v3). Its labels are MODEL OPINION: they are kept apart
// from the deterministic detector findings and are never merged into them.
//
// Runs in a browser page and under Node. The prompt builder and the output parser are
// pure functions with no dependencies. Only loadLabeller() needs transformers.js: in a
// browser it is imported from a pinned CDN URL; under Node, pass the module in
// (Node cannot import https URLs). The model runs where the page runs: trace text is
// never sent anywhere. The library and the model weights are downloaded once from the
// jsDelivr and Hugging Face CDNs.

export const MAST_SOURCE = 'https://arxiv.org/abs/2503.13657v3';

// The 14 MAST failure modes, names from Appendix A of v3; definitions not reproduced.
export const MAST_MODES = [
  { id: 'FM-1.1', category: 'System design issues', name: 'Disobey task specification', definition: '[FM-1.1 definition: see MAST v3 Appendix A (CC BY-NC-ND 4.0); text not reproduced here]' },
  { id: 'FM-1.2', category: 'System design issues', name: 'Disobey role specification', definition: '[FM-1.2 definition: see MAST v3 Appendix A (CC BY-NC-ND 4.0); text not reproduced here]' },
  { id: 'FM-1.3', category: 'System design issues', name: 'Step repetition', definition: '[FM-1.3 definition: see MAST v3 Appendix A (CC BY-NC-ND 4.0); text not reproduced here]' },
  { id: 'FM-1.4', category: 'System design issues', name: 'Loss of conversation history', definition: '[FM-1.4 definition: see MAST v3 Appendix A (CC BY-NC-ND 4.0); text not reproduced here]' },
  { id: 'FM-1.5', category: 'System design issues', name: 'Unaware of termination conditions', definition: "[FM-1.5 definition: see MAST v3 Appendix A (CC BY-NC-ND 4.0); text not reproduced here]" },
  { id: 'FM-2.1', category: 'Inter-agent misalignment', name: 'Conversation reset', definition: '[FM-2.1 definition: see MAST v3 Appendix A (CC BY-NC-ND 4.0); text not reproduced here]' },
  { id: 'FM-2.2', category: 'Inter-agent misalignment', name: 'Fail to ask for clarification', definition: '[FM-2.2 definition: see MAST v3 Appendix A (CC BY-NC-ND 4.0); text not reproduced here]' },
  { id: 'FM-2.3', category: 'Inter-agent misalignment', name: 'Task derailment', definition: '[FM-2.3 definition: see MAST v3 Appendix A (CC BY-NC-ND 4.0); text not reproduced here]' },
  { id: 'FM-2.4', category: 'Inter-agent misalignment', name: 'Information withholding', definition: '[FM-2.4 definition: see MAST v3 Appendix A (CC BY-NC-ND 4.0); text not reproduced here]' },
  { id: 'FM-2.5', category: 'Inter-agent misalignment', name: "Ignored other agent's input", definition: '[FM-2.5 definition: see MAST v3 Appendix A (CC BY-NC-ND 4.0); text not reproduced here]' },
  { id: 'FM-2.6', category: 'Inter-agent misalignment', name: 'Reasoning-action mismatch', definition: '[FM-2.6 definition: see MAST v3 Appendix A (CC BY-NC-ND 4.0); text not reproduced here]' },
  { id: 'FM-3.1', category: 'Task verification', name: 'Premature termination', definition: '[FM-3.1 definition: see MAST v3 Appendix A (CC BY-NC-ND 4.0); text not reproduced here]' },
  { id: 'FM-3.2', category: 'Task verification', name: 'No or incomplete verification', definition: '[FM-3.2 definition: see MAST v3 Appendix A (CC BY-NC-ND 4.0); text not reproduced here]' },
  { id: 'FM-3.3', category: 'Task verification', name: 'Incorrect verification', definition: '[FM-3.3 definition: see MAST v3 Appendix A (CC BY-NC-ND 4.0); text not reproduced here]' },
];

const MODE_BY_ID = new Map(MAST_MODES.map((m) => [m.id, m]));

// The model the Clinic loads, chosen by the bake-off in bakeoff/ (see README.md, "Model pass").
// The revision is a commit sha, so the weights cannot change under the page. Thinking is on:
// without it this model named failures on clean traces; with it, it mostly declines instead.
export const DEFAULT_MODEL = {
  id: 'onnx-community/Qwen3-0.6B-ONNX',
  revision: '1e0a4a196ecabdf9a879664110574563d3f372d3',
  dtype: { webgpu: 'q4f16', wasm: 'q4', cpu: 'q4' },
  thinking: true,
  repetitionPenalty: 1,
};

// transformers.js, pinned to the version the bake-off ran.
export const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1';

export const PROMPT_LIMITS = { stepText: 240, maxSteps: 60, maxNewTokens: 160, maxNewTokensThinking: 1024 };

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

// What the model sees for one step. The parser checks quotes against this exact text.
export function stepLine(step) {
  const head = `${step.role} ${step.kind}${step.error ? ' ERROR' : ''}`;
  let body;
  if (step.kind === 'tool_call') body = `${step.tool}(${step.args ?? ''})`;
  else if (step.kind === 'tool_result') body = `${step.tool} -> ${oneLine(step.text)}`;
  else body = oneLine(step.text);
  return `${head}: ${clip(oneLine(body), PROMPT_LIMITS.stepText)}`;
}

export function renderSteps(steps) {
  const shown = steps.slice(0, PROMPT_LIMITS.maxSteps);
  const lines = shown.map((s) => `#${s.i} ${stepLine(s)}`);
  if (steps.length > shown.length) lines.push(`(${steps.length - shown.length} more steps not shown)`);
  return lines.join('\n');
}

export function systemPrompt() {
  const defs = MAST_MODES.map((m) => `${m.id} ${m.name}: ${m.definition}`).join('\n');
  return [
    'You review the trace of an AI agent and label its failures with the MAST taxonomy.',
    'The 14 failure modes:',
    defs,
    '',
    'Rules:',
    '- Label a mode only when a specific step shows it. Many traces have no failure at all.',
    '- Label what the agent did (assistant and tool steps). The user\'s request is not a failure.',
    '- step is the number after # on the line that shows the failure.',
    '- quote is a few words copied exactly from that step line in the trace, never from these definitions.',
    `- mode must be one of: ${MAST_MODES.map((m) => m.id).join(', ')}.`,
    '- Answer with only a JSON array and nothing else, one object per failure. Example of the shape:',
    '[{"mode": "FM-2.4", "step": 5, "quote": "words copied from step 5"}]',
    '- If the trace shows no failure, answer [].',
  ].join('\n');
}

// Chat messages for one trace. Built from the normalised steps only: detector findings
// are deliberately left out so the model's opinion is independent of them.
// thinking: let a hybrid reasoning model (Qwen3, SmolLM3) think before answering.
export function buildMessages(steps, { thinking = false } = {}) {
  return [
    { role: 'system', content: thinking ? systemPrompt() : `${systemPrompt()}\n/no_think` },
    { role: 'user', content: `Trace (${steps.length} steps):\n${renderSteps(steps)}\n\nLabel the failures as a JSON array.` },
  ];
}

// Optional text to start the assistant turn with (for example "[" to force a JSON array).
// Prefilling "[" did not help on the early prompts, and with thinking on it would cut the
// thinking off, so the default is empty.
export const ANSWER_PREFIX = '';

// --------------------------------------------------------------------------- parser

function stripNoise(text) {
  let t = String(text ?? '');
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, ' ');
  t = t.replace(/<think>[\s\S]*$/i, ' '); // an unclosed think block: nothing usable after it
  t = t.replace(/```[a-zA-Z]*\n?/g, ' ').replace(/```/g, ' ');
  return t;
}

// Every balanced [...] or {...} span that is not inside an earlier one, in order;
// strings respected. A truncated array yields no span of its own, but its complete
// objects still come out one by one.
function jsonCandidates(t) {
  const out = [];
  let end = 0;
  for (let start = 0; start < t.length; start++) {
    const open = t[start];
    if (start < end || (open !== '[' && open !== '{')) continue;
    const stack = [];
    let inStr = false;
    let esc = false;
    for (let j = start; j < t.length; j++) {
      const c = t[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '[' || c === '{') stack.push(c);
      else if (c === ']' || c === '}') {
        const want = c === ']' ? '[' : '{';
        if (stack.pop() !== want) break;
        if (stack.length === 0) {
          out.push(t.slice(start, j + 1));
          end = j + 1;
          break;
        }
      }
    }
  }
  return out;
}

function itemsFrom(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    for (const k of ['labels', 'failures', 'modes', 'findings']) if (Array.isArray(value[k])) return value[k];
    if ('mode' in value || 'id' in value) return [value];
  }
  return null;
}

export function normaliseModeId(raw) {
  const m = /^\s*(?:FM)?\s*-?\s*([123])\s*\.\s*(\d)\b/i.exec(String(raw ?? ''));
  if (!m) return null;
  const id = `FM-${m[1]}.${m[2]}`;
  return MODE_BY_ID.has(id) ? id : null;
}

const squash = (s) => oneLine(s).toLowerCase().replace(/^["'`]+|["'`.]+$/g, '');

// Parse raw model output into labels, defensively. One bad item is dropped on its own
// (and listed in `dropped`); if no JSON array can be found, or every item is bad, the
// result is "no model opinion". An empty array is a real opinion: no failure seen.
export function parseLabels(rawText, steps) {
  const none = (reason) => ({ status: 'no_model_opinion', reason, labels: [], dropped: [] });
  const parsed = [];
  for (const c of jsonCandidates(stripNoise(rawText))) {
    try {
      parsed.push(JSON.parse(c));
    } catch {
      // not JSON; skip it
    }
  }
  // The first array (or {labels: [...]}) wins. If the output was cut off before the
  // array closed, the complete label objects that did come out are used.
  let items = null;
  let truncated = false;
  for (const v of parsed) {
    if (Array.isArray(v) || (v && typeof v === 'object' && !('mode' in v) && !('id' in v))) items = itemsFrom(v);
    if (items) break;
  }
  if (!items) {
    const loose = parsed.filter((v) => v && typeof v === 'object' && !Array.isArray(v) && ('mode' in v || 'id' in v));
    if (loose.length) {
      items = loose;
      truncated = true;
    }
  }
  if (!items) return none('no JSON array in the model output');

  const byIndex = new Map(steps.map((s) => [s.i, s]));
  const labels = [];
  const dropped = [];
  const seen = new Set();
  for (const item of items) {
    const drop = (why) => dropped.push({ item, why });
    if (!item || typeof item !== 'object') { drop('not an object'); continue; }
    const mode = normaliseModeId(item.mode ?? item.id);
    if (!mode) { drop('unknown mode id'); continue; }
    const stepNo = typeof item.step === 'string' ? Number(item.step.replace(/^#/, '')) : item.step;
    if (!Number.isInteger(stepNo) || !byIndex.has(stepNo)) { drop('step not in trace'); continue; }
    const quote = typeof item.quote === 'string' ? item.quote.trim() : '';
    const q = squash(quote);
    if (q.length < 3) { drop('missing quote'); continue; }
    let at = stepNo;
    let movedFrom = null;
    if (!squash(stepLine(byIndex.get(stepNo))).includes(q)) {
      // A quote on the wrong step is moved only when it appears in exactly one step.
      const hits = steps.filter((s) => squash(stepLine(s)).includes(q));
      if (hits.length !== 1) { drop('quote not found in that step'); continue; }
      at = hits[0].i;
      movedFrom = stepNo;
    }
    const key = `${mode}|${at}`;
    if (seen.has(key)) { drop('duplicate'); continue; }
    seen.add(key);
    const label = { mode, name: MODE_BY_ID.get(mode).name, step: at, quote: clip(oneLine(quote), 80) };
    if (movedFrom !== null) label.step_given = movedFrom;
    labels.push(label);
  }
  if (items.length > 0 && labels.length === 0) return { ...none('every label was invalid'), dropped };
  return { status: 'ok', reason: truncated ? 'no complete JSON array; complete label objects kept' : null, labels, dropped };
}

// Model-opinion findings for the report. Shaped like detector findings so a page can list
// them, but with source "model_opinion" and an id prefixed "mast:", and never merged into
// runDetectors() output.
export function toFindings(result, modelId = DEFAULT_MODEL.id) {
  if (!result || result.status !== 'ok') return [];
  return result.labels.map((l) => ({
    id: `mast:${l.mode}`,
    source: 'model_opinion',
    severity: 'opinion',
    steps: [l.step],
    evidence: l.quote,
    explain: `Model opinion (${modelId.split('/').pop()}): ${l.mode} ${l.name}. ${MODE_BY_ID.get(l.mode).definition} This is a small model's reading of the trace, not a deterministic check.`,
  }));
}

// --------------------------------------------------------------------------- model

const inBrowser = () => typeof window !== 'undefined' && typeof document !== 'undefined';

async function webgpuAdapter() {
  try {
    return (await globalThis.navigator?.gpu?.requestAdapter()) ?? null;
  } catch {
    return null;
  }
}

// Load the model once; returns { label(steps), model, revision, dtype, device, dispose() }.
// options.transformers: the transformers.js module (required under Node).
export async function loadLabeller(options = {}) {
  const model = options.model ?? DEFAULT_MODEL.id;
  const revision = options.revision ?? DEFAULT_MODEL.revision;
  let tf = options.transformers;
  if (!tf) {
    if (!inBrowser()) throw new Error('loadLabeller: under Node, pass { transformers } (the @huggingface/transformers module)');
    tf = await import(/* webpackIgnore: true */ TRANSFORMERS_CDN);
  }
  const device = options.device ?? (inBrowser() ? ((await webgpuAdapter()) ? 'webgpu' : 'wasm') : 'cpu');
  let dtype = options.dtype ?? DEFAULT_MODEL.dtype[device] ?? 'q4';
  // q4f16 needs 16-bit float shaders; without them, fall back to the q4 weights.
  if (!options.dtype && device === 'webgpu' && !(await webgpuAdapter())?.features?.has('shader-f16')) dtype = DEFAULT_MODEL.dtype.wasm;
  const common = { revision, progress_callback: options.progress_callback };
  const tokenizer = await tf.AutoTokenizer.from_pretrained(model, common);
  const lm = await tf.AutoModelForCausalLM.from_pretrained(model, { ...common, dtype, device });
  const thinking = options.thinking ?? DEFAULT_MODEL.thinking ?? false;
  const maxNewTokens = options.maxNewTokens ?? (thinking ? PROMPT_LIMITS.maxNewTokensThinking : PROMPT_LIMITS.maxNewTokens);
  const prefix = options.answerPrefix ?? ANSWER_PREFIX;
  const repetitionPenalty = options.repetitionPenalty ?? DEFAULT_MODEL.repetitionPenalty ?? 1;

  async function label(steps) {
    const prompt = tokenizer.apply_chat_template(buildMessages(steps, { thinking }), {
      tokenize: false,
      add_generation_prompt: true,
      enable_thinking: thinking,
    }) + prefix;
    const inputs = tokenizer(prompt, { add_special_tokens: false });
    const t0 = performance.now();
    let firstTokenMs = null;
    const streamer = new tf.TextStreamer(tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: () => {},
      token_callback_function: () => {
        if (firstTokenMs === null) firstTokenMs = performance.now() - t0;
      },
    });
    const out = await lm.generate({ ...inputs, max_new_tokens: maxNewTokens, do_sample: false, repetition_penalty: repetitionPenalty, streamer });
    const totalMs = performance.now() - t0;
    const promptLen = inputs.input_ids.dims.at(-1);
    const newIds = out.slice(null, [promptLen, null]);
    const raw = prefix + tokenizer.batch_decode(newIds, { skip_special_tokens: true })[0];
    const parsed = parseLabels(raw, steps);
    return {
      source: 'model_opinion',
      model,
      revision,
      dtype,
      device,
      ...parsed,
      raw,
      answer_prefix: prefix,
      thinking,
      repetition_penalty: repetitionPenalty,
      timing: { first_token_ms: firstTokenMs, total_ms: totalMs, prompt_tokens: promptLen, new_tokens: out.dims.at(-1) - promptLen },
    };
  }

  return { label, model, revision, dtype, device, thinking, dispose: () => lm.dispose?.() };
}
