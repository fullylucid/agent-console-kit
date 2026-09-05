// fitFont — the pure arithmetic behind HeadTerminal's fit-to-width mirror font.
//
// A mirrored pane must show a head's full TUI (TARGET_MIRROR_COLS wide) with NO horizontal scroll, at the
// LARGEST font that still fits the pane width — on a phone that is ~6px; on a desktop pane it is whatever the
// pane affords (Schyler 2026-09-04: "make it standard to zoom to fit the pane width in tui" — the old 16px
// ceiling + a guessed 0.62 advance ratio left dead space right of every desktop pane).
//
// Two steps, because the advance width of the monospace font is not knowable up front (it depends on which
// fallback face the browser picked, and xterm rounds each cell to whole DEVICE pixels):
//   1. fitFontSize(availW, cols, ratio)  — the projection: floor(availW / (cols × ratio)), clamped.
//   2. nextFit(...)                      — the correction: read the RENDERED screen width back from xterm,
//      derive the true ratio, and either back off (overflow) or grow (slack). A ceiling learned from an
//      overflow is kept (`ceil`) so grow→overflow→grow cannot cycle; the caller resets it when the pane
//      width or col count changes.

export const MIRROR_FS_MIN = 4;
/** Upper bound for the fit-to-width font — one constant, a guard against absurd geometry rather than a
 *  design limit: a 1-wide pane on a 3440 ultrawide fits 100 cols at ~56px and should get it. */
export const MIRROR_FS_MAX = 64;
/** Font sizes move in quarter-px steps — xterm renders fractional sizes (measured: 18.8px → 1128px for 100
 *  cols), and a finer step shrinks the residual right-hand gap from up to one whole-px step (~60px at 100
 *  cols) to ~15px. Quarters are exact in binary, so equality comparisons are safe. */
export const FS_STEP = 0.25;
/** Conservative default advance ratio (cell width ÷ font px) used before the first measurement. */
export const CHAR_RATIO_DEFAULT = 0.62;
/** The font the RELAY row projection is computed from is capped here — the pre-zoom ceiling. Zooming the
 *  mirror's font must never shrink the head's real PTY: rows are what fit the pane at ≤ this font (exactly the
 *  pre-2026-09-04 projection), so a 3400px pane keeps the ~47 rows it had, and the zoomed mirror overflows
 *  the pane vertically (slide) rather than reflowing the head to 100×10. (PR #7 review, finding 3.) */
export const ROW_PROJECTION_FS_MAX = 16;
/** Bound on correction passes per fit — each pass is one rAF; convergence is normally 3–6 (grow, bisect, settle). */
export const FIT_MAX_PASSES = 10;
/** After a grow, the search ceiling is pulled down to the projection + this many cell-px worth of font — the
 *  measured ratio under-reads the true advance by < 1 device px per cell, so no font beyond ~1 cell-px above
 *  the projection can fit; 2 is the proof's slack. Bounds the bisection (and how big a probe can flash). */
const PROBE_BAND_CELL_PX = 2;

const clamp = (fs: number, max = MIRROR_FS_MAX) => Math.max(MIRROR_FS_MIN, Math.min(max, fs));
/** Round DOWN to the font step. */
const quantize = (fs: number) => Math.floor(fs / FS_STEP) * FS_STEP;

/** Project the font that fits `cols` columns into `availW` px at `ratio` (cell width per font px). */
export const fitFontSize = (availW: number, cols: number, ratio = CHAR_RATIO_DEFAULT, max = MIRROR_FS_MAX) =>
  clamp(quantize(availW / (Math.max(1, cols) * ratio)), max);

export interface FitState {
  /** Current font px (a multiple of FS_STEP). */
  fs: number;
  /** Largest font MEASURED to fit so far, once any has. */
  ok?: number;
  /** Highest font not yet known to overflow — lowered when a size overflowed. */
  ceil: number;
  /** Measured advance ratio (cell px per font px), once known. */
  ratio?: number;
  /** True once a measurement at fs === ceil fit — the largest non-overflowing font is in place. */
  done?: boolean;
}

/** Round UP to the font step. */
const quantizeUp = (fs: number) => Math.ceil(fs / FS_STEP) * FS_STEP;
/** A probe strictly inside (lo, hi]: the quantized midpoint, or one step up when they are adjacent. */
const bisect = (lo: number, hi: number) => { const m = quantize((lo + hi) / 2); return m > lo ? m : lo + FS_STEP; };

/**
 * One correction pass. `renderedW` is the width xterm actually painted for `cols` columns at `state.fs`
 * (the `.xterm-screen` element's width). Returns the next state; `done` means converged.
 *  - renderedW > availW  → overflow: ceiling := fs-STEP. Next font = bisect(ok, ceil) if a fit is known, else
 *                          the measured-ratio projection under the ceiling (NOT simply one step down — a grow
 *                          can overshoot by several steps, so the next size down is unproven until measured).
 *                          ok === ceil → ok is the answer. At MIRROR_FS_MIN there is nowhere to go.
 *  - otherwise           → fits: ok := fs; derive the true ratio and grow to the projected size (never above
 *                          `ceil`), pulling `ceil` down to projection + PROBE_BAND (nothing above can fit);
 *                          if the projection has nothing more to give, bisect (fs, ceil] — cell rounding to
 *                          device px makes fonts above the linear projection fit in bands, and a single-step
 *                          walk through a band would burn passes. Done ⇔ fits at the ceiling.
 * Terminates: every overflow lowers `ceil`; every fit raises `fs` or finishes; both move on the STEP grid.
 */
