import { describe, it, expect } from 'vitest';
import { CHAR_RATIO_DEFAULT, FIT_MAX_PASSES, FS_STEP, MIRROR_FS_MAX, MIRROR_FS_MIN, ROW_PROJECTION_FS_MAX, createFitter, fitFontSize, nextFit, rowProjectionFont, type FitState } from './fitFont';

// A model of xterm's cell rounding: char advance = fs × ratio in CSS px, the cell is floored to whole
// DEVICE pixels, and the screen is cols × cell. Monotonic in fs. (xterm 5.3 DomRenderer: cell.width =
// floor(char.width × dpr) / dpr.)
const renderer = (ratio: number, dpr: number) => (fs: number, cols: number) =>
  cols * (Math.floor(fs * ratio * dpr) / dpr);

// Drive the REAL fitter (the loop HeadTerminal runs) against the model renderer, with a synchronous rAF queue
// standing in for the browser's paint. Returns the settled font, its painted width, and the passes spent.
const converge = (availW: number, cols: number, ratio: number, dpr: number) => {
  const paint = renderer(ratio, dpr);
  let fs = 12;
  const q: Array<() => void> = [];
  const fitter = createFitter({
    availW: () => availW, cols: () => cols,
    apply: (v) => { fs = v; },
    painted: () => paint(fs, cols),
    raf: (cb) => { q.push(cb); },
  });
  fitter.fit();
  for (let i = 0; i < 50 && q.length; i++) q.shift()!();   // each queued read-back may schedule one more
  expect(q.length).toBe(0);
  return { fs, rendered: paint(fs, cols), passes: fitter.state().passes, converged: fitter.state().done === true };
};

// The largest font whose rendered width fits — the answer the loop must find.
const oracle = (availW: number, cols: number, ratio: number, dpr: number) => {
  const paint = renderer(ratio, dpr);
  let best = MIRROR_FS_MIN;
  for (let fs = MIRROR_FS_MIN; fs <= MIRROR_FS_MAX; fs += FS_STEP) if (paint(fs, cols) <= availW) best = fs;
  return best;
};

describe('fitFontSize — the projection', () => {
  it('is no longer capped at 16px: a desktop pane gets the font its width affords', () => {
    // 2-wide on a 3440 ultrawide ≈ 1700px pane, 100 cols → 27px at the default ratio
    expect(fitFontSize(1700, 100)).toBeGreaterThan(16);
    expect(fitFontSize(1700, 100)).toBe(27.25);        // 1700 / 62 = 27.42 → down to the quarter-px step
    expect(fitFontSize(1700, 100)).toBe(Math.floor(1700 / (100 * CHAR_RATIO_DEFAULT) / FS_STEP) * FS_STEP);
  });
  it('still shrinks to a phone', () => {
    expect(fitFontSize(380, 100)).toBe(6);
    expect(fitFontSize(100, 120)).toBe(MIRROR_FS_MIN);
  });
  it('respects the ceiling and a caller-supplied ratio', () => {
    expect(fitFontSize(10000, 100)).toBe(MIRROR_FS_MAX);
    expect(fitFontSize(3400, 100, 0.6)).toBe(56.5);    // 1-wide on a 3440 ultrawide — no longer capped at 16 or 40
    expect(fitFontSize(1200, 100, 0.6)).toBe(20);
    expect(fitFontSize(1200, 100, 0.5)).toBe(24);
  });
});

