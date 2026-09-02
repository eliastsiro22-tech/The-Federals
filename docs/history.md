# Project history — from pasted script to calibrated instrument

This document chronicles the full evolution of Force of Nature: what the file
was when it arrived, every defect found, every design change made, and the
evidence that drove the final calibration. All of it happened across
September 1–2, 2026; commit hashes refer to the `pine-port` branch.

---

## Act 1 — What arrived

The repository began as a single `README.md` with a friend's thinkScript
pasted directly into it (`43172b0`, `4365530`). No source file, no
documentation — just ~230 lines of thinkScript describing an ambitious idea:

> Only signal when price, time, volume, momentum and trend all agree at once.

The original design:

- **Five Fibonacci grids** — chart swing plus 1H/4H/Daily/Weekly — anchored to
  `HighestAll`/`LowestAll` whole-chart extremes, scored with weighted levels
  (golden pocket 3.5, 50% 2.5, 38.2% 2.0, extensions 1.5), threshold 7.5
- **Eight hard gates ANDed on a single bar**: fib score, fib time windows,
  anchored VWAP within 0.12 ATR, fib fan within 0.1 ATR, reversal price
  action, volume > 1.3× average, RSI extreme or divergence, daily-EMA trend

As later discovered, the script as received **had never compiled** — and even
if it had, its logic could essentially never fire live. Its remembered arrows
turned out to be from a *different*, in-development indicator (a
mistaken-identity subplot that consumed a debugging session and, once
resolved, retired the original goal of bit-for-bit parity in favor of a
reasoned redesign).

## Act 2 — Structure and the TradingView port

| Commit | Change |
|---|---|
| `2734192` | Extracted the script into `ForceOfNature.tos`, rewrote the README (pipeline diagrams, stage docs), added a Pine-port feasibility analysis |
| `1895620` | First Pine v6 port — causal redesign of the untranslatable constructs |
| `eafc7f1` | Parity rework: the first port's "improvements" (per-TF pivots/ATR, no lookahead) changed behavior materially, so the port was rebuilt to mirror thinkorswim semantics, including a two-pass emulation of `HighestAll`'s repainting |
| `4c17d12` | Per-gate diagnostics: score/gates in the status line and Data Window, dashboard moved out from under the legend |

## Act 3 — Field debugging on real thinkorswim

Installing on an actual thinkorswim account surfaced defect after defect —
each one invisible until the study met real charts:

| Defect in the original | Symptom | Fix |
|---|---|---|
| `Sum()` called with a per-bar dynamic length — not legal thinkScript | Study name red in Edit Studies; nothing drawn; **the script had never compiled** | `ce1726c` — constant 6-bar re-seed + recursive accumulation (exactly what the Pine port already did) |
| A timeframe with no qualifying swing returns NaN from `HighestAll`; NaN propagates through the summed score | Dashboard `Score: N/A`; every signal silently impossible | `f95305b` — fib score contributes 0 for NaN grids |
| 21-period EMA on 20 days of data → NaN through a *required* gate | Blank `RSI:`/`HTF:` dashboard fields; all signals blocked on short charts | `35040ba` — NaN-guarded trend gate, seeded anchors, warmup-safe divergence |
| Platform constraint: secondary aggregations below the chart timeframe are refused | Study won't run on 2h/4h/daily charts at all (ⓘ icon) | Documented; Pine port disables those grids instead (`Grids: n/5`) |

## Act 4 — The reasoned redesign (Phases 1–4)

With parity retired, every gate was reviewed for *logic quality*:

| Commit | Phase | What changed and why |
|---|---|---|
| `30c3299` | 1 — clear bugs | **RSI divergence rewritten**: the original required RSI to break its 6-bar *high* on the same bar price broke its 6-bar *low* — near-contradictory, never fired (the variable was even named `rsiHL`, "higher low", proving intent). Now measured swing-to-swing. **Trend EMA fixed**: storing `close(period=DAY)` in a `def` flattens it to chart bars, producing a fast pseudo-EMA; now a true daily EMA-21. |
| `9b371fe` | 2 — grids | `HighestAll` whole-chart extremes replaced with **per-timeframe recent ranges** (24×1H, 30×4H, 20×D, 13×W). The old grids all converged to one full-chart range (a golden-pocket touch counted the same level four times ≈ score 14), depended on loaded history depth, and repainted. New grids are distinct, history-independent, non-repainting — which also made the Pine port's repaint-emulation machinery obsolete (deleted, ~40% smaller). |
| `c48cfb9` | 3 — structure | Tolerances got an ATR floor + range-proportional widening (weekly levels earn wider bands); AVWAP band 0.12→0.25 ATR as an input; time windows require a real leg and scale with its span; time/AVWAP/fan became **context votes** instead of a triple-AND of narrow bands. |
| `80d125f` | 4 — polish | **Swing alternation** (the anchor pair is always one real leg); **bearish golden pocket** (0.35–0.382 scores 3.5 like the bullish pocket — shorts were structurally under-weighted) plus downside extensions; **10-bar signal cooldown**; README rewritten. |

## Act 5 — Operationalization

| Commit | Change |
|---|---|
| `2b000de` | Signal triangles bumped to a visible size |
| `b4a6a2b` | Scanning: `Armed bull/bear` plots for TradingView's Pine Screener + a Stock Hacker scan study |
| `365bc12` | The scan rewritten as a lean, recursion-free pre-filter after thinkorswim's scan engine rejected the full logic (`TooComplexException` — scans have a far smaller complexity budget than charts) |
| `980385b` | Combined alert conditions (`FON Any signal`, `FON Armed`) so limited TradingView alert quotas stretch to one slot per symbol |

The resulting workflow: **thinkorswim scans** (free, self-refreshing saved
queries) find armed candidates → the **chart study** grades them → **bar-close
alerts** catch the trigger.

## Act 6 — Measurement and calibration

The user's instinct — *"I think it might be too much filtering"* — prompted a
quantitative audit (`analysis/gate-frequency-sim.js`): every gate
reimplemented over 7 symbol-months of real hourly data (AAPL/J/SPY). Findings
(details in [`../analysis/README.md`](../analysis/README.md)):

- The configuration produced **zero signals**, and removing any single gate
  still produced zero — multiple gates were independently fatal
- Same-bar RSI extremes were **anti-correlated** with price sitting at a fib
  zone (9 joint bars vs ~20 expected under independence)
- The volume-surge gate vetoed **100%** of otherwise-complete signals — on
  hourly bars it measures time of day, not conviction
- Scores quantize in 3.5-point steps; "two pockets agree" = exactly 7.0, so
  the 7.5 threshold sat in a dead zone
- The context trio measured independent of the zones it supposedly confirmed

The retune (`5548f92`), every default backed by a measurement: **arm-then-
trigger** (armed state valid 5 bars, trigger bar completes it), RSI extreme
within 10 bars, threshold 7.0, context 1-of-3, volume advisory. Expected
frequency ~0.5–1 signal per symbol per month on 1h — and the first real
arrows appeared the next day.

## Original vs current, at a glance

| Aspect | As received | Now |
|---|---|---|
| Compiles in thinkorswim | ✗ (dynamic `Sum`) | ✓ |
| Platforms | thinkScript in a README | `.tos` + Pine v6 in lockstep, plus a scan study |
| HTF grids | Whole-chart `HighestAll` (repainting, history-dependent, mutually duplicated) | Per-timeframe recent ranges (non-repainting, distinct) |
| Signal structure | 8 gates ANDed on one bar | Armed state (5-bar window) + trigger bar + cooldown |
| RSI divergence | Inverted, never fired | Swing-to-swing regular divergence |
| Trend filter | Accidental chart-bar pseudo-EMA | True daily EMA-21 |
| Short setups | Structurally under-weighted | Symmetric pockets and extensions |
| NaN behavior | Silently disables everything | Guarded everywhere; dashboard shows warmup |
| Observability | None | Dashboard, status line, per-gate Data Window, alerts |
| Calibration | Guesswork | Measured gate frequencies, reproducible analysis in-repo |
| Signals in practice | Zero (measured) | ~0.5–1 / symbol / month on 1h (measured) |

## What remains unproven

Frequency was measured; **profitability was not**. The forward paper-trading
log — every arrow, its sweep-point invalidation, and the outcome — is the
only evidence that can justify trading this with real money.
