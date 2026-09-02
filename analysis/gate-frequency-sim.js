// Force of Nature — gate-frequency analysis over real hourly data.
// Implements the current ForceOfNature.tos / .pine logic (causal live-edge
// semantics) and measures each gate's pass rate, joint rates, and
// drop-one-out signal counts.

const fs = require("fs");

function loadChart(file) {
  const r = JSON.parse(fs.readFileSync(file)).chart.result[0];
  const q = r.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    if (q.close[i] == null || q.high[i] == null || q.low[i] == null || q.open[i] == null) continue;
    bars.push({ ts: r.timestamp[i], o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] ?? 0 });
  }
  return bars;
}

const dayKey = ts => new Date((ts - 4 * 3600) * 1000).toISOString().slice(0, 10); // ET date (EDT)
function weekKey(dstr) { // ISO week key (Monday-based)
  const d = new Date(dstr + "T00:00:00Z");
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function sma(arr, i, n) {
  if (i + 1 < n) return NaN;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += arr[k];
  return s / n;
}

// symmetric fibScore, exactly as in the scripts
function fibScore(hi, lo, price, tol) {
  if (!isFinite(hi) || !isFinite(lo) || !isFinite(tol)) return 0;
  const rng = hi - lo;
  const f35 = lo + 0.35 * rng, f382 = lo + 0.382 * rng, f50 = lo + 0.5 * rng;
  const f618 = lo + 0.618 * rng, f65 = lo + 0.65 * rng;
  const f127u = hi + 0.272 * rng, f161u = hi + 0.618 * rng;
  const f127d = lo - 0.272 * rng, f161d = lo - 0.618 * rng;
  const inGP = price >= f618 && price <= f65;
  const inBP = price >= f35 && price <= f382;
  let s = 0;
  s += (Math.abs(price - f618) <= tol || inGP) ? 3.5 : 0;
  s += (Math.abs(price - f382) <= tol || inBP) ? 3.5 : 0;
  s += Math.abs(price - f50) <= tol ? 2.5 : 0;
  s += Math.abs(price - f127u) <= tol ? 1.5 : 0;
  s += Math.abs(price - f161u) <= tol ? 1.5 : 0;
  s += Math.abs(price - f127d) <= tol ? 1.5 : 0;
  s += Math.abs(price - f161d) <= tol ? 1.5 : 0;
  return s;
}

function analyze(sym) {
  const H = loadChart(`${sym}_1h.json`);
  const D = loadChart(`${sym}_1d.json`);
  const dailyByKey = new Map(D.map(b => [dayKey(b.ts), b]));
  const dailyKeys = D.map(b => dayKey(b.ts));

  // ---- hourly primitives ----
  const n = H.length;
  const tr = H.map((b, i) => i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - H[i - 1].c), Math.abs(b.l - H[i - 1].c)));
  const atr = H.map((_, i) => sma(tr, i, 14));
  const vols = H.map(b => b.v);
  const volAvg = H.map((_, i) => sma(vols, i, 20));

  // Wilder RSI 14
  const rsi = new Array(n).fill(NaN);
  {
    let au = 0, ad = 0;
    for (let i = 1; i < n; i++) {
      const ch = H[i].c - H[i - 1].c, u = Math.max(ch, 0), d = Math.max(-ch, 0);
      if (i <= 14) { au += u; ad += d; if (i === 14) { au /= 14; ad /= 14; rsi[i] = 100 - 100 / (1 + au / ad); } }
      else { au = (au * 13 + u) / 14; ad = (ad * 13 + d) / 14; rsi[i] = ad === 0 ? 100 : 100 - 100 / (1 + au / ad); }
    }
  }

  // ---- state (built bar by bar, causal) ----
  let swingDir = 0, lastSH = NaN, lastSL = NaN, lastSHbar = NaN, lastSLbar = NaN;
  let cumPV = NaN, cumV = NaN, anchorBar = NaN;
  let swLoP = NaN, swLoR = NaN, pSwLoP = NaN, pSwLoR = NaN;
  let swHiP = NaN, swHiR = NaN, pSwHiP = NaN, pSwHiR = NaN;

  // 4h buckets from RTH hourly (bars 0-3 and 4-6 of each day)
  const bkt = []; // {hi, lo}
  let curDay = null, dayBarIdx = 0;

  const rows = [];
  for (let i = 0; i < n; i++) {
    const b = H[i], dk = dayKey(b.ts);
    if (dk !== curDay) { curDay = dk; dayBarIdx = 0; } else dayBarIdx++;
    const newBkt = dayBarIdx === 0 || dayBarIdx === 4;
    if (newBkt) bkt.push({ hi: b.h, lo: b.l });
    else { const t = bkt[bkt.length - 1]; t.hi = Math.max(t.hi, b.h); t.lo = Math.min(t.lo, b.l); }

    // chart pivots (confirm at i, pivot bar i-5, 11-bar window, ties allowed)
    let ph = NaN, pl = NaN;
    if (i >= 10 && isFinite(atr[i])) {
      const win = H.slice(i - 10, i + 1);
      const hs = win.map(x => x.h), ls = win.map(x => x.l);
      const cH = H[i - 5].h, cL = H[i - 5].l;
      if (cH === Math.max(...hs) && (cH - Math.min(...hs)) >= atr[i] * 1.5) ph = cH;
      if (cL === Math.min(...ls) && (Math.max(...ls) - cL) >= atr[i] * 1.5) pl = cL;
    }
    // divergence trackers use RAW pivots
    if (isFinite(pl)) { pSwLoP = swLoP; pSwLoR = swLoR; swLoP = pl; swLoR = rsi[i - 5]; }
    if (isFinite(ph)) { pSwHiP = swHiP; pSwHiR = swHiR; swHiP = ph; swHiR = rsi[i - 5]; }
    // alternation for the leg pair
    const accH = isFinite(ph) && (swingDir !== 1 || !isFinite(lastSH) || ph >= lastSH);
    const accL = isFinite(pl) && (swingDir !== -1 || !isFinite(lastSL) || pl <= lastSL);
    if (accH) { lastSH = ph; lastSHbar = i - 5; }
    if (accL) { lastSL = pl; lastSLbar = i - 5; }
    if (accH && !accL) swingDir = 1; else if (accL && !accH) swingDir = -1;

    const ready = isFinite(lastSHbar) && isFinite(lastSLbar);
    const lastBar = ready ? Math.max(lastSHbar, lastSLbar) : NaN;
    const prevBar = ready ? Math.min(lastSHbar, lastSLbar) : NaN;
    const isUp = ready && lastSHbar > lastSLbar;

    // anchored VWAP (seed with last 6 bars on new anchor)
    if (ready && (!isFinite(anchorBar) || lastBar !== anchorBar)) {
      anchorBar = lastBar; cumPV = 0; cumV = 0;
      for (let k = Math.max(0, i - 5); k <= i; k++) { cumPV += H[k].c * H[k].v; cumV += H[k].v; }
    } else if (isFinite(anchorBar)) { cumPV += b.c * b.v; cumV += b.v; }
    const avwap = isFinite(cumV) && cumV !== 0 ? cumPV / cumV : NaN;

    // ---- grids (live-edge causal: developing period uses data so far) ----
    const tolFloor = atr[i] * 0.15;
    const look = (arr, m, f) => { const s = arr.slice(Math.max(0, arr.length - m)); return s.length < m ? NaN : Math[f](...s); };
    const h1h = look(H.slice(0, i + 1).map(x => x.h), 24, "max");
    const l1h = look(H.slice(0, i + 1).map(x => x.l), 24, "min");
    const h4h = look(bkt.map(x => x.hi), 30, "max");
    const l4h = look(bkt.map(x => x.lo), 30, "min");

    // daily: 19 prior finals + today developing
    const di = dailyKeys.indexOf(dk);
    let hD = NaN, lD = NaN, hW = NaN, lW = NaN, ema = NaN;
    if (di >= 21) {
      let hh = -Infinity, ll = Infinity;
      for (let k = di - 19; k < di; k++) { hh = Math.max(hh, D[k].h); ll = Math.min(ll, D[k].l); }
      // today's developing range from hourly bars so far
      let th = -Infinity, tl = Infinity;
      for (let k = i; k >= 0 && dayKey(H[k].ts) === dk; k--) { th = Math.max(th, H[k].h); tl = Math.min(tl, H[k].l); }
      hD = Math.max(hh, th); lD = Math.min(ll, tl);
      // weekly: 12 prior final weeks + current developing week
      const weeks = new Map();
      for (let k = 0; k <= di - 1; k++) {
        const wk = weekKey(dailyKeys[k]);
        const w = weeks.get(wk) || { hi: -Infinity, lo: Infinity };
        w.hi = Math.max(w.hi, D[k].h); w.lo = Math.min(w.lo, D[k].l);
        weeks.set(wk, w);
      }
      const cwk = weekKey(dk);
      const cw = weeks.get(cwk) || { hi: -Infinity, lo: Infinity };
      cw.hi = Math.max(cw.hi, th); cw.lo = Math.min(cw.lo, tl);
      weeks.set(cwk, cw);
      const wlist = [...weeks.values()];
      if (wlist.length >= 13) {
        const w13 = wlist.slice(-13);
        hW = Math.max(...w13.map(x => x.hi)); lW = Math.min(...w13.map(x => x.lo));
      }
      // daily EMA21 through yesterday + developing step with current price
      const k0 = 20;
      let e = 0;
      for (let k = 0; k <= k0; k++) e += D[k].c;
      e /= 21;
      for (let k = k0 + 1; k < di; k++) e = D[k].c * (2 / 22) + e * (1 - 2 / 22);
      ema = b.c * (2 / 22) + e * (1 - 2 / 22);
    }

    const gt = (hi, lo) => Math.max(tolFloor, (hi - lo) * 0.02);
    const scoreMain = ready ? fibScore(lastSH, lastSL, b.c, gt(lastSH, lastSL)) : 0;
    const s1 = fibScore(h1h, l1h, b.c, gt(h1h, l1h));
    const s4 = fibScore(h4h, l4h, b.c, gt(h4h, l4h));
    const sD = fibScore(hD, lD, b.c, gt(hD, lD));
    const sW = fibScore(hW, lW, b.c, gt(hW, lW));
    const score = scoreMain + s1 + s4 + sD + sW;

    // time windows
    let timeOK = false;
    if (ready) {
      const span = Math.max(lastBar - prevBar, 1);
      const tt = Math.max(2, Math.round(span * 0.05));
      const r2 = x => Math.round(x * 100) / 100;
      const ts_ = [lastBar + r2(span * 0.382), lastBar + r2(span * 0.5), lastBar + r2(span * 0.618), lastBar + span, lastBar + r2(span * 1.618)];
      timeOK = span >= 8 && ts_.some(t => Math.abs(i - t) <= tt);
    }
    const nearAV = isFinite(avwap) && Math.abs(b.c - avwap) <= atr[i] * 0.25;
    let nearFan = false;
    if (ready) {
      const span = Math.max(lastBar - prevBar, 1);
      const slope = (lastSH - lastSL) / span;
      const tolM = gt(lastSH, lastSL);
      for (const r of [0.382, 0.5, 0.618]) {
        const lvl = isUp ? lastSL + slope * r * (i - lastSLbar) : lastSH - slope * r * (i - lastSHbar);
        if (Math.abs(b.c - lvl) <= tolM) nearFan = true;
      }
    }

    const bullPA = i > 0 && b.l < H[i - 1].l && b.c > b.o && b.c > H[i - 1].c && (b.c - b.l) > 0.6 * (b.h - b.l);
    const bearPA = i > 0 && b.h > H[i - 1].h && b.c < b.o && b.c < H[i - 1].c && (b.h - b.c) > 0.6 * (b.h - b.l);
    const volOK = b.v > volAvg[i] * 1.3;
    const bullDiv = isFinite(pSwLoP) && isFinite(swLoR) && isFinite(pSwLoR) && swLoP < pSwLoP && swLoR > pSwLoR;
    const bearDiv = isFinite(pSwHiP) && isFinite(swHiR) && isFinite(pSwHiR) && swHiP > pSwHiP && swHiR < pSwHiR;
    const rsiB = rsi[i] <= 40 || bullDiv;
    const rsiS = rsi[i] >= 60 || bearDiv;
    const trendUp = isFinite(ema) && b.c > ema;
    const trendDn = isFinite(ema) && b.c < ema;

    // reframed RSI: was oversold/overbought within the last 10 bars (or divergence)
    let rMin = Infinity, rMax = -Infinity;
    for (let k = Math.max(0, i - 9); k <= i; k++) { if (isFinite(rsi[k])) { rMin = Math.min(rMin, rsi[k]); rMax = Math.max(rMax, rsi[k]); } }
    const rsiBr = rMin <= 40 || bullDiv;
    const rsiSr = rMax >= 60 || bearDiv;
    rows.push({ i, score, scoreOK: score >= 7.5, timeOK, nearAV, nearFan, bullPA, bearPA, volOK, rsiB, rsiS, rsiBr, rsiSr, trendUp, trendDn, warm: di >= 21 && isFinite(h4h) && ready && isFinite(atr[i]) });
  }
  return rows;
}