describe('nextFit — the correction against the rendered width', () => {
  it('lowers the ceiling on overflow and re-projects under it — not done until measured', () => {
    const st = nextFit({ fs: 20, ceil: MIRROR_FS_MAX }, 1300, 1200, 100);
    expect(st.ceil).toBe(19.75);
    expect(st.fs).toBe(18.25);                         // no fit known yet → measured ratio .65 → 1200/65 = 18.46 → 18.25
    expect(st.done).toBe(false);
    expect(st.ratio).toBeCloseTo(0.65);
  });
  it('bisects between the last fit and the new ceiling when one is known', () => {
    const st = nextFit({ fs: 22, ok: 18, ceil: MIRROR_FS_MAX }, 1430, 1200, 100);
    expect(st.ceil).toBe(21.75);
    expect(st.fs).toBe(19.75);                         // quantize((18 + 21.75) / 2)
    expect(st.ok).toBe(18);
  });
  it('is done on overflow when the known fit already sits at the new ceiling', () => {
    const st = nextFit({ fs: 18.25, ok: 18, ceil: 30 }, 1260, 1200, 100);
    expect(st).toMatchObject({ fs: 18, ok: 18, ceil: 18, done: true });
  });
  it('an overflow after a multi-px grow does not stop at an unmeasured size (w=340 c=120 r=.55 case)', () => {
    // fs 7 painted 360 into 340: 6 is unproven (it also paints 360 at dpr 1); the fitter must keep measuring
    const st = nextFit({ fs: 7, ceil: MIRROR_FS_MAX }, 360, 340, 120);
    expect(st.done).toBe(false);
    expect(st.fs).toBeLessThanOrEqual(6.75);
  });
  it('is done at the floor when even the smallest font overflows', () => {
    const st = nextFit({ fs: MIRROR_FS_MIN, ceil: 10 }, 500, 300, 120);
    expect(st).toMatchObject({ fs: MIRROR_FS_MIN, ceil: MIRROR_FS_MIN, done: true });
  });
  it('grows to the measured projection when the render shows slack', () => {
    // fs 16 rendered 992px (ratio .62) into 1700px → real projection is 27
    const st = nextFit({ fs: 16, ceil: MIRROR_FS_MAX }, 992, 1700, 100);
    expect(st.fs).toBe(27.25);
    expect(st.ok).toBe(16);
    expect(st.done).toBe(false);
    expect(st.ratio).toBeCloseTo(0.62);
    // the ceiling closes in: nothing above projection + 2 cell-px (≈3.2 font px at ratio .62) can fit
    expect(st.ceil).toBe(30.5);
  });
  it('never grows past a ceiling learned from an earlier overflow', () => {
    const st = nextFit({ fs: 18, ceil: 19.5 }, 1000, 1700, 100);
    expect(st.fs).toBe(19.5);
  });
  it('bisects the band above when the projection is spent (rounding can still have room)', () => {
    const st = nextFit({ fs: 27.25, ceil: 30.5 }, 1689.5, 1700, 100);   // ratio .62 → projection 27.25 = fs
    expect(st.fs).toBe(28.75);                         // quantize((27.25 + 30.5) / 2)
    expect(st.ok).toBe(27.25);
    expect(st.done).toBe(false);
  });
  it('probes one step up when the band is a single step', () => {
    const st = nextFit({ fs: 27.25, ceil: 27.5 }, 1689.5, 1700, 100);
    expect(st.fs).toBe(27.5);
  });
  it('is done when a measurement at the ceiling fits', () => {
    const st = nextFit({ fs: 27, ceil: 27 }, 1674, 1700, 100);
    expect(st).toMatchObject({ fs: 27, ceil: 27, done: true });
  });
  it('ignores a zero/unpainted measurement', () => {
    const s0: FitState = { fs: 12, ceil: MIRROR_FS_MAX };
    expect(nextFit(s0, 0, 800, 100)).toBe(s0);
  });
});