export const nextFit = (state: FitState, renderedW: number, availW: number, cols: number): FitState => {
  const { fs, ok } = state;
  if (!(renderedW > 0) || !(cols > 0) || !(availW > 0)) return state;
  const ratio = renderedW / (cols * fs);
  if (renderedW > availW) {
    if (fs <= MIRROR_FS_MIN) return { fs: MIRROR_FS_MIN, ok, ceil: MIRROR_FS_MIN, ratio, done: true };
    const ceil = fs - FS_STEP;
    if (ok !== undefined && ok >= ceil) return { fs: ok, ok, ceil: ok, ratio, done: true };
    const next = ok !== undefined ? bisect(ok, ceil) : Math.min(ceil, fitFontSize(availW, cols, ratio, ceil));
    return { fs: next, ok, ceil, ratio, done: false };
  }
  const cand = Math.min(state.ceil, fitFontSize(availW, cols, ratio));
  if (cand > fs) {
    const ceil = Math.min(state.ceil, Math.max(cand, quantizeUp(cand + PROBE_BAND_CELL_PX / ratio)));
    return { fs: cand, ok: fs, ceil, ratio, done: false };
  }
  if (fs >= state.ceil) return { fs, ok: fs, ceil: state.ceil, ratio, done: true };
  return { fs: bisect(fs, state.ceil), ok: fs, ceil: state.ceil, ratio, done: false };   // probe the band above
};

/** What the fitter needs from its host — narrow so a test (or a headless probe page) can drive the REAL
 *  loop against a real or fake xterm. */
/** Font to project the relay's ROW count from: the fit-to-width font, capped at ROW_PROJECTION_FS_MAX. Never
 *  above the zoomed font (rows must fit the mirror when it is not zoomed), never driven up by the zoom. */
export const rowProjectionFont = (availW: number, cols: number, ratio = CHAR_RATIO_DEFAULT) =>
  clamp(Math.floor(availW / (Math.max(1, cols) * ratio)), ROW_PROJECTION_FS_MAX);   // whole px: bit-identical to the pre-zoom projection

export interface FitterIO {
  /** Width available for cells (host inner width). ≤ 0 → not laid out yet. */
  availW: () => number;
  /** Current column count of the terminal; ≤ 0 while the real count is not yet known (fit waits). */
  cols: () => number;
  /** Set the terminal font (px); must be idempotent. */
  apply: (fs: number) => void;
  /** Width xterm painted for the current cols at the current font (the `.xterm-screen` box); 0 if unpainted. */
  painted: () => number;
  /** Schedule a callback after the next paint (requestAnimationFrame in the browser). */
  raf: (cb: () => void) => void;
}

export interface Fitter {
  /** Run one fit step for the current geometry; safe to call on every relayout — a converged geometry is a no-op. */
  fit: () => void;
  /** Read-only view of the search state. */
  state: () => Readonly<FitState & { key: string; passes: number }>;
}

/**
 * The fit-to-width loop HeadTerminal runs for a mirrored pane: project → apply → (next paint) read back →
 * correct, until the largest non-overflowing font is found (`done`); if FIT_MAX_PASSES is spent first, the
 * largest MEASURED fit (`ok`) is applied — never an unverified probe. State is keyed on `${availW}x${cols}`: new geometry restarts from the last MEASURED ratio; the
 * relayout the font change itself provokes (host height moves → ResizeObserver) hits the converged key.
 */
export const createFitter = (io: FitterIO): Fitter => {
  let fit: FitState & { key: string; passes: number } = { key: '', fs: 0, ceil: MIRROR_FS_MAX, done: false, passes: 0 };
  let pending = false;                                 // one read-back in flight at a time
  const step = () => {
    const availW = io.availW();
    const cols = io.cols();
    if (availW <= 0 || cols <= 0) return;              // not laid out / real cols not known yet → nothing to fit
    const key = `${availW}x${cols}`;
    if (fit.key !== key) {
      fit = { key, fs: fitFontSize(availW, cols, fit.ratio), ok: undefined, ceil: MIRROR_FS_MAX, ratio: fit.ratio, done: false, passes: 0 };
      io.apply(fit.fs);
    }
    if (fit.done || fit.passes >= FIT_MAX_PASSES || pending) return;
    pending = true;
    io.raf(() => {
      pending = false;
      if (fit.key !== key) { step(); return; }         // geometry moved mid-flight → search the CURRENT geometry (never stall)
      const nx = nextFit({ fs: fit.fs, ok: fit.ok, ceil: fit.ceil, ratio: fit.ratio }, io.painted(), availW, cols);
      fit = { ...fit, ...nx, passes: fit.passes + 1 };
      if (!fit.done && fit.passes >= FIT_MAX_PASSES) {  // budget spent: land on the largest MEASURED fit, never a probe
        fit = { ...fit, fs: fit.ok ?? fit.fs, done: true };
      }
      io.apply(fit.fs);
      if (!fit.done) step();
    });
  };
  return { fit: step, state: () => fit };
};
