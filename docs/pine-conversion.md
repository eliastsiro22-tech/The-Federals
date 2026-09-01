# Porting Force of Nature to Pine Script (TradingView)

**Verdict: fully feasible.** The study can be ported to a single Pine Script v6 indicator of roughly 180–220 lines. About 90% of the thinkScript maps one-to-one onto Pine built-ins. Three constructs have no direct equivalent and must be *redesigned* rather than translated — and one of those redesigns actually fixes a lookahead bias in the original.

---

## Construct-by-construct mapping

| thinkScript | Pine Script v6 | Difficulty |
|---|---|---|
| `declare upper;` | `indicator("Force of Nature", overlay = true)` | Trivial |
| `input x = yes / 7.5 / AggregationPeriod.DAY` | `input.bool` / `input.float` / `input.timeframe("D")` | Trivial |
| `def` (plain) | Regular variable assignment | Trivial |
| `def x = if c then y else x[1]` (implicit recursion) | `var float x = na` + `x := c ? y : x` | Easy |
| `script getSwingHigh { … }` | User-defined function, or `ta.pivothigh(price, left, right)` + size filter | Easy |
| `Average(TrueRange(h,c,l), 14)` | `ta.sma(ta.tr(true), 14)` — **not** `ta.atr`, which is RMA-smoothed | Easy |
| `RSI(length = 14)` | `ta.rsi(close, 14)` (both Wilder-smoothed — match) | Trivial |
| `ExpAverage(x, 21)` | `ta.ema(x, 21)` | Trivial |
| `high(period = AggregationPeriod.FOUR_HOURS)` | `request.security(syminfo.tickerid, "240", high)` | Moderate — see repainting notes |
| `HighestAll(…)` / `LowestAll(…)` | **No equivalent.** Redesign as running extreme of confirmed pivots (`var` tracking) | **Hard — behavioral change** |
| `Sum(close * volume, barsSince)` (dynamic length) | **Not directly supported.** Redesign as cumulative sums reset at the anchor bar | Moderate |
| `BarNumber()` | `bar_index` (0-based vs 1-based; only differences are used, so no impact) | Trivial |
| `AbsValue` / `Round(x, 1)` / `Max` / `Min` | `math.abs` / `math.round(x, 1)` / `math.max` / `math.min` | Trivial |
| `Highest` / `Lowest` / `lowest(low[1], 6)` | `ta.highest` / `ta.lowest` (offset the source the same way) | Trivial |
| `plot` + `PaintingStrategy.ARROW_UP` | `plotshape(cond, style = shape.triangleup, location = location.belowbar)` | Trivial |
| `SetDefaultColor(Color.CYAN)` etc. | `color = color.aqua` argument | Trivial |
| `AddLabel(…)` dashboard | `table.new(position.top_left, …)` with one cell per gate | Easy |

## The three redesign areas

### 1. `HighestAll` / `LowestAll` — the important one

In thinkScript, `HighestAll(getSwingHigh(hD, 3, 3, …))` scans **every bar loaded on the chart**, including bars to the *right* of the bar being evaluated. Two consequences:

- Historical signals were computed with knowledge of future swing extremes (**lookahead bias** — historical arrows look better than what a live trader saw).
- Pine deliberately has no function that reads future bars, so this cannot be translated literally.

The faithful-to-*intent* port is a **running extreme of confirmed higher-timeframe pivots**:

```pine
// inside request.security(..., "D", ...) — track the highest confirmed daily pivot so far
phD = ta.pivothigh(high, 3, 3)
var float shD = na
shD := not na(phD) ? math.max(nz(shD, phD), phD) : shD
```

This is causally honest (each bar only knows pivots confirmed *by* that bar), which means **historical signals in the Pine version will differ from thinkorswim** — the Pine version is the more trustworthy of the two for backtesting.

### 2. Dynamic-length `Sum` → anchored cumulative VWAP

`Sum(close * volume, barsSince)` uses a window length that changes every bar. Pine's rolling-window functions expect fixed lengths, and the idiomatic Pine pattern is better anyway — cumulative sums reset at the anchor:

```pine
var float cumPV = na
var float cumV  = na
if newSwingAnchor
    cumPV := close * volume
    cumV  := volume
else
    cumPV += close * volume
    cumV  += volume
avwap = cumV != 0 ? cumPV / cumV : na
```

This also avoids thinkScript's practical limit where `Sum` over a very long dynamic window can misbehave far from the anchor.

### 3. Implicit recursion → `var` + `:=`

Every `def x = if c then v else x[1]` becomes a persistent variable:

```pine
var float lastSwingHigh = na
ph = ta.pivothigh(high, 5, 5)
if not na(ph) and (ph - ta.lowest(low, 11)) >= minSizeMain
    lastSwingHigh := ph
    lastSwingHighBar := bar_index - 5
```

Mechanical, low-risk.

## Multi-timeframe & repainting semantics

thinkScript's `high(period = DAY)` and Pine's `request.security` both update intrabar on the live bar. For the port:

- Use `lookahead = barmerge.lookahead_off` (default in v6) — never `lookahead_on`, which would reintroduce lookahead bias.
- Decide whether HTF values use the forming bar (matches thinkorswim live behavior, repaints intrabar) or confirmed bars only (`high[1]` inside the security call — stable, but lags one HTF bar). Recommended: an input toggle.
- The pivot detection should run **inside** the `request.security` call so `left`/`right` counts are in HTF bars, matching the original's intent.

One structural difference: the original sizes HTF pivots with the **chart's** ATR. `request.security` makes it trivial to use each timeframe's own ATR instead — worth exposing as an option, since it makes Stage 2 consistent across chart timeframes.

## What Pine adds for free

- **`alertcondition()` / `alert()`** — push, email, and webhook alerts on Bull/Bear signals (thinkorswim requires a separate scan/alert setup).
- **Strategy conversion** — wrapping the signals in a `strategy()` script gives an instant backtest with equity curve and stats.
- **Publishing** — the indicator can be published (public or invite-only) on TradingView.
- **`ta.pivothigh`/`ta.pivotlow`** are built-in, replacing both helper scripts.

## Expected behavioral differences after porting

| Difference | Cause | Impact |
|---|---|---|
| Historical signals differ from ToS | `HighestAll` lookahead removed | Pine backtests are more realistic |
| HTF swing levels evolve over the chart | Running pivot extremes vs whole-chart scan | Levels tighten as history accumulates |
| Slightly different ATR/EMA warm-up | Different data warm-up and session handling per feed | Minor, edge-of-chart only |
| Volume differs on some symbols | Exchange feed differences (esp. futures/crypto) | Affects the Stage 7 gate marginally |
| Extended-hours handling | ToS aggregation settings vs TradingView session settings | Configure both alike before comparing |

## Suggested port plan

1. Scaffold `indicator()` + all inputs (`input.timeframe` for the HTF trend filter).
2. Port chart-timeframe swing tracking with `ta.pivothigh/pivotlow` + ATR size filter + `var` state.
3. Port `fibScore` as a function; wire the chart-swing grid first and verify scores against ToS on the same symbol/timeframe.
4. Add the four `request.security` swing grids (pivot logic inside the security call, running extremes).
5. Port time windows, anchored VWAP (cumulative pattern), fan rays, PA/volume/RSI/trend gates — all direct translations.
6. Add `plotshape` arrows, AVWAP `plot`, and a `table` dashboard; add `alertcondition` for both signals.
7. Validate side-by-side on the live edge (where ToS and Pine should agree closely), not on deep history (where they legitimately differ).

Estimated effort: one focused session for the port, plus a comparison pass against thinkorswim.
