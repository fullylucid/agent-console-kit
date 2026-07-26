// scrollIntent — ONE converter, N input sources (task 055ef0).
//
// Every local way of saying "scroll N lines" on this device — a finger drag, a hardware wheel
// click, a BT trackpad's pixel-delta momentum burst — arrives here in PIXELS, is quantized to whole
// line ticks, and leaves as ONE batched emit per animation frame.
//
// WHY BATCHING IS LOAD-BEARING: an alt-screen TUI has no scrollback, so scrolling is expressed as
// SGR wheel sequences POSTed to the head and replayed through tmux send-keys. Rapid SEPARATE
// single-tick POSTs collapse to roughly ONE effective scroll by the time they get there — that is
// why the touch-drag path was written to batch. A hardware trackpad emits pixel-delta momentum at a
// far higher rate than a finger ever did, so an un-batched wheel path is the same defect with more
// input feeding it.
//
// rAF coalescing IS the momentum-tail damping: a decaying tail's small deltas accumulate into whole
// ticks instead of firing an emit each, and sub-tick residue carries to the next frame rather than
// being emitted or dropped. Residue is never discarded, so N lines of intent produce N lines of
// scroll no matter how the input was chopped up.

export type ScrollIntent = {
  /** feed travel in PIXELS. Positive = content moves up (matches the touch drag's sign). */
  pushPx: (px: number) => void;
  /** convert a real WheelEvent to pixels, honouring deltaMode, and feed it */
  pushWheel: (e: { deltaY: number; deltaMode: number }) => void;
  /** emit any whole ticks immediately (used by tests and teardown; normally the frame does it) */
  flush: () => void;
  /** cancel a pending frame — call on unmount */
  dispose: () => void;
  /** sub-tick travel not yet emitted; exposed so tests can prove nothing is silently dropped */
  residuePx: () => number;
};

export type ScrollIntentOpts = {
  /** px of travel worth one line tick (≈ one line-height gives the proven 1:1 drag feel) */
  linePx?: number;
  /** viewport height, for deltaMode 2 (page) wheels */
  pageHeightPx?: () => number;
  /** ONE call per frame with the whole batch: direction + how many ticks */
  emit: (dir: 'up' | 'down', ticks: number) => void;
  /** injectable for tests; defaults to requestAnimationFrame */
  schedule?: (cb: () => void) => number;
  cancel?: (handle: number) => void;
};

export function createScrollIntent(opts: ScrollIntentOpts): ScrollIntent {
  const linePx = opts.linePx ?? 15;
  const schedule = opts.schedule ?? ((cb) => requestAnimationFrame(cb));
  const cancel = opts.cancel ?? ((h) => cancelAnimationFrame(h));

  let px = 0;        // sub-tick residue, never discarded
  let ticks = 0;     // whole ticks awaiting the next frame
  let raf = 0;

  const flush = () => {
    raf = 0;
    const n = ticks;
    ticks = 0;
    if (n) opts.emit(n > 0 ? 'up' : 'down', Math.abs(n));
  };

  const pushPx = (delta: number) => {
    if (!Number.isFinite(delta) || delta === 0) return;
    px += delta;
    const n = Math.trunc(px / linePx);
    if (n) { px -= n * linePx; ticks += n; }
    if (ticks && !raf) raf = schedule(flush);
  };

  return {
    pushPx,
    pushWheel: (e) => {
      // deltaMode is NOT always 0: 1 = lines, 2 = pages. Treating a line-mode delta as pixels
      // under-scrolls by ~15x, which reads as "the trackpad barely moves it".
      const unit = e.deltaMode === 1 ? linePx : e.deltaMode === 2 ? (opts.pageHeightPx?.() ?? 400) : 1;
      // wheel down (deltaY > 0) scrolls content DOWN — the opposite sign to a downward drag
      pushPx(-e.deltaY * unit);
    },
    flush: () => { if (raf) { cancel(raf); raf = 0; } flush(); },
    dispose: () => { if (raf) { cancel(raf); raf = 0; } px = 0; ticks = 0; },
    residuePx: () => px,
  };
}