// ---------- report ----------
const syms = ["AAPL", "J", "SPY"];
const all = [];
console.log("Per-gate pass rates (% of evaluable 1h bars), by symbol:\n");
const fields = ["scoreOK", "timeOK", "nearAV", "nearFan", "bullPA", "bearPA", "volOK", "rsiB", "rsiS", "trendUp"];
console.log("gate      " + syms.map(s => s.padStart(7)).join(""));
const bySym = {};
for (const s of syms) bySym[s] = analyze(s).filter(r => r.warm);
for (const f of fields) {
  const line = syms.map(s => { const rs = bySym[s]; return (100 * rs.filter(r => r[f]).length / rs.length).toFixed(1).padStart(6) + "%"; }).join("");
  console.log(f.padEnd(10) + line);
}
for (const s of syms) all.push(...bySym[s]);
const N = all.length;
console.log(`\nTotal evaluable bars: ${N} (${syms.map(s => bySym[s].length).join("/")})`);

const pct = arr => q => { const a = [...arr].sort((x, y) => x - y); return a[Math.floor(q * (a.length - 1))]; };
const p = pct(all.map(r => r.score));
console.log(`Score distribution: p50=${p(0.5).toFixed(1)} p75=${p(0.75).toFixed(1)} p90=${p(0.9).toFixed(1)} p95=${p(0.95).toFixed(1)} p99=${p(0.99).toFixed(1)} max=${p(1).toFixed(1)}  (threshold 7.5)`);

