import { describe, it, expect } from 'vitest';
import { MAX_MIRROR_COLS, MIRROR_FS_READABLE, mirrorGeometry, BLANK_FRAMES_MAX, CAP_LOOSEN_PX, CHAR_RATIO_DEFAULT, FIT_MAX_PASSES, FIT_W_BUCKET, FS_STEP, MAX_RELAY_ROWS, MIN_RELAY_ROWS, MIRROR_FS_MAX, MIRROR_FS_MIN, bucketWidth, createFitter, fitFontSize, heightBoundFont, nextFit, relayRows, type FitState } from './fitFont';

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
// the fitter fits the width BUCKET (floor to FIT_W_BUCKET) — the oracle for the loop is the bucketed one
const bucketOracle = (availW: number, cols: number, ratio: number, dpr: number) => oracle(bucketWidth(availW), cols, ratio, dpr);

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

describe('createFitter — cancel() disarms a read-back already scheduled', () => {
  // A fit step schedules its read-back for the NEXT paint. A fitter torn down mid-search left that
  // callback alive, so it woke against a terminal its owner had already disposed of — reading
  // .xterm-screen from a detached node and applying a font to a dead xterm. HeadTerminal's effect
  // is keyed on sess?.sid, so teardown-mid-search is a session change, not a rare race.
  const rig = () => {
    const q: Array<() => void> = [];
    const applied: number[] = [];
    const cancelled: number[] = [];
    let painted = 0;
    const fitter = createFitter({
      availW: () => 800, cols: () => 100,
      apply: (v) => { applied.push(v); },
      painted: () => painted,
      raf: (cb) => { q.push(cb); return q.length; },
      cancelRaf: (h) => { cancelled.push(h); },
    });
    return { q, applied, cancelled, fitter, paint: (w: number) => { painted = w; } };
  };

  it('a read-back that lands after cancel() applies nothing', () => {
    const r = rig();
    r.paint(700);
    r.fitter.fit();
    expect(r.q.length).toBe(1);              // one read-back in flight
    const before = r.applied.length;
    r.fitter.cancel();
    r.q.shift()!();                          // the paint arrives anyway — the browser does not care
    expect(r.applied.length).toBe(before);   // …and nothing is applied to the dead terminal
    expect(r.q.length).toBe(0);              // nor is more work scheduled
  });

  it('cancel() uses cancelRaf when the host provides a handle', () => {
    const r = rig();
    r.paint(700);
    r.fitter.fit();
    r.fitter.cancel();
    expect(r.cancelled).toEqual([1]);        // the handle raf returned
  });

  it('a cancelled fitter stays cancelled — a stale timer must not revive it', () => {
    const r = rig();
    r.paint(700);
    r.fitter.fit();
    r.fitter.cancel();
    const before = r.applied.length;
    const queued = r.q.length;               // the rig's cancelRaf RECORDS rather than splices, which
                                             // is the honest model: a frame the browser already
                                             // committed can still fire. What must not happen is NEW
                                             // work being scheduled, or anything being applied.
    r.fitter.fit();                          // e.g. a ResizeObserver that fired during teardown
    expect(r.q.length).toBe(queued);
    expect(r.applied.length).toBe(before);
  });

  it('cancel() is idempotent', () => {
    const r = rig();
    r.fitter.fit();
    r.fitter.cancel();
    expect(() => { r.fitter.cancel(); r.fitter.cancel(); }).not.toThrow();
  });

  it('cancelRaf is optional — a host without it is still correct', () => {
    const q: Array<() => void> = [];
    const applied: number[] = [];
    const f = createFitter({
      availW: () => 800, cols: () => 100,
      apply: (v) => { applied.push(v); },
      painted: () => 700,
      raf: (cb) => { q.push(cb); },          // returns nothing, like the old signature
    });
    f.fit();
    const before = applied.length;
    f.cancel();
    q.shift()!();
    expect(applied.length).toBe(before);
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
      const want = bucketOracle(w, c, r, d);
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
  it('fills a desktop pane: the residual right-hand gap is under one font step (+ the 8px width bucket)', () => {
    const { fs, rendered } = converge(1704, 100, 0.6, 1);   // bucket 1704 → fits 1704 exactly
    expect(fs).toBe(29.75);                    // 29.75 × .6 → 17px cells → 1700; 30 → 18px → 1800 overflows
    expect(rendered).toBe(1700);
    expect(fs).toBeGreaterThan(16);            // the old ceiling would have painted 100 × 9 = 900px into 1700
    // fractional cells (the DOM renderer measured 0.6 × fs, unrounded): the gap is bounded by one step's worth
    const frac = (r: number) => (fs2: number, cols: number) => cols * fs2 * r;
    const q: Array<() => void> = []; let f = 12;
    const fitter = createFitter({ availW: () => 1130, cols: () => 100, apply: (v) => { f = v; }, painted: () => frac(0.6)(f, 100), raf: (cb) => { q.push(cb); } });
    fitter.fit(); while (q.length) q.shift()!();
    expect(1130 - frac(0.6)(f, 100)).toBeLessThanOrEqual(FS_STEP * 0.6 * 100 + FIT_W_BUCKET + 1e-9);   // ≤ 15px + bucket, was 49px at whole-px steps
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
    expect(fs).toBe(bucketOracle(1700, 100, 0.6, 1));
    const before = applies;
    fitter.fit(); fitter.fit();                          // ResizeObserver re-entries at the same geometry
    expect(q.length).toBe(0);
    expect(applies).toBe(before);
    availW = 1703; fitter.fit();                         // a 3px divider nudge stays inside the 8px bucket → no re-key
    expect(q.length).toBe(0);
    expect(applies).toBe(before);
    availW = 850;                                        // 3-wide → the pane halves
    fitter.fit(); while (q.length) q.shift()!();
    expect(fs).toBe(14.75);                              // 100 × floor(14.75×.6)=8 → 800 ≤ 848; 15 → 9 → 900 overflows
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
    expect(fs).toBe(bucketOracle(1200, 100, 0.6, 1));
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
    expect(fs).toBe(bucketOracle(1690, 100, 0.6, 1));
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
  it('pass exhaustion with NOTHING ever measured to fit lands on the floor, never a probe (sweep 2 finding 3)', () => {
    let fs = 12; const q: Array<() => void> = [];
    // always one px over: each pass re-projects a quarter-step down and never fits, so the budget runs out
    // with no `ok` — the fallback must be the floor, not the last (still overflowing) probe
    const fitter = createFitter({ availW: () => 1130, cols: () => 100, apply: (v) => { fs = v; }, painted: () => 1129, raf: (cb) => { q.push(cb); } });
    fitter.fit(); while (q.length) q.shift()!();
    expect(fitter.state().passes).toBe(FIT_MAX_PASSES);
    expect(fitter.state().done).toBe(true);
    expect(fitter.state().ok).toBeUndefined();
    expect(fs).toBe(MIRROR_FS_MIN);
  });
  it('unpainted read-backs (painted 0) do not spend passes and never latch done (sweep 2 finding 4)', () => {
    const paint = renderer(0.6, 1);
    let fs = 12, hidden = true; const q: Array<() => void> = [];
    const fitter = createFitter({ availW: () => 1130, cols: () => 100, apply: (v) => { fs = v; }, painted: () => (hidden ? 0 : paint(fs, 100)), raf: (cb) => { q.push(cb); } });
    fitter.fit();
    for (let i = 0; i < 5; i++) q.shift()!();            // five blank frames
    expect(fitter.state().passes).toBe(0);
    expect(fitter.state().done).toBe(false);
    hidden = false; while (q.length) q.shift()!();       // painted → converges normally
    expect(fitter.state().done).toBe(true);
    expect(fs).toBe(bucketOracle(1130, 100, 0.6, 1));
    // and a host that stays blank past BLANK_FRAMES_MAX stops retrying but is NOT done — a later fit() resumes
    let fs2 = 12, hidden2 = true; const q2: Array<() => void> = [];
    const f2 = createFitter({ availW: () => 1130, cols: () => 100, apply: (v) => { fs2 = v; }, painted: () => (hidden2 ? 0 : paint(fs2, 100)), raf: (cb) => { q2.push(cb); } });
    f2.fit(); let n = 0; while (q2.length && n < 200) { q2.shift()!(); n++; }
    expect(n).toBe(BLANK_FRAMES_MAX);
    expect(f2.state().done).toBe(false);
    expect(f2.state().passes).toBe(0);
    hidden2 = false; f2.fit(); while (q2.length) q2.shift()!();
    expect(f2.state().done).toBe(true);
    expect(fs2).toBe(bucketOracle(1130, 100, 0.6, 1));
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


// ---- Q1wider: the mirror fills the pane (hydra-hq 4e5569) --------------------------------------

describe('mirrorGeometry — Schyler Q1wider: more lines AND no empty strip', () => {
  const CPF = 1.2;                       // cell height per font px, the measured ratio on this box
  it('reproduces his own worked example on a half-width desktop pane', () => {
    // He answered against "about 164x45 instead of 100x28". 161x45 is that number.
    const g = mirrorGeometry(700, 379, CPF)!;
    expect(g.fs).toBe(MIRROR_FS_READABLE);
    expect(g.cols).toBe(161);
    expect(g.rows).toBe(45);
  });

  it('fills the width that today wastes on a short strip', () => {
    // 700x110 today: the height bound pins the font at MIRROR_FS_MIN against 100 pinned cols and
    // leaves 452px — 67% of the pane — blank. merritt's case.
    const g = mirrorGeometry(700, 110, CPF)!;
    expect(700 - g.cols * CHAR_RATIO_DEFAULT * g.fs).toBeLessThan(CHAR_RATIO_DEFAULT * g.fs);
  });

  it('CAPS the columns — a floor bounds the font, nothing else bounds these', () => {
    // A full-width desktop pane fills at 334 cols uncapped. A 334-column head is not "more of what
    // the head is doing", and it reflows that way for every viewer, not just the pane that asked.
    const g = mirrorGeometry(1450, 800, CPF)!;
    expect(g.cols).toBe(MAX_MIRROR_COLS);
    expect(g.cols).toBeLessThan(334);
  });

  it('never asks for more rows than fit — #10 holds through the new path', () => {
    for (const [w, h] of [[700, 379], [700, 110], [1450, 800], [390, 600], [460, 90]]) {
      const g = mirrorGeometry(w, h, CPF)!;
      expect(g.rows * CPF * g.fs).toBeLessThanOrEqual(h);
    }
  });

  it('the readable floor never dips below the absurd-geometry guard', () => {
    // The two constants hold DIFFERENT jobs; this is the one-line relationship, asserted.
    expect(MIRROR_FS_READABLE).toBeGreaterThanOrEqual(MIRROR_FS_MIN);
  });

  it('a viewer tune overrides both numbers — the rung only his device can settle, retired cheaply', () => {
    const g = mirrorGeometry(700, 379, CPF, CHAR_RATIO_DEFAULT, { fs: 10, maxCols: 80 })!;
    expect(g.fs).toBe(10);
    expect(g.cols).toBe(80);
  });

  it('a bad tune falls back to the constants rather than bricking the console', () => {
    // A typo in a query string must not be able to break the terminal for that viewer.
    for (const bad of [{ fs: NaN }, { fs: 0 }, { fs: 999 }, { fs: -7 }] as const) {
      expect(mirrorGeometry(700, 379, CPF, CHAR_RATIO_DEFAULT, bad)!.fs).toBe(MIRROR_FS_READABLE);
    }
    for (const bad of [{ maxCols: NaN }, { maxCols: 3 }, { maxCols: 9999 }] as const) {
      expect(mirrorGeometry(1450, 800, CPF, CHAR_RATIO_DEFAULT, bad)!.cols).toBe(MAX_MIRROR_COLS);
    }
  });

  it('the tune cannot ask for more than the consumer would accept', () => {
    // The relay clamps cols to [20,400]; a tune outside that is refused here rather than silently
    // reshaped one layer down, where the mismatch becomes a re-POST loop.
    expect(mirrorGeometry(9000, 800, CPF, CHAR_RATIO_DEFAULT, { maxCols: 400 })!.cols).toBe(400);
    expect(mirrorGeometry(9000, 800, CPF, CHAR_RATIO_DEFAULT, { maxCols: 401 })!.cols).toBe(MAX_MIRROR_COLS);
  });

  it('refuses to derive geometry from unmeasurable input', () => {
    // A POST built from a mid-layout number is a resize derived from a guess.
    expect(mirrorGeometry(0, 379, CPF)).toBeNull();
    expect(mirrorGeometry(700, 0, CPF)).toBeNull();
    expect(mirrorGeometry(700, 379, 0)).toBeNull();
    expect(mirrorGeometry(700, 379, CPF, 0)).toBeNull();
  });

  it('uses the MEASURED ratio when it has one — a projection over-asks for columns', () => {
    const projected = mirrorGeometry(700, 379, CPF)!;              // CHAR_RATIO_DEFAULT = 0.62
    const measured = mirrorGeometry(700, 379, CPF, 0.70)!;          // a wider real advance
    expect(measured.cols).toBeLessThan(projected.cols);
  });
});


describe('height bound + relay rows — the whole TUI stays on screen, and the mirror never outgrows its pane', () => {
  const CPF = 1.2;   // renderer cell-height per font px (xterm ≈ 1.2)
  // the fitter as HeadTerminal wires it: width fit + height cap for MIN_RELAY_ROWS; rows from the applied font
  const fitPane = (availW: number, availH: number, ratio: number, dpr: number) => {
    const paint = renderer(ratio, dpr);
    let fs = 12; const q: Array<() => void> = [];
    const fitter = createFitter({
      availW: () => availW, cols: () => 100, apply: (v) => { fs = v; }, painted: () => paint(fs, 100), raf: (cb) => { q.push(cb); },
      maxFs: () => heightBoundFont(availH, CPF, MIN_RELAY_ROWS),
    });
    fitter.fit(); while (q.length) q.shift()!();
    expect(fitter.state().done).toBe(true);
    const rows = relayRows(availH, CPF, fs);
    return { fs, rows, painted: paint(fs, 100), mirrorH: rows * CPF * fs };
  };
  it('heightBoundFont: the largest font at which N rows fit', () => {
    expect(heightBoundFont(900, CPF, MIN_RELAY_ROWS)).toBe(31.25);   // 900 / (24 × 1.2) = 31.25
    expect(heightBoundFont(900, CPF, 46)).toBe(16.25);
    expect(heightBoundFont(0, CPF, 24)).toBe(MIRROR_FS_MAX);        // unknown → no bound
    expect(heightBoundFont(900, 0, 24)).toBe(MIRROR_FS_MAX);
  });
  it('relayRows: rows that fit at the APPLIED font, capped — and never more than fit', () => {
    expect(relayRows(900, CPF, 16)).toBe(46);
    expect(relayRows(900, CPF, 28.25)).toBe(26);
    // WAS `toBe(MIN_RELAY_ROWS)` with the comment "the zoom would leave 13 → floor 24". That assertion
    // pinned the defect: 24 rows at 56.5px is 1627px of mirror in a 900px pane. 13 is what fits.
    expect(relayRows(900, CPF, 56.5)).toBe(13);
    expect(relayRows(2000, CPF, 6)).toBe(MAX_RELAY_ROWS);
    expect(MIN_RELAY_ROWS).toBe(24);
  });
  it('MIN_RELAY_ROWS is a floor on IGNORANCE, not on a measurement', () => {
    // Unmeasurable geometry (mid-layout, hidden host, zero-size) still needs a guess, and the old one is
    // the safe one. What it must never do is override a real measurement.
    expect(relayRows(0, CPF, 16)).toBe(MIN_RELAY_ROWS);
    expect(relayRows(900, 0, 16)).toBe(MIN_RELAY_ROWS);
    expect(relayRows(900, CPF, 0)).toBe(MIN_RELAY_ROWS);
  });
  it('a short pane is never asked for rows it cannot show — the mirror never outgrows its pane', () => {
    // THE #7-SWEEP DEFECT (finding 1; hydra-hq e2bbeb → 4e5569). The old floor rested on "the zoom is
    // height-bounded so the floor's rows fit", which holds only until heightBoundFont bottoms out at
    // MIRROR_FS_MIN — i.e. below MIN_RELAY_ROWS × CPF × MIRROR_FS_MIN ≈ 115px, matching the reported
    // "below roughly 120px the mirror renders TALLER than the pane it mirrors".
    for (const availH of [40, 60, 90, 114, 116, 200, 400, 900]) {
      const fs = heightBoundFont(availH, CPF, MIN_RELAY_ROWS);       // the cap the fitter would apply
      const rows = relayRows(availH, CPF, fs);
      expect(rows * CPF * fs).toBeLessThanOrEqual(availH);
    }
    // and concretely, at the pane height that used to break it:
    const fs90 = heightBoundFont(90, CPF, MIN_RELAY_ROWS);
    expect(fs90).toBe(MIRROR_FS_MIN);                                 // the font can shrink no further
    expect(relayRows(90, CPF, fs90)).toBe(18);                        // 18 fit; the old code asked for 24
  });
  it('2-wide desktop (1700×900): width-bound zoom, ~26 rows, mirror fits the pane — nothing clipped', () => {
    const r = fitPane(1700, 900, 0.6, 1);
    expect(r.fs).toBe(bucketOracle(1700, 100, 0.6, 1));              // width is the binding axis
    expect(r.fs).toBeGreaterThan(16);
    expect(r.rows).toBeGreaterThanOrEqual(MIN_RELAY_ROWS);
    expect(r.mirrorH).toBeLessThanOrEqual(900);                      // ALL rows on screen
    expect(r.painted).toBeLessThanOrEqual(1700);
  });
  it('1-wide ultrawide (3400×900): height-bound — the head keeps 24 rows and a right gap remains by design', () => {
    const r = fitPane(3400, 900, 0.6, 1);
    expect(r.fs).toBeLessThanOrEqual(31);                            // cap floor(31.25) = 31, not the 56.5 width fit
    expect(r.rows).toBe(MIN_RELAY_ROWS);
    expect(r.mirrorH).toBeLessThanOrEqual(900);
    expect(r.painted).toBeLessThan(3400);                            // the gap is the pane's aspect, not the fit
    expect(r.fs).toBeGreaterThan(16);                                // still 2× the old cap
  });
  it('3-wide desktop (1130×900) and a phone (380×700): width-bound, rows follow', () => {
    const d = fitPane(1130, 900, 0.6, 1);
    expect(d.fs).toBe(bucketOracle(1130, 100, 0.6, 1));
    expect(d.rows).toBeGreaterThanOrEqual(36);                       // 900 / (1.2 × ~19.5px) ≈ 37
    expect(d.mirrorH).toBeLessThanOrEqual(900);
    const p = fitPane(380, 700, 0.6, 2);
    expect(p.fs).toBe(bucketOracle(380, 100, 0.6, 2));
    expect(p.rows).toBeLessThanOrEqual(MAX_RELAY_ROWS);
    expect(p.mirrorH).toBeLessThanOrEqual(700);
  });
  it('a wobbling non-binding height cap does not re-fit (line-height rounding at small fonts)', () => {
    const paint = renderer(0.6, 2);
    let fs = 12, applies = 0, capNow = 21; const q: Array<() => void> = [];
    const fitter = createFitter({ availW: () => 380, cols: () => 100, apply: (v) => { if (v !== fs) applies++; fs = v; }, painted: () => paint(fs, 100), raf: (cb) => { q.push(cb); }, maxFs: () => capNow });
    fitter.fit(); while (q.length) q.shift()!();
    expect(fitter.state().done).toBe(true);
    const settled = fs, before = applies;
    for (const c of [20, 21, 20, 22, 21]) { capNow = c; fitter.fit(); }   // cap wobbles far above the ~6px font
    expect(q.length).toBe(0);
    expect(applies).toBe(before);
    expect(fs).toBe(settled);
  });
  it('a height cap that comes to bind restarts the search; one that loosens while binding restarts too', () => {
    const paint = renderer(0.6, 1);
    let fs = 12, capNow = 64; const q: Array<() => void> = [];
    const fitter = createFitter({ availW: () => 3400, cols: () => 100, apply: (v) => { fs = v; }, painted: () => paint(fs, 100), raf: (cb) => { q.push(cb); }, maxFs: () => capNow });
    fitter.fit(); while (q.length) q.shift()!();
    expect(fs).toBeGreaterThan(50);                      // width-bound on an ultrawide
    capNow = 31; fitter.fit(); while (q.length) q.shift()!();   // pane got short → cap binds
    expect(fs).toBeLessThanOrEqual(31);
    expect(fitter.state().done).toBe(true);
    capNow = 40; fitter.fit(); while (q.length) q.shift()!();   // pane got taller → cap loosens while binding
    expect(fs).toBeGreaterThan(31);
    expect(fs).toBeLessThanOrEqual(40);
  });
  it('invariant over a geometry grid: mirror fits both axes; a right gap exists ONLY when the height bound binds', () => {
    for (const w of [380, 850, 1130, 1700, 1920, 2540, 3400]) for (const h of [500, 700, 900, 1200]) for (const dpr of [1, 2]) {
      const r = fitPane(w, h, 0.6, dpr);
      expect(r.painted, `overflow-x w=${w} h=${h}`).toBeLessThanOrEqual(w);
      expect(r.mirrorH, `overflow-y w=${w} h=${h}`).toBeLessThanOrEqual(h + 1e-9);
      expect(r.rows).toBeGreaterThanOrEqual(MIN_RELAY_ROWS);
      const widthFit = bucketOracle(w, 100, 0.6, dpr);
      if (r.fs < widthFit) expect(r.rows, `gap without the height bound binding w=${w} h=${h}`).toBe(MIN_RELAY_ROWS);
    }
  });
});

describe('cap hysteresis — a wobbling height bound must not restart the search forever', () => {
  // FINDING 4 (e2bbeb): the coupled maxFs(font) loop had coverage, but NOT the interaction the
  // finding named — CAP_LOOSEN_PX against a cap that moves. The renderer's line-height rounding
  // makes the height bound read N±1 at the bound itself, so the rule is deliberately asymmetric:
  // a cap that DROPS below the font restarts always (otherwise rows overflow off the pane), while
  // a cap that RISES only restarts once it has risen by CAP_LOOSEN_PX — a 1px wobble that
  // restarted would ping-pong 32↔33 for as long as the pane sat at that size.
  // availW is deliberately HUGE so width never binds: these cases are about the HEIGHT cap, and a
  // width-limited fit would settle under the cap and pass every assertion below without the guard
  // existing at all. (First draft used availW 800, which settled at 16 under a cap of 20 — the
  // tests passed for the wrong reason. Kept as a note because it is the easy mistake here.)
  const drive = (capNow: () => number, availW = 40000) => {
    let fs = 12; const q: Array<() => void> = [];
    const fitter = createFitter({
      availW: () => availW, cols: () => 100, apply: (v) => { fs = v; },
      painted: () => fs * 100 * 0.5, raf: (cb) => { q.push(cb); }, maxFs: capNow,
    });
    const pump = () => { fitter.fit(); while (q.length) q.shift()!(); };
    return { pump, state: () => fitter.state(), fs: () => fs };
  };

  it('a cap that DROPS below the font in place restarts — rows must never overflow the pane', () => {
    let cap = 40;
    const d = drive(() => cap);
    d.pump();
    expect(d.state().done).toBe(true);
    const settled = d.fs();
    cap = Math.max(MIRROR_FS_MIN, settled - 1);          // the bound fell UNDER the font in place
    d.pump();
    expect(d.fs()).toBeLessThanOrEqual(cap);
  });

  it('a sub-CAP_LOOSEN_PX wobble at the bound does NOT restart — this is the ping-pong guard', () => {
    let cap = 20;
    const d = drive(() => cap);
    d.pump();
    expect(d.state().done).toBe(true);
    const before = { fs: d.fs(), passes: d.state().passes };
    // rise by strictly less than CAP_LOOSEN_PX, the renderer's own rounding wobble
    cap = 20 + (CAP_LOOSEN_PX - 1);
    d.pump();
    expect(d.state().done).toBe(true);
    expect(d.fs()).toBe(before.fs);
    expect(d.state().passes).toBe(before.passes);        // no restart means no pass was spent
  });

  it('a rise of CAP_LOOSEN_PX or more DOES restart — real new room is taken, not ignored', () => {
    let cap = 20;
    const d = drive(() => cap);
    d.pump();
    const before = d.fs();
    expect(before).toBe(20);                             // the font is sitting ON the cap
    cap = 20 + CAP_LOOSEN_PX;                            // the bound genuinely loosened
    d.pump();
    expect(d.fs()).toBeGreaterThan(before);
  });

  it('a rise while the font is NOT on the cap changes nothing — the cap was never binding', () => {
    // width, not height, is what settles this fit: the font sits well under the cap, so loosening
    // the cap is not news. Keying on it here is what re-fit every frame before the guard existed.
    // the ONLY case here that is width-limited on purpose: 800px / (100 cols * 0.5) settles at 16
    // under a cap of 20, so the font is comfortably off the cap and loosening it is not news.
    let cap = 20;
    const d = drive(() => cap, 800);
    d.pump();
    const before = { fs: d.fs(), passes: d.state().passes };
    expect(before.fs).toBeLessThan(cap);
    cap = cap + CAP_LOOSEN_PX * 4;
    d.pump();
    expect(d.fs()).toBe(before.fs);
    expect(d.state().passes).toBe(before.passes);
  });
});
