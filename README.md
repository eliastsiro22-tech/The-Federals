<div align="center">

# Force of Nature — IndicatorFON

**A multi-confluence Fibonacci signal engine for thinkorswim and TradingView**

![Platform](https://img.shields.io/badge/platform-thinkorswim%20%2B%20TradingView-2E7D32)
![Language](https://img.shields.io/badge/language-thinkScript%20%2B%20Pine%20v6-1565C0)
![Type](https://img.shields.io/badge/type-chart%20overlay%20study-6A1B9A)
![Signals](https://img.shields.io/badge/signals-rare%20%C2%B7%20high%20conviction-B71C1C)

</div>

Force of Nature is a chart study built around one idea: **a signal is only worth taking when many independent techniques agree at the same price, at the same time.** It scores Fibonacci confluence across five timeframes and demands a reversal bar, volume, momentum, and trend alignment before printing an arrow — by design, signals are rare.

Both platform versions are maintained in lockstep and run identical logic:

- **thinkorswim:** [`ForceOfNature.tos`](ForceOfNature.tos)
- **TradingView (Pine v6):** [`ForceOfNature.pine`](ForceOfNature.pine)
- **Design / port history:** [`docs/pine-conversion.md`](docs/pine-conversion.md)

> This is a redesigned descendant of the original script: several genuine bugs were fixed (a non-compiling `Sum()`, NaN score poisoning, inverted divergence logic, a pseudo-EMA trend filter) and the Fibonacci grids were re-anchored so signals no longer repaint or depend on how much chart history is loaded. The full change history is in the git log; design rationale is in the [docs](docs/pine-conversion.md).

---

## Signal pipeline

The structure separates a multi-bar **armed state** from a one-bar **trigger** — requiring them on the same bar was measured to make signals practically impossible (see [`analysis/`](analysis/)).

```mermaid
flowchart LR
    subgraph ARM["Armed state — all must hold (multi-bar)"]
        direction TB
        A1["Fib confluence score ≥ 7.0<br/>across 5 timeframe grids"]
        A2["RSI at extreme within<br/>last 10 bars, or divergence"]
        A3["HTF trend alignment<br/>daily 21 EMA"]
        A4["Context votes ≥ 1 of 3:<br/>time window · AVWAP · fan"]
    end

    subgraph TRIG["Trigger bar — one-bar event"]
        direction TB
        T1["Reversal price action<br/>sweep + strong close"]
        T2["Volume surge<br/>(optional, off by default)"]
    end

    ARM --> WIN["Armed within<br/>last 5 bars"]
    WIN --> AND(("AND"))
    TRIG --> AND
    AND --> CD["Cooldown ≥ 10 bars"]
    CD -->|bullish side| BULL["▲ Bull signal — cyan"]
    CD -->|bearish side| BEAR["▼ Bear signal — magenta"]
```

---

## Stage-by-stage breakdown

### Stage 1 — Swing detection (chart timeframe)

Fractal pivots (5 bars each side, 1.5×ATR minimum size) with **enforced alternation**: an opposite-side pivot starts a new leg; a same-side pivot only counts if it's more extreme than the current leg extreme. The tracked high/low pair is therefore always one real leg — the anchor for the chart grid, time windows, AVWAP, and fan. Pivots confirm 5 bars after the fact; that lag is inherent to fractal detection.

### Stage 2 — Multi-timeframe Fibonacci confluence (hard gate)

Each timeframe's grid is anchored to its **recent trading range** — the last N bars of that timeframe (defaults: 24×1H, 30×4H, 20 days, 13 weeks) — so the five grids are genuinely distinct, independent of loaded chart history, and non-repainting. Price near a level earns weighted points per grid:

```text
              ── 1.618 extension ───────────   +1.5
              ── 1.272 extension ───────────   +1.5
  range high ═══════════════════════════ 1.000
              ── 0.650 ─┐
                        ├─ GOLDEN POCKET ──    +3.5
              ── 0.618 ─┘
              ── 0.500 ──────────────────      +2.5
              ── 0.382 ─┐
                        ├─ BEAR POCKET ────    +3.5
              ── 0.350 ─┘
  range low  ═══════════════════════════ 0.000
              ── 1.272 extension (down) ──     +1.5
              ── 1.618 extension (down) ──     +1.5
```

The golden pocket and its bearish mirror score equally, so short setups are not structurally under-weighted. Each level's tolerance band has an ATR floor (0.15×) and widens with the grid's range (2%) — a weekly level gets a wider band than a 1-hour level. The summed score must reach **`confluenceThreshold` (7.0)** — exactly "two timeframes' pockets agree" given the 3.5-point weights. (Measured on hourly data, scores are quantized in 3.5 steps; the old 7.5 default sat in a dead zone just above the natural two-pocket cluster.)

### Stage 3 — Context votes: time, AVWAP, fan (≥ 1 of 3 by default)

Three location/timing conditions vote instead of all being mandatory. Gate-frequency measurement showed the trio is roughly *independent* of the fib zones (it doesn't "confirm" them, it's a separate lottery), so demanding 2+ multiplied rarity without adding information — the default is now 1, with the requirement as an input:

- **Fib time window:** the last leg's duration projected forward at 0.382/0.5/0.618/1.0/1.618; the bar must land within a window that scales with leg length (5% of span). Requires a real leg (span ≥ 8 bars).
- **Anchored VWAP:** volume-weighted average price anchored at the last swing; price within 0.25×ATR.
- **Fib fan:** rays from the last swing at 38.2/50/61.8% of the leg's slope; price within the chart grid's tolerance.

### Stage 4 — Reversal price action (trigger bar)

The trigger is accepted while the armed state (Stages 2–3 plus RSI and trend) held at any point within the last **5 bars** (`armedWindowBars`). Setups are multi-bar states; triggers are one-bar events — decoupling them is what makes the signal physically achievable while keeping every condition.

| Side | Requirements |
|---|---|
| **Bull** | New low below prior bar **and** close above open **and** close above prior close **and** close in the **top 40%** of the bar's range |
| **Bear** | New high above prior bar **and** close below open **and** close below prior close **and** close in the **bottom 40%** of the bar's range |

A sweep-and-reclaim hammer for longs; a sweep-and-reject shooting star for shorts.

### Stage 5 — Volume surge (advisory, off by default)

Bar volume above **1.3× the 20-bar average**. **Off by default:** measured over 7 symbol-months of hourly data, this requirement vetoed *every* otherwise-complete signal — on hourly bars the 20-bar volume average mostly encodes time of day (open/close spikes), and pullback-completion bars tend to print on quiet midday tape. Enable `requireVolume` to restore it as a hard gate. Extended-hours bars distort the average — keep that setting consistent when comparing platforms.

### Stage 6 — RSI extreme or divergence (hard gate, toggleable)

RSI(14) at an extreme **within the last 10 bars** (`rsiLookback`) — ≤40 for longs, ≥60 for shorts — **or** a regular divergence measured swing-to-swing: price sets a lower low across the two most recent swing lows while RSI at those same pivots sets a higher low (mirrored for bearish). The lookback window matters: same-bar extremes measured *anti-correlated* with price sitting at a fib zone (by the time price stabilizes at a level, RSI has mean-reverted), which silently killed nearly all setups.

### Stage 7 — Higher-timeframe trend (hard gate, toggleable)

A **true 21-period EMA of the configured higher timeframe** (daily by default), computed on that timeframe's own bars. Longs only above it, shorts only below.

### Stage 8 — Cooldown

After any signal, the study stands down for **10 bars** (input), so one setup produces one arrow instead of a cluster.

---

## Chart output

| Element | Appearance | Meaning |
|---|---|---|
| Bull signal | Cyan up-arrow below the bar | All gates + context votes + cooldown passed, bullish |
| Bear signal | Magenta down-arrow above the bar | Same, bearish |
| AVWAP | Yellow dashed line hugging price | VWAP anchored at the last swing |
| Dashboard | Label (ToS) / table (TV) | Live gate status |

Dashboard fields: `Score` (current confluence total), `Time / AVWAP / Fan` (✓/×  context votes), `RSI` (✓ signal · condition met × not met), `HTF` (▲/▼/─ trend). The TradingView table adds `Grids: n/5` — how many timeframe grids can exist on this chart. The TradingView version also exposes every gate and per-grid score in the **Data Window** (hover any bar to see exactly which condition failed), shows `Score`/`Bull now`/`Bear now` in the status line, and has `alertcondition` hooks for both signals.

---

## Inputs reference

| Input | Default | Description |
|---|---|---|
| `showSignals` | `yes` | Master toggle for the arrows |
| `confluenceThreshold` | `7.0` | Minimum summed Fib score (7.0 = two pockets agree) |
| `toleranceATR` | `0.15` | Level-proximity band floor, in ATRs |
| `toleranceRangePct` | `0.02` | Level band as a fraction of each grid's range |
| `avwapBandATR` | `0.25` | AVWAP proximity band, in ATRs |
| `minContextGates` | `1` | Context votes required (of time / AVWAP / fan) |
| `armedWindowBars` | `5` | Bars the armed state remains valid for a trigger |
| `cooldownBars` | `10` | Bars to stand down after a signal |
| `timeToleranceBars` | `2` | Minimum time-window tolerance |
| `minSwingATR` | `1.5` | Minimum chart swing size, in ATRs |
| `lookback1H / 4H / D / W` | `24 / 30 / 20 / 13` | Bars of each timeframe defining its grid range |
| `requireVolume` / `volumeMult` | `no` / `1.3` | Volume gate (advisory by default — see Stage 5) |
| `requireHTFTrend` / `htfAgg` | `yes` / `DAY` | Trend gate and its timeframe |
| `requireRSI` / `rsiLength` / `rsiLookback` / `rsiOversold` / `rsiOverbought` | `yes` / `14` / `10` / `40` / `60` | RSI gate |
| `showDashboard` / `showAVWAP` | `yes` | Display toggles (TV adds dashboard position) |

---

## Installation

**thinkorswim:** Charts → Studies (flask) → Edit studies… → **Create…** → paste [`ForceOfNature.tos`](ForceOfNature.tos) → name it → OK → Apply. **The chart must be 1 hour or lower** (e.g. `180 D : 1h`) — thinkorswim refuses secondary aggregations below the chart's timeframe, so the 1H grid request errors out on 2h/4h/daily charts (the ⓘ icon in the chart's corner shows the message).

**TradingView:** Pine Editor → paste [`ForceOfNature.pine`](ForceOfNature.pine) → Add to chart. Works on any timeframe — grids below the chart's timeframe are disabled instead of erroring, and the dashboard shows `Grids: n/5`. All five grids are active on charts of 1h or below, matching thinkorswim.

When comparing the two platforms, match the **extended-hours setting** on both — it changes the ATR, volume average, and swing pivots.

---

## Scanning for candidates

Scanning for the *full* signal returns almost nothing — the trigger bar is a one-bar event. The productive workflow is a two-stage funnel: scan for **armed** symbols (score + context votes + RSI + trend all in place, only the trigger bar missing), then set bar-close alerts on the shortlist.

**TradingView (Pine Screener):** save the indicator in the Pine Editor and mark it as a favorite (⭐), then open the **Pine Screener**, pick a watchlist, select *Force of Nature (IndicatorFON)*, set the timeframe (1h recommended), and filter on **`Armed bull` / `Armed bear` = 1** (or `Bull now` / `Bear now` = 1 for fired signals). Requires a paid TradingView plan; re-run on demand.

**thinkorswim (Stock Hacker):** scans forbid secondary aggregations *and* enforce a much smaller complexity budget than charts (`TooComplexException`), so [`ForceOfNature_Scan.tos`](ForceOfNature_Scan.tos) is a deliberately lean, recursion-free pre-filter: three range grids' pocket/50% zone tests (`minZoneHits` of 3 required), RSI extreme, a long-EMA trend proxy, and optionally the trigger bar (`mode = Signal`). Install: Scan tab → Stock Hacker → **Add study filter** → pencil → **thinkScript Editor** tab → paste → set the filter's aggregation to **1h**. Save the scan query and select it in a watchlist gadget for a self-refreshing candidate list. Swing structure, fan, time windows, AVWAP and divergence are *not* in the scan — always confirm hits on the chart study.

## Design notes & caveats

- **Signals are rare by design, but calibrated on evidence** — the armed-state + trigger structure and the default thresholds were tuned by measuring each gate's actual pass rate over 7 symbol-months of hourly data ([`analysis/`](analysis/)); expected frequency is roughly 0.5–1 signal per symbol per month on 1h charts. Use the dashboard/Data Window to see how close conditions are; tighten or loosen `confluenceThreshold`, `minContextGates`, and `requireVolume` to trade frequency for selectivity.
- **Non-repainting by construction:** grids use fixed per-timeframe lookbacks, all other gates are causal, and pivots confirm 5 bars after the fact. Levels still update within the *current* HTF bar (as any HTF-aware indicator does), but a printed arrow never disappears when later bars arrive.
- RSI and EMA warm-up means the first ~20 bars of a chart can't signal; the weekly grid needs 13 weeks of data to be meaningful.
- This is an **analysis tool, not financial advice**. Backtest and paper-trade before risking capital.