const ctx = r => (r.timeOK ? 1 : 0) + (r.nearAV ? 1 : 0) + (r.nearFan ? 1 : 0);
console.log(`Context votes >=2: ${(100 * all.filter(r => ctx(r) >= 2).length / N).toFixed(1)}%  | >=1: ${(100 * all.filter(r => ctx(r) >= 1).length / N).toFixed(1)}%`);

const armedB = r => r.scoreOK && ctx(r) >= 2 && r.rsiB && r.trendUp;
const armedS = r => r.scoreOK && ctx(r) >= 2 && r.rsiS && r.trendDn;
const fullB = r => armedB(r) && r.bullPA && r.volOK;
const fullS = r => armedS(r) && r.bearPA && r.volOK;
console.log(`\nArmed:  bull ${(100 * all.filter(armedB).length / N).toFixed(2)}%  bear ${(100 * all.filter(armedS).length / N).toFixed(2)}%`);
console.log(`Full signals in sample: bull ${all.filter(fullB).length}, bear ${all.filter(fullS).length}  (${N} bars ≈ ${(N / 7 / 21).toFixed(1)} symbol-months)`);

// drop-one-out: signals when one requirement is waived (bull side + bear side)
console.log("\nDrop-one-out signal counts (bull+bear):");
const variants = {
  "none (current)  ": r => fullB(r) || fullS(r),
  "- score gate    ": r => (ctx(r) >= 2 && r.rsiB && r.trendUp && r.bullPA && r.volOK) || (ctx(r) >= 2 && r.rsiS && r.trendDn && r.bearPA && r.volOK),
  "- context votes ": r => (r.scoreOK && r.rsiB && r.trendUp && r.bullPA && r.volOK) || (r.scoreOK && r.rsiS && r.trendDn && r.bearPA && r.volOK),
  "- RSI gate      ": r => (r.scoreOK && ctx(r) >= 2 && r.trendUp && r.bullPA && r.volOK) || (r.scoreOK && ctx(r) >= 2 && r.trendDn && r.bearPA && r.volOK),
  "- trend gate    ": r => (r.scoreOK && ctx(r) >= 2 && r.rsiB && r.bullPA && r.volOK) || (r.scoreOK && ctx(r) >= 2 && r.rsiS && r.bearPA && r.volOK),
  "- volume gate   ": r => (armedB(r) && r.bullPA) || (armedS(r) && r.bearPA),
  "- PA trigger    ": r => (armedB(r) && r.volOK) || (armedS(r) && r.volOK),
};
for (const [k, f] of Object.entries(variants)) console.log(`  ${k}: ${all.filter(f).length}`);

