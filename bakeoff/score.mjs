// Scoring for the bake-off, and the pick rule. Both were written before any model was run.
//
// Over the 14 cases that parse (the 3 'n/a' inputs are skipped):
//   exact          predicted set of modes == expected set; a 'none' case matches only on []
//   overlap        failure cases only (9): predicted set shares at least one expected mode
//   control_fp     'none' cases only (5): the model named any mode
//   off_label      failure cases: modes named outside expected + also_acceptable
//   no_opinion     output the parser could not use (counts as a miss everywhere)
//
// Pick rule: every visitor downloads the model, so size weighs heavily.
//   1. Usable: no_opinion <= 2 of 14 and control_fp <= 1 of 5.
//   2. Among usable models, the smallest download wins unless a larger one beats it by
//      at least 2 cases on overlap (of 9) with no more control false positives.
//   3. If no model is usable, the smallest is still wired, its output stays labelled as
//      model opinion, and the README says it missed the bar.
// n = 14 is a small, synthetic sample: this picks a default, it does not rank models.

export const PICK_RULE = {
  max_no_opinion: 2,
  max_control_fp: 1,
  overlap_margin_to_justify_larger_download: 2,
};

export function score(runs, expected) {
  let exact = 0, overlap = 0, controlFp = 0, offLabel = 0, noOpinion = 0, cases = 0, failureCases = 0, controls = 0;
  const perCase = [];
  for (const r of runs) {
    const e = expected[r.case];
    cases++;
    const want = e.expected === 'none' ? [] : e.expected;
    const ok = new Set([...want, ...e.also_acceptable]);
    const got = r.status === 'ok' ? [...new Set(r.labels.map((l) => l.mode))].sort() : null;
    if (got === null) noOpinion++;
    const isExact = got !== null && got.length === want.length && want.every((m) => got.includes(m));
    if (isExact) exact++;
    let isOverlap = null;
    if (want.length) {
      failureCases++;
      isOverlap = got !== null && got.some((m) => want.includes(m));
      if (isOverlap) overlap++;
      if (got) offLabel += got.filter((m) => !ok.has(m)).length;
    } else {
      controls++;
      if (got !== null && got.length > 0) controlFp++;
    }
    perCase.push({ case: r.case, expected: e.expected, got: got ?? 'no model opinion', exact: isExact, overlap: isOverlap });
  }
  return { cases, exact, failure_cases: failureCases, overlap, controls, control_fp: controlFp, off_label: offLabel, no_opinion: noOpinion, per_case: perCase };
}

export function pick(results) {
  const usable = (r) => r.score.no_opinion <= PICK_RULE.max_no_opinion && r.score.control_fp <= PICK_RULE.max_control_fp;
  const bySize = [...results].sort((a, b) => a.download_bytes - b.download_bytes);
  const pool = bySize.filter(usable);
  if (!pool.length) return { pick: bySize[0], usable: false };
  let best = pool[0];
  for (const r of pool.slice(1)) {
    if (r.score.overlap - best.score.overlap >= PICK_RULE.overlap_margin_to_justify_larger_download && r.score.control_fp <= best.score.control_fp) best = r;
  }
  return { pick: best, usable: true };
}
