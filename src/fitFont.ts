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

/** THE READABLE FLOOR for an interactive mirror — the smallest font we are willing to render, under
 *  which geometry maximises rows. Schyler ruled it (form `tui-mirror-width`, option Q1wider,
 *  2026-09-10): "Widen the head too — more lines AND no empty strip."
 *
 *  WHY A FLOOR AND NOT A TARGET (merritt, gating): once cols follow the font, WIDTH STOPS
 *  CONSTRAINING THE FONT — any font fills the width at the right col count — so "maximise rows"
 *  minimises the font until something stops it. The system drives to this value on its own; a
 *  target would be a second authority over a number geometry already decides, and the two would
 *  need reconciling. It is also why there is no oscillation: the font settles AT the floor rather
 *  than in a POST→grow→re-measure loop.
 *
 *  RATIFIED 2026-09-10 17:48 — and this paragraph used to say the opposite, so the old wording is
 *  kept rather than swapped: it read "THE VALUE IS DERIVED, NOT CHOSEN … nobody picked 7 for its own
 *  sake, and it should be argued rather than inherited." True when written (7 is reproduced from his
 *  own worked example, "about 164×45" on a half-width pane, landing here at 161×45) and false forty
 *  minutes later. He answered ask_4993e9240e81 — `asis — Leave it — 7px, up to 200 columns` —
 *  DECLINING 9px/160, 6px/240, and an explicit "it stutters, back it off", with the per-frame
 *  character counts in front of him (2,800 today · 7,200 asked for · 19,000 allowed · 31,700
 *  uncapped). So do not narrow this on your own judgement: an instruction to argue a number the
 *  owner has already picked from alternatives is an instruction to override a record.
 *  His own fallback is on that card — if it stutters, he says so and we back it off.
 *
 *  IT IS A PERF KNOB AS WELL AS A READABILITY ONE. His primary device is a 2018 A12X iPad
 *  (USER.md); smaller text over more rows is more glyphs composited per frame, and main-thread
 *  cost invisible on our rigs is a real defect on his — the CRT-flicker freeze came from exactly
 *  that. Lowering this number is not free.
 *
 *  RELATIONSHIP, written down so neither constant drifts into the other's job:
 *  MIRROR_FS_READABLE >= MIRROR_FS_MIN. MIRROR_FS_MIN guards ABSURD GEOMETRY; this guards
 *  UNREADABILITY. Different failure modes; one constant must not hold both. */
export const MIRROR_FS_READABLE = 7;