// ---------- funnel: where does the bull chain die? ----------
console.log("\nBull-side funnel (bars surviving each added condition):");
const steps = [
  ["scoreOK (>=7.5)", r => r.scoreOK],
  ["+ trendUp", r => r.scoreOK && r.trendUp],
  ["+ rsiB", r => r.scoreOK && r.trendUp && r.rsiB],
  ["+ ctx>=2", r => r.scoreOK && r.trendUp && r.rsiB && ctx(r) >= 2],
  ["+ PA & vol", fullB],
];
for (const [k, f] of steps) console.log(`  ${k.padEnd(16)}: ${all.filter(f).length}`);

console.log("Same funnel with score >= 7.0 (two-pocket confluence):");
const s7 = r => r.score >= 7.0;
const steps7 = [
  ["score >= 7.0", s7],
  ["+ trendUp", r => s7(r) && r.trendUp],
  ["+ rsiB", r => s7(r) && r.trendUp && r.rsiB],
  ["+ ctx>=2", r => s7(r) && r.trendUp && r.rsiB && ctx(r) >= 2],
  ["+ ctx>=1", r => s7(r) && r.trendUp && r.rsiB && ctx(r) >= 1],
  ["+ PA & vol (ctx>=1)", r => s7(r) && r.trendUp && r.rsiB && ctx(r) >= 1 && r.bullPA && r.volOK],
];
for (const [k, f] of steps7) console.log(`  ${k.padEnd(20)}: ${all.filter(f).length}`);