describe('createFitter — the apply→measure→correct loop', () => {
  const widths = [340, 380, 600, 850, 1130, 1700, 2540, 3400];
  const cols = [80, 100, 120];
  const ratios = [0.55, 0.6, 0.62, 0.65];
  const dprs = [1, 2, 3];
  it('converges within FIT_MAX_PASSES to the LARGEST font that does not overflow, for every grid point', () => {
    let checked = 0;
    for (const w of widths) for (const c of cols) for (const r of ratios) for (const d of dprs) {
      const paint = renderer(r, d);
      const got = converge(w, c, r, d);
      const want = oracle(w, c, r, d);
      expect(got.rendered, `overflow at w=${w} c=${c} r=${r} dpr=${d}`).toBeLessThanOrEqual(w);
      // "largest" is judged by the WIDTH it paints: under device-pixel rounding two adjacent font sizes can
      // share one cell width (fs 8 and 9 both → 4px cells at dpr 1); either fills the pane identically.
      expect(got.rendered, `not the widest fit at w=${w} c=${c} r=${r} dpr=${d}`).toBe(paint(want, c));
      expect(got.fs, `fs ${got.fs} above the largest fit ${want}`).toBeLessThanOrEqual(want);
      expect(got.converged, `did not converge at w=${w} c=${c} r=${r} dpr=${d}`).toBe(true);
      expect(got.passes).toBeLessThanOrEqual(FIT_MAX_PASSES);
      checked++;
    }
    expect(checked).toBe(widths.length * cols.length * ratios.length * dprs.length);
  });
  it('fills a desktop pane: the residual right-hand gap is under one font step', () => {
    const { fs, rendered } = converge(1700, 100, 0.6, 1);
    expect(fs).toBe(29.75);                    // 29.75 × .6 → 17px cells → 1700 exactly; 30 → 18px → 1800 overflows
    expect(rendered).toBe(1700);
    expect(fs).toBeGreaterThan(16);            // the old ceiling would have painted 100 × 9 = 900px into 1700
    // fractional cells (the DOM renderer measured 0.6 × fs, unrounded): the gap is bounded by one step's worth
    const frac = (r: number) => (fs2: number, cols: number) => cols * fs2 * r;
    const q: Array<() => void> = []; let f = 12;
    const fitter = createFitter({ availW: () => 1130, cols: () => 100, apply: (v) => { f = v; }, painted: () => frac(0.6)(f, 100), raf: (cb) => { q.push(cb); } });
    fitter.fit(); while (q.length) q.shift()!();
    expect(1130 - frac(0.6)(f, 100)).toBeLessThanOrEqual(FS_STEP * 0.6 * 100 + 1e-9);   // ≤ 15px, was 49px at whole-px steps
  });
  it('is a no-op on the relayout its own font change provokes, and re-searches when the pane resizes', () => {
    const paint = renderer(0.6, 1);
    let fs = 12, availW = 1700, applies = 0;
    const q: Array<() => void> = [];
    const fitter = createFitter({
      availW: () => availW, cols: () => 100,
      apply: (v) => { if (v !== fs) applies++; fs = v; },
      painted: () => paint(fs, 100),
      raf: (cb) => { q.push(cb); },
    });
    fitter.fit(); while (q.length) q.shift()!();
    expect(fs).toBe(29.75);
    const before = applies;
    fitter.fit(); fitter.fit();                          // ResizeObserver re-entries at the same geometry
    expect(q.length).toBe(0);
    expect(applies).toBe(before);
    availW = 850;                                        // 3-wide → the pane halves
    fitter.fit(); while (q.length) q.shift()!();
    expect(fs).toBe(14.75);                              // 100 × floor(14.75×.6)=8 → 800 ≤ 850; 15 → 9 → 900 overflows
    expect(paint(fs, 100)).toBeLessThanOrEqual(850);
  });
  it('re-keyed mid-flight (finding 2): the in-flight read-back re-enters the search for the CURRENT geometry', () => {
    const paint = renderer(0.6, 1);
    let fs = 12, availW = 1700;
    const q: Array<() => void> = [];
    const fitter = createFitter({ availW: () => availW, cols: () => 100, apply: (v) => { fs = v; }, painted: () => paint(fs, 100), raf: (cb) => { q.push(cb); } });
    fitter.fit();                                        // read-back for 1700 is now in flight
    expect(q.length).toBe(1);
    availW = 1200;                                       // the pane shrinks BEFORE the read-back lands
    fitter.fit();                                        // re-keys, applies the raw projection, returns on `pending`
    expect(q.length).toBe(1);
    while (q.length) q.shift()!();                       // the stale callback must reschedule, not bail
    expect(fitter.state().key).toBe('1200x100');
    expect(fitter.state().done).toBe(true);
    expect(fitter.state().passes).toBeGreaterThan(0);
    expect(paint(fs, 100)).toBeLessThanOrEqual(1200);
    expect(fs).toBe(oracle(1200, 100, 0.6, 1));
  });
  it('re-keyed mid-flight with a stale ratio that under-reads: no overflow is left standing', () => {
    // small font at dpr 1 floors the cell hard (ratio measured ≈ .5 for a true .6) → the carried-over
    // projection for a WIDE pane overshoots by ~20%; the stall would have left that overflow on screen
    const paint = renderer(0.6, 1);
    let fs = 12, availW = 340;
    const q: Array<() => void> = [];
    const fitter = createFitter({ availW: () => availW, cols: () => 100, apply: (v) => { fs = v; }, painted: () => paint(fs, 100), raf: (cb) => { q.push(cb); } });
    fitter.fit(); while (q.length) q.shift()!();         // converge small → ratio measured under flooring
    expect(fitter.state().ratio!).toBeLessThan(0.6);
    fitter.fit();                                        // (no-op: converged)
    availW = 1700; fitter.fit();                         // re-key → projection from the stale ratio
    expect(q.length).toBe(1);
    availW = 1690; fitter.fit();                         // and re-key AGAIN while that read-back is in flight
    while (q.length) q.shift()!();
    expect(fitter.state().done).toBe(true);
    expect(paint(fs, 100)).toBeLessThanOrEqual(1690);
    expect(fs).toBe(oracle(1690, 100, 0.6, 1));
  });
  it('pass exhaustion (finding 1): lands on the largest MEASURED fit, never on a probe', () => {
    // adversarial renderer: every other read-back reports an overflow regardless of font, the rest report
    // a fit with a tiny ratio — the measurement is non-monotone, so bisection cannot settle inside the budget
    let calls = 0;
    const paint = (f: number, cols: number) => { calls++; return calls % 2 === 0 ? cols * f * 2 : cols * f * 0.3; };
    let fs = 12; const q: Array<() => void> = [];
    const fitter = createFitter({ availW: () => 1000, cols: () => 100, apply: (v) => { fs = v; }, painted: () => paint(fs, 100), raf: (cb) => { q.push(cb); } });
    fitter.fit(); while (q.length) q.shift()!();
    const st = fitter.state();
    expect(st.passes).toBe(FIT_MAX_PASSES);
    expect(st.done).toBe(true);
    expect(st.ok).toBeDefined();
    expect(fs).toBe(st.ok);                              // what is on screen is a size that was MEASURED to fit
    expect(fs).toBeLessThan(MIRROR_FS_MAX);              // and not the last (unverified, larger) probe
  });
  it('waits for real column counts (finding 5): cols ≤ 0 applies nothing', () => {
    let applies = 0; const q: Array<() => void> = [];
    const fitter = createFitter({ availW: () => 1700, cols: () => 0, apply: () => { applies++; }, painted: () => 0, raf: (cb) => { q.push(cb); } });
    fitter.fit();
    expect(applies).toBe(0);
    expect(q.length).toBe(0);
    expect(fitter.state().key).toBe('');
  });
});