/** Upper bound on the columns the mirror will ask the relay for. A floor bounds the FONT, not the
 *  COLUMNS: at MIRROR_FS_READABLE a full-width desktop pane (1450px) fills at 334 cols.
 *
 *  THE BASIS IS PROSE DENSITY, NOT CODE FIT — and I had that backwards when I gave it, so it is
 *  restated from the measurement rather than from the p95 figure I first quoted (merritt, gating).
 *  Corpus: 74,377 lines across the kit, hq backend + scripts, and the studio's engineer + toolbox.
 *
 *      p50 49 · p90 98 · p95 101 · p99 120 · p99.9 202 · max 1161
 *
 *      window   lines that wrap   rows wasted to wrapping
 *         120        1.10%                 1.279%
 *         140        0.45%                 0.586%
 *         160        0.24%                 0.352%
 *         200        0.12%                 0.192%
 *         334        0.04%                 0.070%
 *
 *  So CODE FIT DOES NOT CHOOSE THIS NUMBER: p99 is 120, ~140 already makes wrapping rare, and going
 *  160 → 200 buys 0.16 percentage points of wasted rows for 25% more cells. On that evidence alone
 *  the answer is 160, and I argued for it. What overrules it is that PROSE REFLOWS: a Claude Code
 *  pane is mostly prose, so 200 shows ~20% more of it per screen than 160 — and content density is
 *  precisely what Schyler asked for ("seeing more of what the head is doing is the point"). A
 *  measured 0.16pp does not outweigh his stated preference; an unmeasured perf hunch does not
 *  either. EXPECTED DIRECTION OF TUNING: narrower, if it stutters on his device — not wider.
 *
 *  AND HE THEN RATIFIED 200 ITSELF (ask_4993e9240e81, 2026-09-10 17:48: `asis — Leave it — 7px, up
 *  to 200 columns`), choosing it over 160 and 240 with the per-frame character counts stated in
 *  plain words. That settles the number without settling the basis: the density argument above is
 *  still what earns 200 over 160 on the evidence, and "narrower if it stutters" is still the
 *  direction — but it is now HIS fallback, offered and declined, not our reservation about his choice.
 *
 *  Heads do NOT cap themselves — and here is exactly which half of that is OBSERVED and which is
 *  EXTRAPOLATED, because I first wrote it as one claim and it is two (hq caught it):
 *    OBSERVED, up to 120 cols. Across six live heads every one renders its longest line to exactly
 *      its pane width (100→100, 120→120). That alone proves little — a full-width rule or box border
 *      also equals the pane width — so hq classified lines as border vs prose across four 120-col
 *      panes: prose maxima 118-120, and 10-53% of prose lines land within 5% of the full width. Prose
 *      really does reflow to the terminal width, with no internal wrap below 120.
 *    EXTRAPOLATED, above 120. Every pane on this box is 100 or 120, so nothing here exercises 200,
 *      let alone 334. A head asked for 334 is EXPECTED to give 334-character measure; it has not been
 *      seen doing it.
 *    WHY THE GAP IS NOT CHEAPLY CLOSED, so the next person does not "measure" a cap that is not there:
 *      capture-pane straight after a resize shows scrollback still hard-wrapped at the OLD width,
 *      because the TUI re-renders only its current frame. A naive resize-and-capture at 200 therefore
 *      reports a 120 ceiling and looks like evidence. It needs fresh prose rendered after the resize.
 *      Schyler's own density form offers 160 and 240, so the 200+ half gets tested where it counts.
 *  (The earlier "side-by-side diffs" clause was mine and I cannot substantiate it — nothing in the
 *  head's render consumes two file widths. Dropped rather than left standing.)
 *
 *  IT DOES NOT PROTECT THE A12X, and must not be read as if it does. Compositing cost scales with
 *  cols × rows:
 *      today         100×28  =  2,800
 *      his example   161×45  =  7,245   2.6×
 *      this cap      200×95  = 19,000   6.8×
 *      uncapped      334×95  = 31,730  11.3×
 *      relay ceiling 400×160 = 64,000  22.9×   (hq_term.py RESIZE_MAX_COLS/ROWS)
 *  200 still permits 6.8× today's cell count. Only a measurement on his own device settles that,
 *  which is what the runtime tune below exists to make cheap.
 *
 *  Tighter than the consumer's own ceiling (400) on purpose — the density basis above is the sentence
 *  that earns the difference; a looser value would be dead code.
 *
 *  AND IT IS NOT A CEILING ON COST: the runtime tune below is bounded to [20, 400] cols and
 *  [MIRROR_FS_MIN, MIRROR_FS_MAX] px, so a viewer who sets `?mirrorFs=4` reaches 200 × 160 = 32,000
 *  cells — the uncapped figure this constant exists to avoid. That is the tune doing its job (its
 *  whole purpose is trying values we cannot measure for him), not a hole; it is written down so
 *  nobody reads the cap as a bound on what the mirror can ever ask for. */
export const MAX_MIRROR_COLS = 200;

/** A viewer-supplied override for the two numbers only Schyler's own device can settle. Both are
 *  currently spelled "a PR, a review and a deploy, per opinion"; this makes trying a pair cost one
 *  reload instead (merritt's proposal, and the honest answer to "our rig is the wrong engine" —
 *  better than promising to test later on hardware no agent here has).
 *
 *  Validated, never trusted: a non-finite or out-of-range value falls back to the constant, because
 *  a typo in a query string must not be able to brick the console. Bounds are the ones the consumer
 *  would clamp to anyway. */
export interface MirrorTune { fs?: number; maxCols?: number }

