# Agent Trace Clinic

Paste an AI agent's trace and get a triage report. This repository holds the parts that need no model: a normaliser that turns four trace formats into one step list, deterministic detectors that look for common agent failures, a usage calculator, a test suite of synthetic traces with their expected findings, and a small CLI. It also holds an optional model pass (`labeller.js`, see [Model pass](#model-pass)), in which a small model running in the visitor's browser gives a labelled second opinion.

Everything is plain JavaScript (ES modules), with no build step and no dependencies. `normalise.js`, `detectors.js`, `usage.js` and `labeller.js` use no Node built-ins, so the same files run in a browser page and under Node. Nothing is sent anywhere: the analysis is local. The optional model pass downloads a library and model weights once, but the trace never leaves the page.

```
node test.mjs                      # run every case and unit check
node cli.mjs trace.json            # text report
node cli.mjs trace.jsonl --json    # machine-readable report
node cli.mjs trace.json --steps    # also list the normalised steps
node cli.mjs trace.json --price-in N --price-out N   # optional: your price per million tokens
node cli.mjs trace.json --price N                    # optional: one price for all tokens
node cli.mjs trace.json --tasks 10,1000              # tasks per day to project (default 10 and 1,000)
node cli.mjs - < trace.json        # read from stdin
```

Needs a current Node.js (tested with Node 26). The CLI exits 0 after a report, and 2 on unreadable input or an unrecognised format.

## Input formats

A trace is one task: one run of an agent from request to final answer. The input can be a single JSON document, or JSONL with one message or span per line. JSON is tried first (so a one-line file holding a single message or span is a one-step trace); if it fails to parse, each non-empty line is parsed separately, and the first bad line is reported by number.

| Format | Recognised by | What becomes a step |
| --- | --- | --- |
| `openai`: OpenAI chat-completions messages (an array, or `{"messages": [...]}`) | any message with `tool_calls`, or with role `tool` | each message; an assistant message becomes its text (if any) and then one `tool_call` step per entry in `tool_calls`; each `tool` message becomes a `tool_result` |
| `anthropic`: Anthropic Messages (an array, or `{"system": ..., "messages": [...]}`) | any content block of type `tool_use` or `tool_result` | adjacent `text` blocks become one `message`, `tool_use` becomes `tool_call`, `tool_result` becomes `tool_result`, in block order; `thinking`, `redacted_thinking`, `image` and `document` blocks are skipped |
| `chat-text`: plain role/content chat with no tool use | every message has text-only content | one `message` step per message |
| `otel-genai`: OpenTelemetry GenAI spans: OTLP JSON (`resourceSpans[].scopeSpans[].spans[]`), a flat span array, or `{"spans": [...]}` | spans carrying `gen_ai.operation.name` | each `execute_tool` span becomes a `tool_call` plus a `tool_result`; each `chat`, `text_completion` or `generate_content` span becomes one assistant `message` carrying its token counts |

Anything else fails with an error that starts `Unrecognised trace format:` and says why. That includes an empty list, an unknown role, an unknown Anthropic block type, legacy OpenAI `function_call` messages, a list that mixes OpenAI and Anthropic tool markers, a list that mixes messages and spans, and spans with no `gen_ai.operation.name`. The normaliser never guesses a format.

### Step shape

```
{ i, role, kind: "message" | "tool_call" | "tool_result", tool, args, text, tokens_in, tokens_out, error }
```

- `i` is the 0-based position in the step list.
- `args` is canonical JSON: the arguments are parsed (OpenAI sends them as a string), object keys are sorted at every depth, and whitespace is removed. So `{"b": 1, "a": 2}` and `{"a":2,"b":1}` are the same call. An argument string that is not valid JSON is kept as a JSON string literal.
- On a `tool_result`, `tool` and `args` are copied from the call it answers, which is matched by `tool_call_id` (OpenAI) or `tool_use_id` (Anthropic). OTel `execute_tool` spans carry both on the span.
- `tokens_in` and `tokens_out` are `null` when the trace does not record them. Nothing is estimated. A message's counts go on the first step that message produced, never on more than one step.
  - OpenAI: `usage.prompt_tokens` and `usage.completion_tokens` on an assistant message (or `input_tokens` and `output_tokens`). Chat-completions responses carry usage, but a stored message list often drops it.
  - Anthropic: `usage.input_tokens + cache_read_input_tokens + cache_creation_input_tokens` in, and `output_tokens` out. Anthropic's `input_tokens` counts only the tokens after the last cache breakpoint, so the sum is the real context size.
  - OTel: `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` on inference spans. The spec says input tokens SHOULD include cached tokens.
