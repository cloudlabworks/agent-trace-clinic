// Expected Clinic findings for a patient trace, derived from the patient's
// ground-truth record only. Nothing here runs a detector.
//
// The patient (agent-trace-clinic-patient) writes, per task, the fault it
// injected and the steps that fault touched, in the Clinic's step numbering.

// Patient fault -> the Clinic detector that names it (null: no finding expected).
export const FAULT_DETECTOR = {
  tool_loop: 'tool_loop',
  retry_storm: 'retry_storm',
  unproven_done: 'unproven_completion',
  context_growth: 'context_growth',
  forgotten_instruction: 'forgotten_instruction',
  clean: null,
};

// Patient fault -> MAST modes (Cemri et al., arXiv:2503.13657v3, Appendix A), where one maps.
export const FAULT_MAST = {
  tool_loop: {
    expected: ['FM-1.3'], also_acceptable: [],
    why: 'The same docs search is repeated with identical arguments after empty results: step repetition.',
  },
  retry_storm: {
    expected: ['FM-1.3'], also_acceptable: [],
    why: 'The identical ticket update is retried after each 503 with no change and no backoff: step repetition.',
  },
  unproven_done: {
    expected: ['FM-3.2'], also_acceptable: ['FM-3.1'],
    why: 'The agent reports the ticket done without the read-back its instructions require: no verification. The task also ends early.',
  },
  forgotten_instruction: {
    expected: ['FM-1.1'], also_acceptable: ['FM-1.4'],
    why: 'The ticket is updated without the label the system prompt requires: disobeys the task specification. The harness removed the instruction from later calls, which is also a loss of history.',
  },
  context_growth: {
    expected: 'none', also_acceptable: [],
    why: 'Untrimmed tool output is a cost and latency problem with no MAST equivalent.',
  },
  clean: { expected: 'none', also_acceptable: [], why: 'Control: no fault injected.' },
};

// truth: one patient ground-truth record. Returns the expected Clinic result.
export function deriveExpected(truth) {
  if (!(truth.fault in FAULT_DETECTOR)) throw new Error(`unknown patient fault ${truth.fault}`);
  const id = FAULT_DETECTOR[truth.fault];
  const ec = truth.expected_clinic || {};
  let steps = [];
  let steps_from;
  if (id === null) {
    steps_from = 'none expected';
  } else if (ec.primary) {
    if (ec.primary !== id) throw new Error(`ground truth names ${ec.primary} for ${truth.fault}, mapping says ${id}`);
    steps = [...ec.steps];
    steps_from = 'expected_clinic.steps';
  } else if (truth.fault === 'forgotten_instruction') {
    // The patient predates this detector: its expected_clinic has no primary, and its
    // steps list the model calls made without the instruction. The violating tool
    // calls are in its notes ("step N: update_ticket without the required label").
    steps = truth.notes.map((n) => /^step (\d+):/.exec(n)).filter(Boolean).map((m) => Number(m[1]));
    steps_from = 'notes';
  } else {
    throw new Error(`no expected steps for ${truth.fault}`);
  }
  return {
    fault: truth.fault,
    task: truth.task_id,
    primary: id === null ? null : { id, steps: steps.sort((a, b) => a - b) },
    steps_from,
    allowed_extra: [...(ec.allowed_extra || [])],
    model_calls: truth.model_calls,
  };
}
