---
name: perf-tuning
description: "Make it fast without breaking it: measure first, one change at a time, prove every win"
---
# perf-tuning

Performance work without measurement is guessing with extra steps. Every
change must be justified by a before/after number from the SAME harness.

## Method

1. **Reproduce** — build a repeatable benchmark (real workload, warmed up,
   multiple runs, median + spread). No benchmark, no optimization.
2. **Profile** — find where the time actually goes (CPU profile, flame graph,
   slow-query log, alloc profile). The hot path is usually not where intuition
   says it is. Record the top 3 cost centers with numbers.
3. **Hypothesize** — one sentence: "X dominates because Y; changing Z should
   cut it by ~W." Write it down BEFORE changing code.
4. **Change ONE thing** — the smallest change that tests the hypothesis.
   Re-measure with the identical harness.
5. **Keep or revert** — wins stay with their numbers in the commit message;
   losses revert immediately. A change without a measured win is a loss
   (complexity was added for nothing).

## What to reach for, in order

- Algorithmic: O(n²)→O(n log n) on the measured hot path beats any micro-tweak.
- Caching/memoization: only with an invalidation story — a stale cache is a
  correctness bug wearing a performance costume.
- Batching: N syscalls → 1 (I/O is usually the cost, not computation).
- Lazy work: skip what the current path never reads.
- Only then micro-optimizations, and only on measured hot lines.

## Honesty rules

- Report the harness, the runs, and the spread — not just the best run.
- If the win is inside the noise band, say "no significant change".
- Never trade correctness for speed without saying so explicitly.
- Regression tests stay green through every step; a fast wrong answer is
  still wrong.