- System and developer instructions are not steps, because extra steps would shift every step index. `normalise()` returns them beside the steps as `instructions: [{step, text, per_call}]`, where `step` is the first step the text applies to:
  - OpenAI and chat-text: each `system` or `developer` message (these also stay steps, as before);
  - Anthropic: the top-level `system` of `{"system": ..., "messages": [...]}`, at step 0;
  - OTel: `gen_ai.system_instructions` on each inference span, at that span's step, with `per_call: true`, because it is recorded per model call.
- `error` is true on a failed tool result:
  - Anthropic: the `tool_result` block has `is_error: true`.
  - OTel: the span status code is ERROR (`2`, `"STATUS_CODE_ERROR"` or `"ERROR"`), or the span has an `error.type` attribute.
  - OpenAI: the message format has no error flag, so the rule is that the tool message sets `is_error` or `error` to true, or its content is a JSON object with a non-null, non-false top-level `error` key, or its content starts with `Error`, `Exception` or `Traceback` (case-insensitive, after leading whitespace). A tool that reports failure any other way is read as a success.

### OpenTelemetry details

Written against the OpenTelemetry GenAI semantic conventions, which have moved out of the main semantic-conventions repository into [open-telemetry/semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai). That repository has no tagged release yet. This code follows its `main` branch at commit `6fd0d76` (2026-10-09), which builds on core semantic conventions v1.44.0. All GenAI attributes used here have status Development, so they may still change.

- Spans: [docs/gen-ai/gen-ai-spans.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/6fd0d763a092db245a54104fc1124031eb3c51d2/docs/gen-ai/gen-ai-spans.md) (execute tool span)
- The old page, https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/, now only says the conventions moved. The site's semantic conventions index shows version 1.44.0.
- Inference: [docs/gen-ai/client-inference.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/6fd0d763a092db245a54104fc1124031eb3c51d2/docs/gen-ai/client-inference.md) (chat spans, `gen_ai.output.messages`, usage)

Attributes read: `gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.output.messages` (parts of type `text` and `tool_call`), `gen_ai.system_instructions` (parts of type `text`, as a JSON string or a structured value), and `error.type`, plus the span status.

- OTLP attribute lists (`[{key, value: {stringValue | intValue | ...}}]`) and plain attribute objects are both accepted. `gen_ai.tool.call.arguments` and `gen_ai.output.messages` may be JSON strings or structured values.
- Spans are ordered by start time (`startTimeUnixNano`, compared as big integers, or an ISO `start_time`) when every GenAI span has one. Otherwise input order is kept.
- `gen_ai.input.messages` is not read. It replays the whole history on every inference span, so reading it would count tokens twice and create false loops. As a result, the user's request does not appear as a step in OTel traces.
- When a trace has `execute_tool` spans, tool calls come only from those spans. When it has none, `tool_call` parts in `gen_ai.output.messages` become `tool_call` steps with no results. Only the first output message (the first choice) is read.
- `invoke_agent`, `create_agent`, `invoke_workflow`, `plan`, `embeddings`, `retrieval` and memory operations are skipped, as are non-GenAI spans such as HTTP spans.

## Detectors

Each detector is a pure function over the step list (`forgotten_instruction` also reads the `instructions` that `normalise()` returns beside it; `runDetectors(steps, { instructions })`). Each one returns findings shaped `{id, severity, steps: [i...], evidence, explain}`, and some add a `data` field. Evidence is a quote of at most 80 characters. Severity is one of `high`, `medium`, `low` or `info`. The exact rules:

