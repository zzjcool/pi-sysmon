[English](PLAN-TPS.md) | [简体中文](PLAN-TPS.zh-CN.md)

# Design Record: The Tokens (LLM Throughput) Chart

This document records the design process and rationale for the fourth chart (Tokens) —
from feasibility research and the parallel implementation split, to the problems found by
adversarial review and their fixes.

Original request: "Can we add a chart for token speed — the tps throughput between pi and
the LLM API — so there are four charts by default."

## Research conclusions (two independent research reports, cross-validated; all key facts re-verified)

### Key facts

1. `pi.on("message_update")` fires **on every delta** in the interactive TUI
   (emitted by agent-loop → forwarded by agent-session → received by the extension).
2. **`partial.usage` is unavailable during streaming**: `text_delta` events contain usage
   in 0 places; Anthropic only provides output in the final `message_delta`, and
   OpenAI/Google likewise only in the final chunk.
   ⇒ Per-frame values can only be **estimated from delta text**; exact values are only
   available at `message_end`.
3. `chooseColumns` is currently **hard-capped at 3 columns**; count=4 lays out as 3+1
   (second row holds only 1 block + an empty slot).
   Measured at w=150/200 → cols=3 bands=2 rows=16.
4. Fixing the 4-chart layout only requires changing `chooseColumns`: ≥96 columns → 4
   columns (4×1, 8 rows), 48–95 → 2 columns (2×2, 16 rows), <48 → 1 column. The row
   budget of 18 is always sufficient.

## Decisions

- **TPS on by default** (the user asked for 4 charts by default), disabled with
  `PI_SYSMON_TOKENS=0`.
- Sampling: O(1) accumulation on the event side, reusing the existing 1s interval to roll
  buckets → `hist.tps` ring buffer, reusing `rateAxis`'s 60s window and "top = window
  maximum" semantics.
- Estimator: `ceil(asciiish/4) + cjk` (1 CJK char ≈ 1 token); readouts carry `~` to mark
  them as estimates.
- Count `text_delta + thinking_delta + toolcall_delta`; **never touch** `*_end.content`
  (double counting).
- New module `src/tokens.ts` (pure functions + closure-based meter), unit-testable.

## Work split (different agents in parallel, partitioned by non-overlapping files)

| Owner | Files | Scope |
| --- | --- | --- |
| worker A | `src/tokens.ts`, `test/tokens.test.ts` (**brand-new files**) | estimator + accumulating meter + fmtTps |
| worker B | `src/chart-panel.ts`, `test/layout.test.ts` | `chooseColumns(width, count)` supporting 4 columns |
| main agent | `src/blocks.ts`, `src/index.ts`, remaining tests and docs | integration: History.tps, the 4th block, event wiring |

## Acceptance criteria

- `npm run check` fully green (strict TS: noUncheckedIndexedAccess + noUnusedLocals)
- Both bundle self-checks pass
- **Real pi frame capture**: 4 charts side by side, narrow-width degradation, no overflow
  crashes
- Delivered after adversarial review

---

## Implementation results (completed)

| Owner | Output |
| --- | --- |
| worker A | `src/tokens.ts` + `test/tokens.test.ts` (estimator / meter / fmtTps) |
| worker B | `chooseColumns(width, count)` in `src/chart-panel.ts` supporting 4 columns + 4 layout tests |
| main agent | `src/blocks.ts` (History.tps, tokenAxis, fmtTokensTotal, Tokens block), `src/index.ts` (message_update wiring, meter, stop drain), docs |
| 2 independent review agents | adversarial review: found 2 critical + 3 major, all fixed |

### Real problems found by adversarial review (fixed + regression tests added)

1. **Full-width sweep silently dropped the Tokens block** (critical): `count = showDisks ? 4 : 3`
   was hand-computed, while Tokens is on by default → 4 blocks rendered into a 3-slot grid,
   with the 4th block never indexed.
   This repo's most important crash-defense line (overflow = pi exits) had **never once
   been exercised** against Tokens.
   Changed to `count = blocks.length`, covering all 4 switch combinations × non-zero
   readouts.
2. **`tokenAxis` / `fmtTokensTotal` had zero tests** (critical): the same fixed-width
   constraint as `rateAxis` had no test at all. Added a full-magnitude sweep + unit
   assertions (`KB` must never appear).
3. **Readout vanished entirely on narrow blocks with high TPS** (major): measured
   `~12.3K tok/s` (12 columns) doesn't fit in a 24-column block → only an empty frame
   remained. Switched to the compact format `~12.3Kt/s` (same style as the y-axis ticks).
4. **Double ledger for block count** (critical): `index.ts` hand-computed `blockCount`
   while `buildBlocks` had its own internal `if`s — two independent sources that, when they
   drift, silently draw an incomplete panel. Changed to the single source of truth
   `blocks.length`.
5. **Stop-drain and bad-input defense had zero tests** (major): added meter-level sequence
   tests + tolerance tests for `add(null/undefined/42)`.

### Final acceptance

- `npm run check` fully green, typecheck clean
- Both bundle self-checks pass (including the newly added `tokens.ts` module)
- **Real pi frame capture**: four charts side by side (4×1 at 150 columns), 2×2 at 60
  columns, 1×4 at 40 columns — all working
- **Real LLM streaming verification**: the Tokens chart drew a real curve, and its readout
  corroborated pi's status bar `⚡ t/s (avg)`
- Regression tests **validated by injecting the old behavior** (2 failures with the
  injection, all green after reverting)
