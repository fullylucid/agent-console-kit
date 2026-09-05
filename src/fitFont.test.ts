import { describe, it, expect } from 'vitest';
import { CHAR_RATIO_DEFAULT, FIT_MAX_PASSES, FS_STEP, MIRROR_FS_MAX, MIRROR_FS_MIN, createFitter, fitFontSize, nextFit, type FitState } from './fitFont';

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
});