const tuned = (v: number | undefined, lo: number, hi: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback;
/** Rows assumed when the pane cannot be measured (relayRows), and the row count the height bound is
 *  computed FOR (HeadTerminal's `maxFs`) — a standard terminal is 24. So a pane wide enough that
 *  fit-to-width would leave fewer rows than this is bounded by HEIGHT instead (heightBoundFont) and keeps a
 *  right-hand gap: the pane's aspect, not the fit, is the limit.
 *
 *  NOT a floor on a MEASURED pane. It read "the head's PTY is never driven below this many rows by the
 *  mirror's zoom … (PR #7 review round 2 … a 100×10 head is unusable — this floor is the line between the
 *  two)" until #10 withdrew exactly that: below ~24 × cellPerFs × MIRROR_FS_MIN the font can shrink no
 *  further, so asking for 24 anyway made the mirror TALLER than the pane it mirrors. The 100×10 worry was
 *  real and now lives with the consumer — hydra-hq's relay clamps at RESIZE_MIN_ROWS = 10
 *  (backend/hq_term.py) before it resize-windows the SHARED pane, which is also why the mirror can still
 *  overflow a pane under ~48px. Whether one viewer's collapsed pane may reshape the head for every viewer
 *  is Schyler's open question (hq 4e5569) — do not answer it by quietly reinstating the floor here. */
export const MIN_RELAY_ROWS = 24;
/** Upper bound on rows the relay is ever asked for (unchanged from before). */
export const MAX_RELAY_ROWS = 160;
/** Pane widths are bucketed to this many px for the fit key: a divider drag re-fits every 8px, not every px
 *  (each re-fit is a forced layout read + a full xterm repaint per pass). The fit targets the bucket floor,
 *  so it never exceeds the real width; the residual is < 8px. */
export const FIT_W_BUCKET = 8;
/** A binding height cap must rise by at least this many px before the fit re-runs for it (see createFitter). */
export const CAP_LOOSEN_PX = 2;
/** Read-backs that find nothing painted (host hidden / zero-size mid-layout) are retried up to this many
 *  frames WITHOUT spending a pass, and never latch `done`. */
export const BLANK_FRAMES_MAX = 30;
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
/** The largest font at which `rows` rows fit `availH` px, given the renderer's cell-height per font px.
 *  Unknown geometry (≤ 0) → no bound. */
export const heightBoundFont = (availH: number, cellPerFs: number, rows: number) =>
  availH > 0 && cellPerFs > 0 && rows > 0 ? clamp(quantize(availH / (rows * cellPerFs))) : MIRROR_FS_MAX;

/** Rows the relay should give the head so the mirror fills `availH` at the font ACTUALLY applied — capped at
 *  MAX_RELAY_ROWS and NEVER more than actually fit.
 *
 *  THIS USED TO FLOOR AT MIN_RELAY_ROWS, on the grounds that "the zoom is height-bounded so the floor's rows
 *  fit". That guarantee is real but CONDITIONAL, and the condition is not always met: the bound comes from
 *  heightBoundFont, which clamps at MIRROR_FS_MIN, so once a pane is shorter than
 *  MIN_RELAY_ROWS x cellPerFs x MIRROR_FS_MIN (~115px at the measured ~1.2 cell ratio) the font can no
 *  longer shrink far enough to make 24 rows fit. Asking for 24 anyway made the MIRROR TALLER THAN THE PANE
 *  IT MIRRORS — finding 1 of the #7 sweep (hydra-hq e2bbeb, then 4e5569), and the reported symptom
 *  ("below roughly 120px") lands exactly on that crossover.
 *
 *  Fixed on its own because it is a bug under EITHER answer to the readability question Schyler ruled on:
 *  a pane must never be asked for rows it cannot show, whichever font policy picks the font.
 *
 *  MIN_RELAY_ROWS remains the default when the geometry is UNMEASURABLE (mid-layout, hidden host, zero-size):
 *  a guess is still needed there and the old one is the safe one — it is a floor on IGNORANCE, never on a
 *  measurement. */
export const relayRows = (availH: number, cellPerFs: number, fs: number) =>
  availH > 0 && cellPerFs > 0 && fs > 0
    ? Math.max(1, Math.min(MAX_RELAY_ROWS, Math.floor(availH / (cellPerFs * fs))))
    : MIN_RELAY_ROWS;

/** PURE. The geometry an INTERACTIVE mirror asks the relay for: the head's window sized so the pane
 *  is filled at the readable floor — Schyler's Q1wider, "more lines AND no empty strip".
 *
 *  Both axes follow one font. `ratio` is the MEASURED advance where the caller has one (cell width
 *  ÷ font px, read back from what xterm actually painted) and CHAR_RATIO_DEFAULT before the first
 *  measurement — the same discipline fitFontSize follows, because a projected ratio under-reads the
 *  true advance and would over-ask for columns.
 *
 *  Rows reuse relayRows so there is ONE definition of "rows that fit", including its refusal to ask
 *  for more than the pane can show (#10). Columns are capped at MAX_MIRROR_COLS; the floor bounds
 *  the font and nothing else would bound these.
 *
 *  Unmeasurable geometry returns null — the caller must not POST a resize derived from a guess, and
 *  a guess is exactly what mid-layout numbers are. */
export const mirrorGeometry = (
  availW: number, availH: number, cellPerFs: number, ratio = CHAR_RATIO_DEFAULT,
  tune: MirrorTune = {},
): { fs: number; cols: number; rows: number } | null => {
  if (!(availW > 0) || !(availH > 0) || !(cellPerFs > 0) || !(ratio > 0)) return null;
  const floor = tuned(tune.fs, MIRROR_FS_MIN, MIRROR_FS_MAX, MIRROR_FS_READABLE);
  const capCols = tuned(tune.maxCols, 20, 400, MAX_MIRROR_COLS);
  const fs = clamp(Math.max(floor, MIRROR_FS_MIN));
  const cols = Math.max(20, Math.min(capCols, Math.floor(availW / (ratio * fs))));
  return { fs, cols, rows: relayRows(availH, cellPerFs, fs) };
};

/** Width bucket the fit targets (floor to FIT_W_BUCKET; never above the real width). */
export const bucketWidth = (availW: number) => Math.floor(availW / FIT_W_BUCKET) * FIT_W_BUCKET;

export interface FitterIO {
  /** Width available for cells (host inner width). ≤ 0 → not laid out yet. */
  availW: () => number;
  /** Current column count of the terminal; ≤ 0 while the real count is not yet known (fit waits). */
  cols: () => number;
  /** Set the terminal font (px); must be idempotent. */
  apply: (fs: number) => void;
  /** Width xterm painted for the current cols at the current font (the `.xterm-screen` box); 0 if unpainted. */
  painted: () => number;
  /** Schedule a callback after the next paint (requestAnimationFrame in the browser).
   *  May return the handle; if it does and `cancelRaf` is given, `cancel()` will use it. */
  raf: (cb: () => void) => void | number;
  /** Optional: cancel a handle returned by `raf` (cancelAnimationFrame). The fitter is correct
   *  without this — `cancel()` gates the callback body regardless — but it stops a dead frame
   *  from being scheduled at all. */
  cancelRaf?: (handle: number) => void;
  /** Optional upper bound on the font from another axis (height: heightBoundFont), floored to whole px.
   *  Consulted every step; restarts the search only when it binds. Omit / return ≥ MIRROR_FS_MAX for width-only. */
  maxFs?: () => number;
}

export interface Fitter {
  /** Run one fit step for the current geometry; safe to call on every relayout — a converged geometry is a no-op. */
  fit: () => void;
  /** Stop the loop and disarm any read-back already scheduled.
   *
   *  A fit step schedules work for the NEXT paint, so a fitter torn down mid-search leaves a
   *  callback that wakes up against a terminal its owner has already disposed of — it reads
   *  `.xterm-screen` from a detached node and applies a font to a dead instance. Idempotent, and
   *  once cancelled a fitter stays cancelled: a stale timer must not be able to revive it. */
  cancel: () => void;
  /** Read-only view of the search state. */
  state: () => Readonly<FitState & { key: string; passes: number }>;
}

/**
 * The fit-to-width loop HeadTerminal runs for a mirrored pane: project → apply → (next paint) read back →
 * correct, until the largest non-overflowing font is found (`done`); if FIT_MAX_PASSES is spent first, the
 * largest MEASURED fit (`ok`) is applied, or MIRROR_FS_MIN when nothing ever fit — never an unverified probe. State is keyed on `${availW}x${cols}`: new geometry restarts from the last MEASURED ratio; the
 * relayout the font change itself provokes (host height moves → ResizeObserver) hits the converged key.
 */
export const createFitter = (io: FitterIO): Fitter => {
  let fit: FitState & { key: string; passes: number } = { key: '', fs: 0, ceil: MIRROR_FS_MAX, done: false, passes: 0 };
  let cap = MIRROR_FS_MAX;                             // height bound in force for the current search
  let pending = false;                                 // one read-back in flight at a time
  let dead = false;                                    // cancelled: no new work, and any in-flight read-back is a no-op
  let handle: number | undefined;                      // the scheduled read-back, when io.raf returns one
  let blank = 0;                                       // consecutive unpainted read-backs for this key
  const restart = (key: string, availW: number, cols: number, newCap: number) => {
    cap = newCap;
    fit = { key, fs: fitFontSize(availW, cols, fit.ratio, cap), ok: undefined, ceil: cap, ratio: fit.ratio, done: false, passes: 0 };
    blank = 0;
    io.apply(fit.fs);
  };
  const step = () => {
    if (dead) return;
    const availW = bucketWidth(io.availW());
    const cols = io.cols();
    if (availW <= 0 || cols <= 0) return;              // not laid out / real cols not known yet → nothing to fit
    const newCap = Math.max(MIRROR_FS_MIN, Math.min(MIRROR_FS_MAX, Math.floor(io.maxFs ? io.maxFs() : MIRROR_FS_MAX)));
    const key = `${availW}x${cols}`;
    if (fit.key !== key) restart(key, availW, cols, newCap);
    // The height cap is NOT part of the key: the renderer's line-height rounding makes it wobble by a px
    // (at small fonts where it is nowhere near binding — keying on it re-fit every frame — and at the bound
    // itself, where the cap measured at font N reads N±1). It restarts the search only when it BINDS: it
    // dropped below the font in place (always — otherwise rows overflow), or it rose by ≥ CAP_LOOSEN_PX
    // while the font sat on it (hysteresis: a 1px wobble at the bound must not ping-pong 32↔33 forever).
    else if (newCap < fit.fs || (newCap >= cap + CAP_LOOSEN_PX && fit.fs >= cap)) restart(key, availW, cols, newCap);
    if (fit.done || fit.passes >= FIT_MAX_PASSES || pending) return;
    pending = true;
    const h = io.raf(() => {
      pending = false;
      handle = undefined;
      if (dead) return;                                // torn down between scheduling and paint

      if (fit.key !== key) { step(); return; }         // geometry moved mid-flight → search the CURRENT geometry (never stall)
      const painted = io.painted();
      if (!(painted > 0)) {                            // nothing painted: not a measurement — retry, don't spend a pass, never latch
        if (++blank < BLANK_FRAMES_MAX) step();
        return;
      }
      blank = 0;
      const nx = nextFit({ fs: fit.fs, ok: fit.ok, ceil: fit.ceil, ratio: fit.ratio }, painted, availW, cols);
      fit = { ...fit, ...nx, passes: fit.passes + 1 };
      if (!fit.done && fit.passes >= FIT_MAX_PASSES) {  // budget spent: land on the largest MEASURED fit — or the floor, never a probe
        fit = { ...fit, fs: fit.ok ?? MIRROR_FS_MIN, done: true };
      }
      io.apply(fit.fs);
      if (!fit.done) step();
    });
    if (typeof h === 'number') handle = h;
  };
  const cancel = () => {
    dead = true;
    pending = false;
    if (handle !== undefined && io.cancelRaf) { io.cancelRaf(handle); }
    handle = undefined;
  };
  return { fit: step, cancel, state: () => fit };
};