describe('rowProjectionFont — the relay row count is independent of the zoom (finding 3)', () => {
  const rowsFor = (availH: number, cellPerFs: number, fs: number) => Math.max(10, Math.min(160, Math.floor(availH / (cellPerFs * fs))));
  it('is exactly the pre-zoom projection (16px ceiling) — a 3400px pane keeps its rows', () => {
    const prePR = (availW: number, cols: number) => Math.max(4, Math.min(16, Math.floor(availW / (cols * 0.62))));
    for (const w of [380, 850, 1130, 1700, 2540, 3400]) {
      expect(rowProjectionFont(w, 100)).toBe(prePR(w, 100));
    }
    // a ~900px-tall pane, 1.2 cell-height per font px: 47 rows before; 47 rows now — not 13 at the 56px zoom
    expect(rowsFor(900, 1.2, rowProjectionFont(3400, 100, 0.6))).toBe(rowsFor(900, 1.2, 16));
    expect(rowsFor(900, 1.2, rowProjectionFont(3400, 100, 0.6))).toBe(46);
    expect(rowsFor(900, 1.2, fitFontSize(3400, 100, 0.6))).toBe(13);      // what the zoomed font WOULD have asked for
  });
  it('never exceeds the zoomed font (rows must still fit an un-zoomed mirror)', () => {
    for (const w of [380, 850, 1130]) expect(rowProjectionFont(w, 100)).toBeLessThanOrEqual(fitFontSize(w, 100));
    expect(ROW_PROJECTION_FS_MAX).toBe(16);
  });
});