console.log("\nOrthogonality checks:");
console.log(`  scoreOK & ctx>=2 together: ${all.filter(r => r.scoreOK && ctx(r) >= 2).length} bars (independent expectation ~${(all.filter(r => r.scoreOK).length * all.filter(r => ctx(r) >= 2).length / N).toFixed(1)})`);
console.log(`  score>=7 & ctx>=2 together: ${all.filter(r => s7(r) && ctx(r) >= 2).length} bars (indep ~${(all.filter(s7).length * all.filter(r => ctx(r) >= 2).length / N).toFixed(1)})`);
console.log(`  score>=7 & rsiB together: ${all.filter(r => s7(r) && r.rsiB).length} bars (indep ~${(all.filter(s7).length * all.filter(r => r.rsiB).length / N).toFixed(1)})`);
console.log(`  trigger bar (bullPA & volOK): ${all.filter(r => r.bullPA && r.volOK).length} bars = ${(100 * all.filter(r => r.bullPA && r.volOK).length / N).toFixed(1)}%`);

// tuning landscape: signals under threshold/context/window combinations
console.log("\nTuning landscape (bull+bear signal counts in 7 symbol-months):");
const armedV = (r, thr, minCtx) => (r.score >= thr && ctx(r) >= minCtx && r.rsiB && r.trendUp) || (r.score >= thr && ctx(r) >= minCtx && r.rsiS && r.trendDn);
const sideV = (r, thr, minCtx) => r.score >= thr && ctx(r) >= minCtx && r.rsiB && r.trendUp;
for (const thr of [7.5, 7.0, 6.0]) {
  for (const minCtx of [2, 1]) {
    let sim = 0, win5 = 0;
    for (const s of syms) {
      const rs = bySym[s];
      for (let i = 0; i < rs.length; i++) {
        const r = rs[i];
        const aB = r2 => r2.score >= thr && ctx(r2) >= minCtx && r2.rsiB && r2.trendUp;
        const aS = r2 => r2.score >= thr && ctx(r2) >= minCtx && r2.rsiS && r2.trendDn;
        if ((aB(r) && r.bullPA && r.volOK) || (aS(r) && r.bearPA && r.volOK)) sim++;
        const wb = rs.slice(Math.max(0, i - 5), i + 1).some(aB);
        const ws = rs.slice(Math.max(0, i - 5), i + 1).some(aS);
        if ((wb && r.bullPA && r.volOK) || (ws && r.bearPA && r.volOK)) win5++;
      }
    }
    console.log(`  thr=${thr} ctx>=${minCtx}:  same-bar=${sim}   armed-within-5-bars=${win5}`);
  }
}

