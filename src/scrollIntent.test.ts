import { describe, expect, it } from 'vitest';
import { createScrollIntent } from './scrollIntent';

// The batching contract, asserted without a browser (task 055ef0). These are the properties a
// playwright rig can only demonstrate; here they are proved.
//
// The defect being closed: rapid SEPARATE single-tick POSTs collapse to ~1 effective scroll after
// the relay and tmux send-keys. The touch path batched; the wheel path did not exist at all, so a
// BT trackpad's momentum stream went out one POST per event.

/** a controllable frame clock — nothing here depends on real rAF timing */
function harness(linePx = 15) {
  const emits: Array<{ dir: 'up' | 'down'; ticks: number }> = [];
  let pending: (() => void) | null = null;
  const si = createScrollIntent({
    linePx,
    emit: (dir, ticks) => emits.push({ dir, ticks }),
    schedule: (cb) => { pending = cb; return 1; },
    cancel: () => { pending = null; },
  });
  return { si, emits, frame: () => { const p = pending; pending = null; p?.(); } };
}

describe('one converter, N sources', () => {
  it('batches a momentum burst into ONE emit per frame, not one per event', () => {
    const { si, emits, frame } = harness();
    // a rising burst then a decaying tail — an iPadOS momentum stream, 24 events
    const stream = [4, 9, 16, 22, 26, 24, 20, 16, 13, 10, 8, 6, 5, 4, 3, 3, 2, 2, 1, 1, 1, 1, 1, 1];
    for (const d of stream) si.pushWheel({ deltaY: d, deltaMode: 0 });
    expect(emits).toHaveLength(0);          // nothing escapes before the frame
    frame();
    expect(emits).toHaveLength(1);          // ← the whole point: ONE post, not 24
    const total = stream.reduce((a, b) => a + b, 0);
    expect(emits[0].dir).toBe('down');
    expect(emits[0].ticks).toBe(Math.trunc(total / 15));
  });

  it('loses no intent across frames — residue carries, it is never dropped', () => {
    const { si, emits, frame } = harness();
    // 30 events of 7px = 210px = 14 whole lines, chopped so every event straddles a tick boundary
    for (let i = 0; i < 30; i++) { si.pushWheel({ deltaY: 7, deltaMode: 0 }); if (i % 5 === 4) frame(); }
    si.flush();
    const lines = emits.reduce((a, e) => a + e.ticks, 0);
    expect(lines).toBe(14);                          // 210/15 exactly
    expect(Math.abs(si.residuePx())).toBeLessThan(15);   // only sub-tick travel may remain
  });

  it('never reverses direction within a batch', () => {
    const { si, emits, frame } = harness();
    for (const d of [30, 30, 30]) si.pushWheel({ deltaY: d, deltaMode: 0 });
    frame();
    for (const d of [-30, -30, -30]) si.pushWheel({ deltaY: d, deltaMode: 0 });
    frame();
    expect(emits.map((e) => e.dir)).toEqual(['down', 'up']);
    expect(emits.every((e) => e.ticks > 0)).toBe(true);
  });

  it('cancels cleanly against itself — a jitter that nets to zero emits nothing', () => {
    const { si, emits, frame } = harness();
    for (let i = 0; i < 10; i++) si.pushWheel({ deltaY: i % 2 ? -20 : 20, deltaMode: 0 });
    frame();
    expect(emits).toHaveLength(0);   // oscillating positioning must not fire scroll in both directions
  });
});

describe('deltaMode is not always pixels', () => {
  it('treats a LINE-mode wheel as lines, not as 3 pixels', () => {
    const { si, emits, frame } = harness();
    si.pushWheel({ deltaY: 3, deltaMode: 1 });   // Firefox-style: 3 lines
    frame();
    expect(emits).toEqual([{ dir: 'down', ticks: 3 }]);
  });

  it('treats a PAGE-mode wheel as a viewport height', () => {
    const emits: Array<{ dir: string; ticks: number }> = [];
    // a holder, not a bare `let`: TS narrows a closure-assigned local to `null` at the call site
    const box: { cb: (() => void) | null } = { cb: null };
    const si = createScrollIntent({
      linePx: 15, pageHeightPx: () => 450,
      emit: (dir, ticks) => emits.push({ dir, ticks }),
      schedule: (cb) => { box.cb = cb; return 1; }, cancel: () => { box.cb = null; },
    });
    si.pushWheel({ deltaY: 1, deltaMode: 2 });
    box.cb?.();
    expect(emits).toEqual([{ dir: 'down', ticks: 30 }]);   // 450/15
  });

  it('reads a pixel wheel and a finger drag on the SAME scale', () => {
    const a = harness(); const b = harness();
    a.si.pushWheel({ deltaY: -45, deltaMode: 0 });   // wheel up, 45px
    b.si.pushPx(45);                                  // drag up, 45px
    a.frame(); b.frame();
    expect(a.emits).toEqual(b.emits);                 // one converter ⇒ one feel
  });
});

describe('teardown', () => {
  it('drops a pending frame on dispose rather than emitting after unmount', () => {
    const { si, emits, frame } = harness();
    si.pushWheel({ deltaY: 60, deltaMode: 0 });
    si.dispose();
    frame();
    expect(emits).toHaveLength(0);
  });
});
