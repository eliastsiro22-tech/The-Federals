# Gate-frequency analysis

`gate-frequency-sim.js` reimplements every Force of Nature gate in plain
JavaScript (causal, live-edge semantics) and measures pass rates, joint
rates, funnels, drop-one-out signal counts, and a tuning landscape over
real hourly data. It is the evidence behind the retune commit: threshold
7.0, recent-RSI window, 1-of-3 context votes, the arm-then-trigger window,
and the volume gate defaulting to advisory.

## Run it

Requires Node.js. Fetch data (any symbols; the script expects
`SYMBOL_1h.json` and `SYMBOL_1d.json` in its working directory, and its
`syms` list edited to match):

```sh
for s in AAPL J SPY; do
  curl -s -H "User-Agent: Mozilla/5.0" "https://query1.finance.yahoo.com/v8/finance/chart/$s?interval=1h&range=3mo" -o "${s}_1h.json"
  curl -s -H "User-Agent: Mozilla/5.0" "https://query1.finance.yahoo.com/v8/finance/chart/$s?interval=1d&range=1y" -o "${s}_1d.json"
done
node gate-frequency-sim.js
```

## Headline findings (AAPL / J / SPY, Jun–Sep 2026, 1,034 hourly bars)

- The pre-retune configuration produced **zero** signals, and removing any
  single gate still produced zero — at least two gates were independently
  fatal.
- Same-bar RSI extremes are **anti-correlated** with price sitting in a fib
  zone (9 joint bars vs ~20 expected): by the time price stabilizes at a
  level, RSI has mean-reverted. A 10-bar lookback flips the correlation
  positive.
- The volume-surge requirement vetoed **100%** of otherwise-complete
  signals — on hourly bars it mostly measures time of day, not conviction.
- Scores are quantized in 3.5-point steps; the natural "two pockets agree"
  state scores exactly 7.0, so the old 7.5 threshold sat in a dead zone.
- The context trio (time/AVWAP/fan) is roughly independent of the fib
  zones — it does not "confirm" them, so requiring 2 of 3 multiplied
  rarity without adding information.
- With the retuned defaults, expected frequency is ~0.5–1 signal per
  symbol per month on 1h charts.

Caveats: 3 symbols, one market regime, frequency measured — **not**
profitability. Forward paper-testing remains the real validation.

## Second pass — trigger-guard calibration (Sep 2)

After the first live arrows (a knife-catch bull on MRVL post-earnings, a
winning AMD short, mixed AAPL/MSFT), `calibration-filters-sim.js` replayed
six symbols (~14 symbol-months) and tested three candidate guards against
the 13 signals the current defaults produce:

- **Trend re-check on the trigger bar** — cost: 1 of 13 signals. The armed
  window let a trigger fire after price had crashed through the trend EMA
  (exactly the MRVL failure). Shipped **on** (folded into the trend gate).
- **Gap stand-down** (block signals against a >3×ATR session gap for 35
  bars) — killed the MRVL-style knife but also killed winning post-gap
  fades (AMD shorts). Shipped as **input, off by default** (`gapGuard`).
- **HTF-grid participation** (daily/weekly grids must contribute ≥ 3.5 to
  arm) — filters to big-structure signals, 13 → 5. Too aggressive to
  default; shipped as **input, off by default** (`requireHTFGrid`) — it is
  the dial for "small-move" signals armed only by the 1H/4H grids.

Session note: signals differ between RTH and extended-hours charts (ATR,
pivots, and volume averages all shift); the analyses here use RTH data.