// ---------- reframed-RSI funnel and landscape ----------
console.log("\nBull funnel, score>=7.0 + RECENT-oversold RSI (10-bar window):");
const stepsR = [
  ["score >= 7.0", s7],
  ["+ trendUp", r => s7(r) && r.trendUp],
  ["+ rsiB recent", r => s7(r) && r.trendUp && r.rsiBr],
  ["+ ctx>=1", r => s7(r) && r.trendUp && r.rsiBr && ctx(r) >= 1],
  ["+ ctx>=2", r => s7(r) && r.trendUp && r.rsiBr && ctx(r) >= 2],
];
for (const [k, f] of stepsR) console.log(`  ${k.padEnd(16)}: ${all.filter(f).length}`);
console.log(`  (score>=7 & rsiB-recent overlap: ${all.filter(r => s7(r) && r.rsiBr).length} vs indep ~${(all.filter(s7).length * all.filter(r => r.rsiBr).length / N).toFixed(1)} -> now positively correlated)`);

console.log("\nTuning landscape with recent-RSI (bull+bear, 7 symbol-months):");
for (const thr of [7.5, 7.0, 6.0]) {
  for (const minCtx of [2, 1]) {
    let sim = 0, win5 = 0, win5noVol = 0;
    for (const s of syms) {
      const rs = bySym[s];
      for (let i = 0; i < rs.length; i++) {
        const r = rs[i];
        const aB = r2 => r2.score >= thr && ctx(r2) >= minCtx && r2.rsiBr && r2.trendUp;
        const aS = r2 => r2.score >= thr && ctx(r2) >= minCtx && r2.rsiSr && r2.trendDn;
        if ((aB(r) && r.bullPA && r.volOK) || (aS(r) && r.bearPA && r.volOK)) sim++;
        const wb = rs.slice(Math.max(0, i - 5), i + 1).some(aB);
        const ws = rs.slice(Math.max(0, i - 5), i + 1).some(aS);
        if ((wb && r.bullPA && r.volOK) || (ws && r.bearPA && r.volOK)) win5++;
        if ((wb && r.bullPA) || (ws && r.bearPA)) win5noVol++;
      }
    }
    console.log(`  thr=${thr} ctx>=${minCtx}:  same-bar=${sim}   armed-win5=${win5}   armed-win5-noVol=${win5noVol}`);
  }
}

// structural variant: armed within last K bars, then trigger bar accepted
for (const K of [3, 5, 8]) {
  let count = 0;
  for (const s of syms) {
    const rs = bySym[s];
    for (let i = 0; i < rs.length; i++) {
      const wb = rs.slice(Math.max(0, i - K), i + 1).some(armedB);
      const ws = rs.slice(Math.max(0, i - K), i + 1).some(armedS);
      if ((wb && rs[i].bullPA && rs[i].volOK) || (ws && rs[i].bearPA && rs[i].volOK)) count++;
    }
  }
  console.log(`Arm-then-trigger (armed within ${K} bars + trigger): ${count} signals`);
}