| id | Severity | Rule |
| --- | --- | --- |
| `tool_loop` | high | Three or more `tool_call` steps with the same `tool` and identical canonical `args`, anywhere in the trace (not only back to back). One finding per tool+args group; `steps` lists the calls. |
| `retry_storm` | high | Three or more `tool_result` steps with `error: true` for the same `tool`, whatever the args. One finding per tool; `steps` lists the failed results. |
| `context_growth` | medium; high if the multiple is at least 5 | Take every step with a recorded `tokens_in` (the context curve). Fire when all of these hold: there are at least 3 points; the curve never goes down; the first value is above 0; last / first is at least 2; and the average growth per model call, (last - first) / (points - 1), is at least 300 tokens. `steps` lists the points. `data` carries the curve, first, last, the multiple and `per_call`. A curve that dips once (for example after compaction) does not fire. See [Why 300 tokens per call](#why-300-tokens-per-call). |
| `unhandled_tool_error` | medium | A failed `tool_result` is unhandled when the next `tool_call` after it has the same tool and identical canonical args, or when the failed result is the last step of the trace. One finding per tool+args group; `steps` lists the unhandled failed results. |
| `unproven_completion` | high | An assistant `message` contains a completion claim, and no check ran after the last change made before that message, either before the claim or after it. One finding per message. See [Receipts: checks and changes](#receipts-checks-and-changes). |
| `forgotten_instruction` | high | A sentence of the system or developer instructions states a constraint in one of the forms listed in [Instructions it understands](#instructions-it-understands), and a later tool call or assistant message visibly breaks it. One finding per broken sentence; `steps` lists the steps that break it. `data` says which form, the literal or tools, the step the sentence first applies from, and `dropped_at`. |
| `token_totals` | info | Present when any step records tokens. `steps` lists those steps. `data` holds the per-step counts and the task totals (in, out, total, model calls). |

A completion claim is a sentence (split on `.`, `!`, `?` and newlines) that contains one of these whole words, in any case: done, fixed, deployed, passed, passes, passing, complete, completed, resolved, succeeded, successfully, shipped, merged. Questions (sentences ending in `?`) are skipped. So is a match when any of the three words right before it is one of: not, no, never, cannot, unable, failed, fail, will, once, until, after, if, when, before, yet, still, need, needs, should, would, could, might, may, or any word ending in `n't` or `'ll`. That way "not done yet", "could not be completed" and "I'll get it done" don't count.

### Receipts: checks and changes

`unproven_completion` sorts every tool call into a check (it only reads state) or a change (anything else).

- **Name words.** A tool name is split into lower-case words at every non-letter, non-digit character and at camelCase humps: `get_ticket` is `get ticket`, `readFile` is `read file`.
- **Check.** The name has a check word and no change word.
  - Check words: get, read, list, ls, show, view, describe, status, check, verify, validate, test, tests, health, healthz, healthcheck, search, query, fetch, find, lookup, inspect, diff, log, logs, ping, lint, cat, grep, curl, wget, poll, count, exists.
  - Change words, which win over check words (`update_status` is a change): set, update, write, edit, patch, create, add, insert, delete, remove, drop, put, post, deploy, restart, start, stop, kill, merge, push, commit, apply, install, uninstall, send, upload, move, rename, copy, reset, close, open, approve, publish, release, rollback, migrate, scale, enable, disable, assign, submit, save, replace, append, clear, revert.
  - **A name with neither is a change.** `run_migration`, `rotate_api_key` and `drop_table` are changes. `run` is in neither list, so `run_tests` is a check and `run_backup` is a change.
- **Shell tools.** When every word of the name is one of bash, shell, sh, zsh, terminal, exec, execute, run, command, cmd, local, the call is judged by its `command` (or `cmd`) argument instead. It is a check only when every part of the command line (split at `&&`, `||`, `;` and `|`) starts with one of: cat, ls, head, tail, grep, rg, find, stat, wc, diff, curl, wget, ping, pytest, jest, vitest, mocha, tox, or with git status/diff/log/show, npm/pnpm/yarn test, npm run test, node --test, make test/check, go test/vet, cargo test/check, kubectl get/describe/logs, systemctl status, docker ps/logs/inspect. A command with `>` or `tee` writes a file and is a change. curl and wget are changes when they send data or a non-GET method (`-X`, `--request`, `-d`, `--data*`, `-F`, `--form`, `-T`, `--upload-file`, `--post-data`, `--method`).

The rule for a claim at step c:

1. Let L be the last change (a `tool_call` that is not a check) before c. A change counts even when its result is an error.
2. The claim is proven when some check comes after L, anywhere in the task: before the claim ("verify, then say done") or after it ("say done, then verify").
3. A check whose result is marked as an error proves nothing. A result belongs to the first tool_result after the call with the same tool and arguments. A change's own result ("ok: updated") is never a receipt.
4. With no change before the claim, any successful check in the task proves it. With no tool calls at all, the claim is flagged.

### Instructions it understands

`forgotten_instruction` is deliberately narrow: it prefers a miss to a false alarm.

- **Sources.** Only the `instructions` described under [Step shape](#step-shape): system and developer messages, the Anthropic top-level `system`, and OTel `gen_ai.system_instructions`. User messages are never read as instructions. `gen_ai.input.messages` is still not read.
- **Sentences.** Instruction text is split at `.`, `!`, `?`, `;` (followed by a space or the end) and at newlines, but never inside `"..."`, `“...”` or `` `...` ``. A leading list marker (`1.`, `2)`, `-`, `*`) is dropped.
- **Keyword first.** The constraint word must start the sentence. A sentence that contains any of these words is skipped, because it carries a condition or an order the detector does not model: unless, except, if, when, whenever, until, before, after, without, while, otherwise, instead, once, first, then, more than, less than, fewer than, at most, at least, twice, again.
- **Literals.** A quoted literal is text in straight double quotes, curly double quotes or backticks, 1 to 60 characters. Single quotes are not read, because apostrophes break them. A literal matches case-insensitively, as a whole word at word edges.
- **Which tools a sentence is about.** A tool the trace calls is named exactly in the sentence, or every word of its name (two or more words) appears in the sentence, allowing the endings -s, -es, -d, -ed and -ing. "every ticket you update" is about `update_ticket` but not `get_ticket`.

The four forms (`NEG` is Never, Do not, Don't, Must not, Must never, You must not, You must never, Mustn't, You mustn't):

| Form | Shape | Broken by |
| --- | --- | --- |
| `forbidden_tool` | `NEG call\|use\|run\|invoke\|execute [the] TOOL [tool].` and nothing else in the sentence; TOOL is a tool the trace calls | any later call to TOOL |
| `tools_only` | `Only call\|use`, `You may only call\|use`, `Use only` or `Call only`, then `[the] [tools] A, B and C [tools].`; every item looks like a tool id (a tool the trace calls, or a word with `_`, `.`, `-` or a camelCase hump) | any later call to a tool not in the list |
| `forbidden_text` | `NEG say\|write\|mention\|use\|include\|output\|print\|reveal\|send\|share\|type\|enter\|promise\|add\|put ...` with exactly one quoted literal | if the sentence is about a tool: a call to that tool whose argument strings contain the literal; otherwise: a later assistant message that contains it |
| `required_text` | `Always ...` or `[You] must ...` (not followed by not or never) with exactly one quoted literal, about at least one tool | a later call to that tool whose argument strings do not contain the literal |

Each understood sentence applies from the first step it appears at, and stays in force after that even if later per-call instructions leave it out. That is the case of a harness that trims an instruction after the first call. For OTel per-call instructions, the finding also reports the violating steps at which the sentence was missing from the instructions in force (`dropped_at`). The explanation then says the instruction had been dropped from what the agent was given. Otherwise it says the agent ignored it.

Not understood, by design: "should never", "please don't" and other keywords; constraints with no quoted literal or tool id ("Never reopen a closed ticket yourself"); any condition ("Do not call search_docs more than twice"); two or more literals in one sentence; requirements that are not tied to a tool (`Always say "thanks"`); and anything after the tool name in a `forbidden_tool` sentence ("Never call drop_table on production").

### Why 300 tokens per call

The old rule fired at twice the first call's input. Ordinary turn-by-turn growth crosses that whenever the first call is small: a 200-token first call that adds 140 tokens a turn is past 2x after three turns. The patient (see [Patient traces](#patient-traces)) gives 18 curves, measured with its stub model's character/4 token estimates:

| Patient traces | Count | Average growth per call | Largest single step | Last / first |
| --- | --- | --- | --- | --- |
| clean, tool_loop, retry_storm, unproven_done, forgotten_instruction | 15 | 101 to 146 | 168 | 1.33 to 1.89 |
| context_growth | 3 | 614 to 919 | 2,099 to 2,136 | 3.01 to 4.76 |

- **300 is about twice the steepest non-growth trace (146).** It is also below the shallowest growth trace (614).
- **The fault is still caught in long runs.** The growth fault adds one untrimmed docs article of about 2,100 tokens on top of ordinary growth of about 130 per call. That stays above 300 per call up to 12 model calls, which is the patient's per-task cap.
- **The median step was rejected.** It does not separate the two groups, because the growth arrives in one or two jumps.
- **A final-size floor was rejected.** A large system prompt alone would cross it.
- **The 2x multiple stays as a second gate.** A large context that adds a few hundred tokens a turn is not reported.

The patient's clean prompt is long (about 1,100 tokens), so its clean controls were never at risk. The two checks that show the fix are:

- a unit check that takes the clean docs-answer curve minus 1,100 tokens (122 to 835, 6.8x, which the old rule flagged as high);
- the case `openai-small-first-call.json` (180 to 760, 4.2x, +145 per call).

Both are quiet under the new rule. Real token counts differ from the stub's estimates, so the threshold is a starting point, not a measured constant.

## Usage at scale

`usage.js` adds up tokens for the task, which is the whole trace, and multiplies them per day at 10 and 1,000 tasks (configurable). No prices ship with this project. You can pass a price per million tokens, either in and out separately or one price for both, in whatever unit you use. Cost is then computed in that same unit. With no price, no cost is computed or printed. `per_task.complete` is false when some model call recorded only one side of its token counts.

## Cases

`cases/` holds 25 synthetic traces. Every one is made up for this suite and none comes from a real agent. `cases/expected.json` lists the exact findings each must produce (id, severity, steps, and an evidence substring), or the error it must raise. The expected findings were written from each case's design, before the detectors were run on it. The test fails on a missing finding or an extra one.

| Case | Format | Designed failure | Expected findings |
| --- | --- | --- | --- |
| `openai-tool-loop.json` | openai | same search 3 times, argument keys reordered | tool_loop, token_totals |
| `openai-unproven-completion.json` | openai (`{messages}`) | edits a file, says "Fixed." without re-running the test; an earlier "Not done yet" must not count | unproven_completion, token_totals |
| `openai-clean.json` | openai | control: set, then read back; a JSON result with `"error": null` is not an error | token_totals |
| `openai-unhandled-error.jsonl` | openai, JSONL | permission error, identical retry, then a change of tool | unhandled_tool_error (first error only), token_totals |
| `anthropic-retry-storm.json` | anthropic | migration fails 3 times with different timeouts | retry_storm, token_totals |
| `anthropic-context-growth.json` | anthropic (`{system, messages}`) | reads ever-larger logs; one turn reports cache reads | context_growth (high, 8.5x), token_totals |
| `anthropic-clean.json` | anthropic | control: "Deployed." followed by a health check | token_totals |
| `anthropic-false-done-after-error.json` | anthropic | restart fails, agent says "Done" | unproven_completion, token_totals |
| `anthropic-unproven.jsonl` | anthropic, JSONL | CI still pending, agent says it merged; no token counts | none: a known miss. The agent made no change, so its CI status check counts as the receipt. The rule cannot see that the check said "pending" or that no merge call exists. Until the receipt rule was fixed, this case expected unproven_completion. |
| `otel-tool-loop.json` | otel-genai, OTLP | same fetch 4 times; spans shuffled in the file; an HTTP span and an `invoke_agent` span to skip | tool_loop, token_totals |
| `otel-retry-storm.json` | otel-genai, flat spans | identical query times out 3 times, then a cache read | tool_loop, retry_storm, unhandled_tool_error (first two errors), token_totals |
| `otel-clean.json` | otel-genai, OTLP | control: one tool call, structured result | token_totals |
| `otel-growth-unproven.jsonl` | otel-genai, JSONL | tests fail, a patch, then "All tests passed" with no re-run; context grows 2.3x | context_growth (medium), unproven_completion, token_totals |
| `openai-verify-then-claim.json` | openai (`{messages}`) | control: rotates a key, checks its status, then says "Done." | token_totals |
| `anthropic-claim-then-verify.json` | anthropic | control: rebuilds an index, says "Rebuild completed.", then checks the index status | token_totals |
| `otel-change-claim-no-verify.json` | otel-genai, flat spans | reads a setting, changes it, says "Done" with no check after the change | unproven_completion, token_totals |
| `openai-forbidden-tool.json` | openai | the system message says "Never call drop_table."; the agent calls it | forgotten_instruction, token_totals |
| `anthropic-required-label.json` | anthropic (`{system, messages}`) | `Always add the label "triaged" to every ticket you update.`: the first update has it, the second does not; a second rule (`Never mention "Project Kestrel" to customers.`) is kept | forgotten_instruction (second update only), token_totals |
| `otel-forbidden-phrase.jsonl` | otel-genai, JSONL | `Never mention "Project Kestrel".` in the per-call instructions; the answer mentions it | forgotten_instruction, token_totals |
| `openai-instructions-kept.json` | openai | control: four understood rules, all kept, plus a rule with a condition the detector skips | token_totals |
| `openai-small-first-call.json` | openai | control: a 180-token first call growing about 145 tokens a turn (4.2x), which the old 2x rule flagged | token_totals |
| `chat-text-plain.json` | chat-text | control: no tools, no claims | none |
| `unknown-format.json` | none | an unrelated JSON document | error |
| `mixed-formats.json` | none | OpenAI tool_calls with an Anthropic tool_result | error |
| `bad-line.jsonl` | none | line 3 is not valid JSON | error naming line 3 |

`node test.mjs` runs every case plus unit checks on canonical JSON, each format's edge cases, each detector's thresholds, and usage with and without a price. It also checks the model-pass prompt and parser against `fixtures/labeller-parser.json`, without loading a model. It prints pass and fail counts and exits non-zero on any failure.

`cases/mast-expected.json` gives the MAST failure modes each case should get (see Model pass below), with a reason for each one. Like `expected.json`, it was written from each case's design. It was committed before any model was run on the cases. It covers the 17 cases of the bake-off. The 8 cases added with the receipt fix and the `forgotten_instruction` detector are not in it, so the bake-off's case list and its counts stay the same.

## Model pass

`labeller.js` is an optional second opinion. A small language model reads the normalised steps and names failure modes from MAST, the Multi-Agent System Failure Taxonomy (Cemri et al., "Why Do Multi-Agent LLM Systems Fail?", [arXiv:2503.13657v3](https://arxiv.org/abs/2503.13657v3), Appendix A). MAST has 14 modes:

| Category | Modes |
| --- | --- |
| System design issues | FM-1.1 Disobey task specification, FM-1.2 Disobey role specification, FM-1.3 Step repetition, FM-1.4 Loss of conversation history, FM-1.5 Unaware of termination conditions |
| Inter-agent misalignment | FM-2.1 Conversation reset, FM-2.2 Fail to ask for clarification, FM-2.3 Task derailment, FM-2.4 Information withholding, FM-2.5 Ignored other agent's input, FM-2.6 Reasoning-action mismatch |
| Task verification | FM-3.1 Premature termination, FM-3.2 No or incomplete verification, FM-3.3 Incorrect verification |

`labeller.js` carries the paper's definition of each mode, word for word, and puts all 14 in the prompt. MAST was built from multi-agent traces. The cases here are single-agent, so FM-2.1 to FM-2.5 rarely apply.

### What it does

- **It runs in the visitor's browser.** In a page, `loadLabeller()` imports transformers.js 4.3.1 from the jsDelivr CDN. It then downloads the model weights from Hugging Face at a pinned commit, so the weights cannot change under the page. The browser caches both after the first load. The model runs on the visitor's machine: the trace text is never sent anywhere. It uses WebGPU with `q4f16` weights (0.58 GB) when the GPU supports 16-bit float shaders. Otherwise it falls back to WebAssembly with `q4` weights (0.93 GB). Under Node, pass the transformers.js module in: `loadLabeller({ transformers })`. The core files still have no dependencies.
- **The prompt sees only the steps.** It holds the 14 definitions and the steps, rendered one line each (`#i role kind: text`). It does not include the detector findings, so the model's opinion is independent of them.
- **The model answers with a JSON list** such as `[{"mode": "FM-3.2", "step": 3, "quote": "Done, the payments worker"}]`. An empty list means the model saw no failure.
- **transformers.js has no grammar-constrained decoding,** so the parser enforces the format instead:
  - Decoding is greedy, with a token cap.
  - Everything up to the last `</think>` is dropped (the model's reasoning), and so are any code fences.
  - The first JSON array is read. If the output was cut off, the complete label objects that did come out are kept.
- **Each label is checked:**
  - The mode must be one of the 14 ids.
  - The step must exist in the trace.
  - The quote must appear in that step's line. If the quote appears in exactly one other step, the label is moved there, and `step_given` records the step the model named.
  - A label that fails a check is dropped on its own. Duplicates are dropped too.
- **When the output is unusable, the result is "no model opinion".** That covers output with no JSON list in it, and output where every label failed its check.
- **Model opinion stays separate from the detectors.** `toFindings()` returns findings with `source: "model_opinion"`, `severity: "opinion"` and ids such as `mast:FM-3.2`. Each one is explained as a small model's reading of the trace. They are never merged into `runDetectors()` output. The deterministic findings remain the report.

### Bake-off

`bakeoff/` is dev-only. It has its own `package.json` with `@huggingface/transformers` 4.3.1 as a devDependency. It runs each candidate in Node over the 14 cases that parse and scores the answers against `cases/mast-expected.json`. The three cases the normaliser rejects are excluded.

```
cd bakeoff && npm install
node run.mjs --model onnx-community/Qwen3-0.6B-ONNX --revision 1e0a4a196ecabdf9a879664110574563d3f372d3 --dtype q4 --variant v3-thinking --thinking
node table.mjs     # the table below, re-scored with the current parser, and the pick rule
```

`run.mjs` calls `labeller.js` itself, so the bake-off measures the same prompt, generation call and parser that the Clinic ships. Weights are cached outside the repository. Each result in `bakeoff/results/` records:

- the model revision sha, verified from the revision-keyed cache path;
- the files the dtype needs;
- a hash of the prompt;
- every raw output.

Metrics:

- **Exact:** the set of modes named equals the expected set, out of 14. A case expected to have no failure counts only if the model answers `[]`.
- **Any-overlap:** at least one expected mode is named, counted over the 9 failure cases.
- **Control false positives:** any mode named on the 5 cases expected to have none.
- **No model opinion:** output the parser could not use. It counts as a miss everywhere.

The pick rule was written in `bakeoff/score.mjs` before any model ran:

- **Usable** means at most 2 of 14 with no model opinion, and at most 1 of 5 control false positives.
- Among usable models, the smallest download wins. A larger model wins only if it beats the smallest by at least 2 of the 9 failure cases on any-overlap, with no more control false positives.
- If no model is usable, the smallest is still wired in, and this section says it missed the bar.

Conditions of the runs:

- **Machine:** Node 26 on an Apple M4 Pro, CPU only (onnxruntime-node). These latencies are not browser numbers. Load time is from the local cache; download time depends on the network and is not shown.
- **Download:** the files the given dtype needs at the pinned revision.
- **Decoding:** greedy, with at most 160 new tokens, or 1024 with thinking on.
- **Sample size:** 14 synthetic cases is a small sample. The table picks a default; it does not rank the models in general.

| Model @ revision | dtype | Variant | Download | Load (cached) | Latency per case, median / max | First token, median | Exact (of 14) | Any-overlap (of 9) | Control false positives (of 5) | No model opinion (of 14) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| onnx-community/Qwen3-0.6B-ONNX @ 1e0a4a1 | q4f16 | v3-plain | 0.58 GB | 0.8 s | 4.3 s / 8.7 s | 3.0 s | 0 | 0 | 2 | 7 |
| onnx-community/Qwen3-0.6B-ONNX @ 1e0a4a1 | q4 | v2-plain | 0.93 GB | 0.9 s | 3.7 s / 9.4 s | 1.7 s | 0 | 0 | 4 | 6 |
| onnx-community/Qwen3-0.6B-ONNX @ 1e0a4a1 | q4 | v3-plain | 0.93 GB | 1.0 s | 3.3 s / 7.6 s | 1.9 s | 0 | 0 | 2 | 7 |
| onnx-community/Qwen3-0.6B-ONNX @ 1e0a4a1 | q4 | v3-thinking | 0.93 GB | 1.0 s | 42.7 s / 60.2 s | 1.8 s | 4 | 1 | 0 | 6 |
| onnx-community/Qwen3-0.6B-ONNX @ 1e0a4a1 | q4 | v3-thinking-rp1.1 | 0.93 GB | 1.0 s | 38.3 s / 56.9 s | 1.8 s | 3 | 0 | 0 | 8 |
| HuggingFaceTB/SmolLM3-3B-ONNX @ af50613 | q4 | v2-plain | 2.85 GB | 6.1 s | 9.4 s / 11.0 s | 3.9 s | 0 | 0 | 0 | 14 |
| HuggingFaceTB/SmolLM3-3B-ONNX @ af50613 | q4 | v3-plain | 2.85 GB | 4.7 s | 9.1 s / 11.7 s | 4.4 s | 0 | 0 | 0 | 14 |
| HuggingFaceTB/SmolLM3-3B-ONNX @ af50613 | q4 | v3-thinking | 2.85 GB | 1.6 s | 49.3 s / 54.4 s | 4.4 s | 0 | 0 | 0 | 14 |

#### Candidates

- **Qwen3-0.6B:** `onnx-community/Qwen3-0.6B-ONNX`, revision `1e0a4a196ecabdf9a879664110574563d3f372d3`, not gated. The ONNX repo declares no licence of its own. Its base model, `Qwen/Qwen3-0.6B`, is Apache-2.0 according to the Hub.
- **SmolLM3-3B:** there is no `onnx-community/SmolLM3-3B-ONNX`; the Hub API returns 401 for that name. The run used the official `HuggingFaceTB/SmolLM3-3B-ONNX`, revision `af50613703fb6f10ffcb21b27ad48edcb8334232`, which is Apache-2.0, not gated, and built for transformers.js.

Both are hybrid reasoning models. "Plain" turns thinking off; "thinking" leaves it on.

#### Prompt variants

All variants are kept, including the ones that scored zero.

- **v1 and v2, prefilled.** Two early prompts started the answer with `[`. v1 had an example with `"step": 0`. v2 used a placeholder example. Their result files were overwritten and are not kept. From the run logs:
  - Qwen3-0.6B q4 (v1 and v2 alike): exact 0, any-overlap 0, control false positives 3, no model opinion 9.
  - SmolLM3 q4 (v2): no model opinion on all 14.
- **v2-plain.** v2 without the prefill. These files predate prompt hashing.
- **v3.** Lists the 14 allowed ids and uses an example (`FM-2.4` at step 5) that matches no expected label.
- **rp1.1.** Adds a repetition penalty of 1.1.

The table re-parses every saved output with the current parser. The quote-relocation rule was added after the v2-plain runs, so Qwen3's v2-plain row differs a little from what that run printed.

#### Pick: Qwen3-0.6B, thinking on. It did not meet the bar.

No candidate was usable under the rule, so the rule's last clause applies: the smallest model, Qwen3-0.6B, is wired in. The rule does not choose between variants of one model, so that choice is ours:

- **Thinking is on.** With thinking on, Qwen3 named no failures on the five clean traces, with or without the repetition penalty. With thinking off, it named failures on 2 of them, which is worse than no opinion. Without the penalty it also got more right.
- **On the clean traces it answered `[]` on 3** and gave no opinion on the other 2.
- **It is weak even so.** It names an expected mode on 1 of the 9 failure cases. On 6 of 14 cases it gives no opinion. In all 6 it was still reasoning, often in a loop, when it reached the 1024-token cap.
- **It is slow on CPU.** A trace takes about 10 to 60 s on this machine's CPU, with a median of 43 s. Treat the model pass as experimental.
- **`q4f16` was checked on CPU.** With thinking off, it gave the same output as `q4` on all 14 cases, character for character. The thinking runs used `q4`, so the browser's WebGPU default (`q4f16` with thinking on) has not been measured.
- **The browser path has not been run end to end.** The pinned CDN bundle is checked: it is an ES module, it exports what `labeller.js` uses, and it is byte-identical to the npm package's `transformers.min.js`.

What did not work:

- **SmolLM3-3B never produced a usable answer.** Its outputs used words such as `"tool_call"` or `"system"` as mode names, or fell into repeated text, even though the prompt lists the 14 ids.
  - It answers short prompts coherently (`bakeoff/sanity.mjs`), so the build runs. Whether the problem is the q4 weights or the model was not found out.
  - Its 8-bit weights (3.1 GB) were not tried.
  - At 2.85 GB, it would also be a heavy download for a page.
- **The repetition penalty did not stop Qwen3's loops while thinking.**

The bake-off can be re-run on other small models with the same harness. The bar stays the same.

## Limits

What these checks cannot see:

- Intent. A loop of three identical calls may be legitimate polling, and a "done" may be true. The findings point at steps to read; they are not verdicts.
- Whether a check actually checks the claim. `unproven_completion` sorts tools by name, so any check after the last change clears a claim, even a read of something unrelated, and even a check whose result contradicts the claim. That last case is a misread check (MAST FM-3.3), as in `anthropic-unproven.jsonl`. A claimed action that no tool call performed ("I merged the PR" with no merge call) is not seen either. Tool names that hide a write behind a check word (`check_and_fix`) read as checks. Claim words outside the list ("it works now", "all good") are missed, and claim words used in other senses ("what I've done so far") can match.
- Instructions in other words. `forgotten_instruction` reads only the four forms above, so most real instructions are not checked at all. A paraphrased or conditional rule is missed by design. A literal that appears in an assistant message only to say it was avoided (`I did not mention "X"`) still counts as a mention.
- Context growth on a different scale. The 300-tokens-per-call threshold is set from the patient's stub estimates. An agent whose tool outputs are naturally large, such as file reads or logs, can pass it with no fault, and a growth that arrives in one jump in a very long run can fall under it.
- Tool failures a tool doesn't mark. An OpenAI tool that returns "could not connect" without a leading `Error` reads as a success. So does an OTel span with no error status.
- An agent that stops after a failure. `unhandled_tool_error` only looks at the next tool call. If the agent writes a message after the error and then makes no more calls, that does not count as unhandled. A false "done" in that message is caught by `unproven_completion` instead.
- Retries inside a tool, or retries done automatically by an SDK. The OTel spec puts those inside one span, so they don't show in the trace.
- Tokens the trace doesn't record. There is no estimate, so a trace without usage gets no context curve and no totals.
- Anything outside one trace. There is no cross-task view: no memory that forgets between sessions, and no daily bill. Per-day figures are one trace times N.
- Multi-agent traces. Steps from sub-agents are flattened into one list, so their tool calls are pooled.
- Other trace schemas, such as framework-specific session logs and OpenAI Responses API items. These are rejected rather than guessed at.

---

Independent project by Alex Alvord, CloudLab Works. MIT licence.
