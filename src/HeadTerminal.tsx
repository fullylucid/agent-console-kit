import { useEffect, useRef, useState } from 'react';
import { createScrollIntent } from './scrollIntent';
import type { ScrollIntent } from './scrollIntent';
import { Terminal } from 'xterm';
import 'xterm/css/xterm.css';
import { C } from './render/tokens';

// HeadTerminal — the reusable raw-TUI engine (extracted from TerminalPanel so the console head-view
// and the terminal drawer share ONE implementation, no copy-paste). It owns the whole lifecycle for a
// SINGLE target: open a session (a head pane-mirror via /open, or a blank shell via /spawn), stream the
// host relay's RAW PTY BYTES (tmux pipe-pane) over SSE into xterm.js — real cursor, scrollback, ANSI,
// and every interactive TUI element (AskUserQuestion cards, the /model picker, plan prompts, spinners)
// — forward keystrokes LIVE to /input, and tear everything down on swipe-away / unmount.
//
// INPUT MODEL (v0.3 overhaul — kill the dual-box confusion): the terminal is driven LIVE, full stop.
// A single hidden input summons the phone's NATIVE keyboard and forwards every keystroke straight to
// the PTY (letters/numbers via onInput, keys that emit no data — Enter/Backspace/Tab/Esc/arrows — via
// onKeyDown); a slim ACCESSORY key-bar above it supplies only the keys phones lack (Esc/Tab/Ctrl/
// arrows/pipe/^C…), also live. No message composer, no shared draft, no separate on-screen QWERTY —
// composing a MESSAGE is the chat view's Composer, a distinct surface. Identical for pane + shell.
//
// Streaming is gated on `active`: only the on-screen instance opens a session + pipes (demand-gated at
// the relay → off by default for every other head). The client only ever knows the session id; the
// server holds the sid→pane map + re-validates it (no injection). SSO + audit + cap/kill are server-side.

// base64 (a raw-byte SSE chunk) -> Uint8Array for term.write (no utf-8 decode, no \n→\r\n: the stream
// already carries real terminal bytes).
const b64bytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));

// ── Accessory-bar key sets. The native keyboard supplies letters/numbers; the bar supplies what a
// phone keyboard can't, all sent LIVE to the PTY. Comprehensive enough for raw WSL/tmux TUIs. ──
type Key = { label: string; bytes: string; title?: string };

// primary row — always visible: nav + tab/back-tab + the tmux prefix.
const NAV_KEYS: Key[] = [
  { label: 'Esc', bytes: '\x1b' }, { label: 'Tab', bytes: '\t' },
  { label: '⇧Tab', bytes: '\x1b[Z', title: 'shift+tab (back-tab)' },
  { label: '←', bytes: '\x1b[D' }, { label: '↓', bytes: '\x1b[B' },
  { label: '↑', bytes: '\x1b[A' }, { label: '→', bytes: '\x1b[C' },
];
// tmux PREFIX (Ctrl-B) — tap it, then tap the next key (⌃B c = new window, ⌃B % = split, ⌃B ← = pane…).
const TMUX_PREFIX = '\x02';
// tray: extended navigation / editing.
const NAV2_KEYS: Key[] = [
  { label: 'Home', bytes: '\x1b[H' }, { label: 'End', bytes: '\x1b[F' },
  { label: 'PgUp', bytes: '\x1b[5~' }, { label: 'PgDn', bytes: '\x1b[6~' },
  { label: 'Del', bytes: '\x1b[3~' }, { label: 'Ins', bytes: '\x1b[2~' },
  { label: '⌫', bytes: '\x7f', title: 'backspace' },
];
// tray: common one-tap control combos.
const CTRL_KEYS: Key[] = [
  { label: '^C', bytes: '\x03' }, { label: '^D', bytes: '\x04' }, { label: '^Z', bytes: '\x1a' },
  { label: '^L', bytes: '\x0c' }, { label: '^R', bytes: '\x12' }, { label: '^A', bytes: '\x01' },
  { label: '^E', bytes: '\x05' }, { label: '^K', bytes: '\x0b' }, { label: '^U', bytes: '\x15' },
  { label: '^W', bytes: '\x17' }, { label: '^G', bytes: '\x07' },
];
// tray: tmux chords (prefix already applied — one tap = ⌃B then the key).
const TMUX_KEYS: Key[] = [
  { label: 'c·win', bytes: '\x02c', title: 'new window' }, { label: '%·vsplit', bytes: '\x02%' },
  { label: '"·hsplit', bytes: '\x02"' }, { label: 'z·zoom', bytes: '\x02z' },
  { label: 'o·pane', bytes: '\x02o', title: 'next pane' }, { label: 'n·next', bytes: '\x02n' },
  { label: 'p·prev', bytes: '\x02p' }, { label: 'd·detach', bytes: '\x02d' },
  { label: '[·copy', bytes: '\x02[', title: 'copy/scroll mode' }, { label: 'x·kill', bytes: '\x02x' },
];
// tray: function keys (F1-F4 = SS3, F5-F12 = CSI).
const FN_KEYS: Key[] = [
  { label: 'F1', bytes: '\x1bOP' }, { label: 'F2', bytes: '\x1bOQ' }, { label: 'F3', bytes: '\x1bOR' },
  { label: 'F4', bytes: '\x1bOS' }, { label: 'F5', bytes: '\x1b[15~' }, { label: 'F6', bytes: '\x1b[17~' },
  { label: 'F7', bytes: '\x1b[18~' }, { label: 'F8', bytes: '\x1b[19~' }, { label: 'F9', bytes: '\x1b[20~' },
  { label: 'F10', bytes: '\x1b[21~' }, { label: 'F11', bytes: '\x1b[23~' }, { label: 'F12', bytes: '\x1b[24~' },
];
// tray: symbols a phone keyboard buries under sub-menus.
const SYM_KEYS: Key[] = ['|', '~', '`', '\\', '/', '{', '}', '[', ']', '<', '>', '_', '#', '$', '*', '&']
  .map((s) => ({ label: s, bytes: s }));

// native-keyboard keys that emit no onInput data — forwarded to the PTY as their control sequences.
// Shift+Tab is intercepted separately (→ back-tab \x1b[Z).
const SPECIAL_KEYS: Record<string, string> = {
  Enter: '\r', Backspace: '\x7f', Tab: '\t', Escape: '\x1b',
  ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowLeft: '\x1b[D', ArrowRight: '\x1b[C',
  Home: '\x1b[H', End: '\x1b[F', PageUp: '\x1b[5~', PageDown: '\x1b[6~', Delete: '\x1b[3~',
};

type Sess = { sid: string; scrub: boolean };

export type HeadTerminalProps = {
  // KIT CONTRACT (agent-console-kit PORTING.md): the engine is host-app-agnostic. `sessionTarget`
  // names whatever the host backend resolves to a PTY (an HQ head, a Merritt site agent) — the
  // component never resolves it, it POSTs it. `apiBase` prefixes the terminal engine routes
  // (open/spawn/stream/input/resize/scrub/close). HQ defaults reproduce today's behavior; the /open
  // wire body keeps the `head` key until a backend-coordinated contract rename.
  //
  // v0.3: the terminal is LIVE-ONLY. It no longer composes MESSAGES — the shared-draft (chat⟷TUI)
  // and its `messageApiBase` are gone; message-composing is the chat view's Composer, a separate
  // surface. This is what kills the dual-box/confused-keyboard: one terminal, one live keyboard.
  sessionTarget?: string;        // required for kind 'pane' (the target whose PTY to mirror)
  apiBase?: string;              // terminal-engine route prefix (default '/api/hq/term')
  kind?: 'pane' | 'shell';       // 'pane' = mirror a target (default), 'shell' = spawn a blank bash
  active: boolean;               // stream ONLY while active (one session at a time; off-screen tears down)
  interactive?: boolean;         // show the accessory bar + live-input + write keystrokes (default true)
  openDelayMs?: number;          // debounce before opening (deck swipe anti-thrash; default 0)
  showControls?: boolean;        // render the per-session control bar (scrub toggle / close) (default true)
  onClose?: () => void;          // if set, a ⏹ close button is rendered + invoked after closing
  onError?: (msg: string | null) => void;   // surface open/spawn errors to the host chrome
  predictiveEcho?: 'auto' | 'on' | 'off';   // mosh-style local echo of typed keys (see ECHO below; default
                                            // 'auto' = coarse-pointer mirrors only — where the RTT hurts)
};

// ---- predictive (local) echo — the INPUT-path half of the mosh model -----------------------------
// Over mobile latency a keystroke round-trips phone → relay → tmux → pane redraw → SSE before anything
// visibly happens; 300-800ms of "did my tap even register?". True grid prediction is impossible for an
// alt-screen TUI (arbitrary redraws — the roadmap row concedes this), and "stream activity" is useless
// as confirmation because Claude's spinner repaints continuously. So the honest contract is DELIVERY
// echo: each key renders in an overlay strip INSTANTLY (underlined = in flight, mosh's convention),
// turns solid when its /input POST resolves (real delivered-to-PTY confirmation), then fades. A slow
// network shows as a persistent underline — an honest lag meter; a failed POST strikes through red.
type EchoEntry = { id: number; glyphs: string; state: 'sent' | 'acked' | 'failed' };
const ECHO_GLYPHS: Record<string, string> = {
  '\r': '⏎', '\n': '⏎', '\x7f': '⌫', '\t': '⇥', '\x1b': 'esc', ' ': '␣',
  '\x1b[A': '▲', '\x1b[B': '▼', '\x1b[C': '▶', '\x1b[D': '◀',
  '\x1b[H': '⇱', '\x1b[F': '⇲', '\x1b[5~': '⇞', '\x1b[6~': '⇟', '\x1b[3~': '⌦',
};
const echoGlyphsOf = (out: string): string | null => {
  if (out.startsWith('\x1b[<')) return null;                    // mouse/wheel — motion, not typing
  const mapped = ECHO_GLYPHS[out];
  if (mapped) return mapped;
  if (out.length === 1) {
    const c = out.charCodeAt(0);
    if (c < 32) return '^' + String.fromCharCode(c + 64);       // control chords: ^C ^B …
    return out;
  }
  if (out.length === 2 && out.charCodeAt(0) === 27) return '⌥' + out[1];   // alt-prefixed char
  if ([...out].every((ch) => ch.charCodeAt(0) >= 32)) {
    return out.length > 12 ? out.slice(0, 11) + '…' : out;      // typed run / paste
  }
  return '·';                                                    // unknown sequence — show SOMETHING
};

// brief keep-alive after a session goes inactive — swiping back before this fires reuses the session
// instead of thrashing open/close. The relay still stops piping the moment the SSE drops (demand TTL),
// so this only governs the session record, not capture cost.
const KEEPALIVE_MS = 600;

// Drive the MIRRORED pane to this many COLUMNS (decoupled from the 120-col desktop clients via
// window-size manual). Fewer cols → the fit-to-width font is BIGGER on a phone (100 ≈ ~6px vs 120 ≈ ~5px)
// with still NO horizontal scroll. Dial DOWN (80/70) for bigger text. Restored to window-size latest →
// back to the desktop width on disconnect (relay).
const TARGET_MIRROR_COLS = 100;
// monospace advance width ≈ CHAR_RATIO × font-size (conservative → guaranteed width fit). Shared by
// fitFont (sizes the CURRENT pane cols) and the resize projection (pre-computes rows for TARGET cols).
const CHAR_RATIO = 0.62;
const fitFontSize = (availW: number, cols: number) =>
  Math.max(4, Math.min(16, Math.floor(availW / (cols * CHAR_RATIO))));

export default function HeadTerminal({
  sessionTarget, apiBase = '/api/hq/term', kind = 'pane', active, interactive = true,
  openDelayMs = 0, showControls = true, onClose, onError, predictiveEcho = 'auto',
}: HeadTerminalProps) {
  const [sess, setSess] = useState<Sess | null>(null);
  // sticky modifiers — arm one (or several), the NEXT key composes with them then they auto-disarm.
  // Applies to the accessory char keys AND every keystroke from the native keyboard, so any
  // Ctrl+X / Alt+X / Shift+X the phone keyboard can't emit is reachable (incl. tmux ⌃B via Ctrl+b).
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [altArmed, setAltArmed] = useState(false);
  const [shiftArmed, setShiftArmed] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);    // expandable "more keys" tray
  const altRef = useRef(false);
  const shiftRef = useRef(false);
  const toggleCtrl = () => { const n = !ctrlRef.current; ctrlRef.current = n; setCtrlArmed(n); };
  const toggleAlt = () => { const n = !altRef.current; altRef.current = n; setAltArmed(n); };
  const toggleShift = () => { const n = !shiftRef.current; shiftRef.current = n; setShiftArmed(n); };
  const disarmMods = () => {
    if (ctrlRef.current) { ctrlRef.current = false; setCtrlArmed(false); }
    if (altRef.current) { altRef.current = false; setAltArmed(false); }
    if (shiftRef.current) { shiftRef.current = false; setShiftArmed(false); }
  };

  const rootRef = useRef<HTMLDivElement | null>(null);   // clip viewport (height = section's flex box)
  const blockRef = useRef<HTMLDivElement | null>(null);  // the contiguous terminal+key-bar+composer block
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const sidRef = useRef<string | null>(null);         // live sid for sendBytes/close (stable across renders)
  const ctrlRef = useRef(false);
  const openingRef = useRef(false);                    // guard against a double-open race during debounce
  const mountedRef = useRef(true);                     // false after unmount → a resolving open self-closes
  const activeRef = useRef(active);                    // current active, readable inside an async open
  const lastRowsRef = useRef<number | null>(null);     // last row-count we asked the relay to mirror at

  // ---- lifecycle: open while active (debounced), close on swipe-away / unmount -------------------
  const teardownXterm = () => {
    esRef.current?.close(); esRef.current = null;
    termRef.current?.dispose(); termRef.current = null;
  };

  const closeSession = async () => {
    const id = sidRef.current;
    sidRef.current = null;
    teardownXterm();
    setSess(null);
    if (id) { try { await fetch(`${apiBase}/${encodeURIComponent(id)}/close`, { method: 'POST' }); } catch { /* */ } }
  };

  const openSession = async () => {
    if (sidRef.current || openingRef.current) return;   // already open / opening
    if (kind === 'pane' && !sessionTarget) return;
    openingRef.current = true;
    onError?.(null);
    try {
      const r = kind === 'shell'
        ? await fetch(`${apiBase}/spawn`, { method: 'POST' })
        : await fetch(`${apiBase}/open`, {
            // wire key stays `head` (the HQ backend contract) until the kit's v0.2 contract rename
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ head: sessionTarget }),
          });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { onError?.(d.detail || `${kind === 'shell' ? 'spawn' : 'open'} failed (${r.status})`); return; }
      // open-vs-unmount race (the slot-leak): if we unmounted / went inactive / already adopted another
      // sid while this POST was in flight, the returned slot is an orphan nothing else would ever close.
      // Close it ourselves now instead of adopting it. (Dedup on the backend means a same-head re-open
      // would have returned THIS very sid, so closing it is correct — the next open re-derives it.)
      if (!mountedRef.current || !activeRef.current || sidRef.current) {
        if (d.sid) { try { await fetch(`${apiBase}/${encodeURIComponent(d.sid)}/close`, { method: 'POST' }); } catch { /* */ } }
        return;
      }
      sidRef.current = d.sid;
      setSess({ sid: d.sid, scrub: kind === 'pane' ? d.scrub !== false : false });
    } catch {
      onError?.("can't reach the terminal backend");
    } finally {
      openingRef.current = false;
    }
  };

  // open ~openDelayMs after becoming active; close ~KEEPALIVE_MS after going inactive (cancel either
  // if `active` flips back first — that's the swipe debounce). Keyed on the target too, so changing
  // head/kind re-opens cleanly.
  useEffect(() => {
    activeRef.current = active;                      // keep the async-readable copy current
    let cancelled = false;
    if (active) {
      const t = setTimeout(() => { if (!cancelled) openSession(); }, openDelayMs);
      return () => { cancelled = true; clearTimeout(t); };
    }
    const t = setTimeout(() => { if (!cancelled) closeSession(); }, KEEPALIVE_MS);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessionTarget, kind, openDelayMs]);

  // hard close on unmount (project change / deck rebuild / TUI→chat toggle) — no leaked session/pipe.
  // mountedRef flips false FIRST so an /open still in flight self-closes when it resolves (see openSession).
  useEffect(() => {
    mountedRef.current = true;                       // (re)assert on mount — StrictMode remounts cleanly
    return () => { mountedRef.current = false; closeSession(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // predictive echo state — postBytes is the single choke point every input surface funnels
  // through (native keyboard, desktop onData, accessory bar), so hooking here covers them all.
  const [echo, setEcho] = useState<EchoEntry[]>([]);
  const echoSeqRef = useRef(0);
  const echoOn = interactive && kind === 'pane' && predictiveEcho !== 'off'
    && (predictiveEcho === 'on'
      || (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches));
  const echoSet = (id: number, state: EchoEntry['state']) =>
    setEcho((p) => p.map((e) => (e.id === id ? { ...e, state } : e)));
  const echoDrop = (id: number, afterMs: number) =>
    setTimeout(() => setEcho((p) => p.filter((e) => e.id !== id)), afterMs);

  // ---- input: the low-level POST of raw bytes LIVE to the PTY. No modifier logic here.
  const postBytes = (out: string) => {
    const sid = sidRef.current;
    if (!sid || !out) return;
    const glyphs = echoOn ? echoGlyphsOf(out) : null;
    let id = 0;
    if (glyphs) {
      id = ++echoSeqRef.current;
      setEcho((p) => [...p.slice(-31), { id, glyphs, state: 'sent' }]);   // bounded — never grows unread
    }
    fetch(`${apiBase}/${encodeURIComponent(sid)}/input`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: out }),
    }).then((r) => {
      if (!id) return;
      if (r.ok) { echoSet(id, 'acked'); echoDrop(id, 450); }
      else { echoSet(id, 'failed'); echoDrop(id, 1800); }
    }).catch(() => {
      if (id) { echoSet(id, 'failed'); echoDrop(id, 1800); }
    });
  };

  // send a COMPLETE escape sequence (arrow, F-key, tmux chord, ⌃C…) — already fully formed. An armed
  // Alt still prefixes it with ESC (meta); Ctrl/Shift don't recombine a ready sequence. Disarms after.
  const sendSeq = (seq: string) => {
    postBytes(altRef.current ? '\x1b' + seq : seq);
    disarmMods();
  };

  // send a single CHARACTER through the armed sticky modifiers (used by the native keyboard and the
  // symbol keys): Ctrl→control byte, Shift→upper/shifted, Alt→ESC-prefixed. Modifiers combine.
  const sendChar = (ch: string) => {
    let out = ch;
    if (shiftRef.current && /^[a-z]$/.test(out)) out = out.toUpperCase();
    if (ctrlRef.current && /^[a-zA-Z]$/.test(out)) out = String.fromCharCode(out.toLowerCase().charCodeAt(0) & 0x1f);
    else if (ctrlRef.current && out === ' ') out = '\x00';   // Ctrl+Space → NUL
    if (altRef.current) out = '\x1b' + out;
    postBytes(out);
    disarmMods();
  };

  // Back-compat alias used by the desktop xterm keystroke path (raw bytes, honor sticky Ctrl on a letter).
  const sendBytes = (data: string) => {
    if (data.length === 1) sendChar(data); else sendSeq(data);
  };

  // Alt-screen TUIs (Claude Code) scroll via MOUSE WHEEL, not terminal scrollback — and a phone has
  // neither a wheel nor scrollback to drag. Forward SGR wheel events to the head through the same
  // /input path (proven: send-keys -l passes the sequence through and Claude scrolls).
  const sendWheel = (dir: 'up' | 'down', ticks = 3) => {
    const t = termRef.current;
    const col = t ? Math.max(1, t.cols >> 1) : 10;   // center coord — within any pane's scroll region
    const row = t ? Math.max(1, t.rows >> 1) : 8;
    const btn = dir === 'up' ? 64 : 65;
    postBytes(`\x1b[<${btn};${col};${row}M`.repeat(ticks));   // scroll is modifier-neutral
  };

  // ---- ONE line-intent accumulator, every local scroll format ------------------------------------
  // Task 055ef0. Finger drag, hardware wheel and BT-trackpad momentum all converge on the SAME
  // converter (src/scrollIntent.ts), get quantized to whole line ticks, and leave as ONE batched
  // POST per frame. The contract — batching, no lost intent, no in-batch reversal, deltaMode
  // handling — is unit-tested there rather than asserted here.
  const intentRef = useRef<ScrollIntent | null>(null);
  if (!intentRef.current) {
    intentRef.current = createScrollIntent({
      linePx: 15,                                     // ≈ one line-height: the drag's proven 1:1 feel
      pageHeightPx: () => hostRef.current?.clientHeight ?? 400,
      emit: (dir, ticks) => sendWheel(dir, ticks),    // ONE post, |ticks| sequences
    });
  }
  const intent = intentRef.current;

  // ---- xterm: raw-byte render keyed on the live sid ----------------------------------------------
  useEffect(() => {
    if (!sess || !hostRef.current) return;
    lastRowsRef.current = null;          // new session → recompute the mirror row-count from scratch
    setEcho([]);                         // stale pending-echo from a prior session must not carry over
    // A pane MIRROR is read-only: the head's real cursor is already baked into the captured bytes, so
    // xterm's OWN cursor block is a spurious artifact that lands at a stale position (Schyler: "cursor box
    // in the wrong place"). Hide it for mirrors (transparent = bg colour, no blink); keep a real cursor for
    // blank shells where xterm's cursor IS the live prompt.
    const mirror = kind === 'pane';
    // A blank SHELL gets a fixed, READABLE (chat-sized) font; cols are driven to fit the width (resizeShellOnce)
    // so it wraps like a normal terminal instead of cramming 100+ mirror columns into ~5px. A mirror keeps the
    // small fit-to-width font (it must show a head's full 100-120-col TUI without h-scroll).
    const SHELL_FS = 15;
    const term = new Terminal({
      convertEol: false, cursorBlink: !mirror, disableStdin: !interactive, scrollback: 5000, fontSize: mirror ? 12 : SHELL_FS,
      fontFamily: "'SFMono-Regular',ui-monospace,Consolas,monospace",
      theme: { background: '#04070a', foreground: C.ink, ...(mirror ? { cursor: '#04070a', cursorAccent: '#04070a' } : {}) },
    });
    term.open(hostRef.current);
    // Canvas renderer — MIRRORS ONLY. The Canvas addon is the documented iOS perf win (faster repaint, cleaner
    // box-drawing) and the mirror's 3.5s resync repaints over any glitch. But a blank SHELL's block gets a CSS
    // `transform` (the keyboard slide), and an ancestor transform BLANKS an xterm canvas on iOS Safari (the
    // "terminal vanishes after a couple seconds" bug) with no resync to recover it — so shells use the reliable
    // DOM renderer.
    if (mirror) {
      void import('xterm-addon-canvas').then(({ CanvasAddon }) => {
        try { term.loadAddon(new CanvasAddon()); } catch { /* DOM renderer stays */ }
      }).catch(() => { /* addon unavailable → DOM renderer */ });
    }
    termRef.current = term;
    if (interactive) term.onData(sendBytes);   // desktop keystrokes (incl. Ctrl combos) as raw bytes

    // FIT-TO-WIDTH, host wraps to the terminal's NATURAL height. Fitting BOTH axes meant the font was
    // width-constrained (120 cols on a phone → ~4px) yet the host still filled the full column height
    // (flex:1) — leaving a big slab of dead space that my bottom-anchor dumped ABOVE the text (Schyler:
    // "big gap up above the text"). The slack only exists because the host was forced taller than the
    // content. Fix: size the font to WIDTH only (no horizontal overflow — the thing he cares about) and
    // let the host be exactly as tall as the rows render (host is flex:0 0 auto below) → zero slack, no gap.
    // Re-fits on width change (orientation); keyboard open changes height only, so the font holds.
    const fitFont = () => {
      const host = hostRef.current;
      if (!host) return;
      if (!mirror) {                                   // shell: fixed readable font; cols are driven to fit, not font
        if (term.options.fontSize !== SHELL_FS) { term.options.fontSize = SHELL_FS; try { term.refresh(0, term.rows - 1); } catch { /* */ } }
        return;
      }
      const availW = host.clientWidth - 12;            // host has 6px padding on each side
      if (availW <= 0) return;
      const fs = fitFontSize(availW, term.cols || 80);  // size the font to the CURRENT pane cols
      if (term.options.fontSize !== fs) {
        term.options.fontSize = fs;                    // xterm re-measures cells on the next render
        try { term.refresh(0, term.rows - 1); } catch { /* */ }
      }
    };
    // SHELL sizing (one-shot): drive the blank shell's pane to as many cols as fit the width at SHELL_FS, and
    // enough rows to fill the host — so it reads like a normal terminal (wraps, no h-scroll) at a readable font,
    // instead of the mirror's 100-col cram. One-shot (guarded): once set, the keyboard opening just scrolls the
    // terminal (no row re-fit), and the pane's size event round-trips back to xterm so the two stay matched.
    let shellSized = false;
    const resizeShellOnce = () => {
      if (mirror || shellSized || !interactive) return;
      const sid = sidRef.current;
      const host = hostRef.current, root = rootRef.current, block = blockRef.current, el = term.element;
      if (!sid || !host || !root || !block || !el || !term.rows) return;
      const availW = host.clientWidth - 12;
      const cols = Math.max(20, Math.min(100, Math.floor(availW / (SHELL_FS * CHAR_RATIO))));
      const cellPx = el.offsetHeight / term.rows;                 // current cell height at SHELL_FS
      const chrome = block.offsetHeight - host.offsetHeight;      // key-bar + composer (non-terminal)
      const avail = root.clientHeight - chrome - 12;
      const rows = cellPx > 0 ? Math.max(8, Math.min(60, Math.floor(avail / cellPx))) : 24;
      if (!(cols > 0)) return;
      shellSized = true;
      fetch(`${apiBase}/${encodeURIComponent(sid)}/resize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols, rows }),
      }).catch(() => {});
    };
    // SLIDE (the dead-band kill, Schyler's Option 2). The terminal+key-bar+composer are ONE contiguous,
    // NATURAL-height block (host is flex:0 0 auto below — it no longer fills, so there is zero band between
    // the last terminal row and the key-bar). The block top-anchors under the header; any viewport slack
    // sits BELOW the composer. When the keyboard opens (visualViewport → the section, hence our root, gets
    // SHORTER) the block can't fit, so we TRANSLATE it up by exactly the overflow: the composer + live
    // prompt ride just above the keyboard and the TOP of the terminal slides under the header (clipped by
    // root's overflow:hidden). A transform — no font refit, no row-squeeze, no reflow jank.
    const slide = () => {
      const root = rootRef.current, block = blockRef.current;
      if (!root || !block) return;
      const overflow = Math.max(0, block.offsetHeight - root.clientHeight);
      block.style.transform = overflow > 0 ? `translateY(${-overflow}px)` : 'none';
    };
    // FILL the host (rows) + drive the pane to TARGET_MIRROR_COLS (bigger fit-to-width font). The head's
    // alt-screen TUI draws exactly pane-many rows, so we ask the relay to make the mirrored window
    // TARGET_MIRROR_COLS wide and tall enough to fill — still NO horizontal scroll (cols are sized to the
    // width). desiredRows = how many rows fit the terminal's share of the KEYBOARD-CLOSED layout, at the
    // font fit-to-width WOULD pick for TARGET cols. NOT recomputed while the keyboard is open (spec: never
    // shrink rows — #72's slide tucks the top under the header instead). Converges in 1 POST (+ at most one
    // ±1-2 row rounding correction); cols are pinned to TARGET and never oscillate.
    let sized = false;                                 // set once the first size event lands (real pane cols)
    const resizeMirror = () => {
      if (kind !== 'pane' || !interactive || !sized) return;   // wait for real pane cols (not xterm's 80)
      const sid = sidRef.current;
      const root = rootRef.current, block = blockRef.current, host = hostRef.current, el = term.element;
      if (!sid || !root || !block || !host || !el || !term.rows) return;
      const vv = window.visualViewport;                // keyboard open → don't recompute (would shrink rows)
      if (vv && window.innerHeight - vv.height > 100) return;
      const curFs = (term.options.fontSize as number) || 1;
      const cellPerFs = (el.offsetHeight / term.rows) / curFs;   // renderer cell-height per font-px (stable across sizes)
      // Drive the pane to TARGET_MIRROR_COLS. Project the cell height for the font fit-to-width WOULD pick
      // at that col count (bigger cells → fewer rows), and derive rows from THAT — so the single POST is
      // {cols:TARGET, rows: rowsForTheTargetFont}. After the relay reflows the pane + the size event returns
      // TARGET cols, fitFont re-sizes the font to exactly this projection and rows already (nearly) match →
      // no 120→rows→re-rows oscillation. (CHAR_RATIO/formula shared with fitFont; the only residual is the
      // renderer's integer cell-height rounding → at most one ±1-2 row corrective POST, never a col bounce.)
      const availW = host.clientWidth - 12;
      const projCellPx = cellPerFs * fitFontSize(availW, TARGET_MIRROR_COLS);
      const chrome = block.offsetHeight - host.offsetHeight;   // controls + key-bar + composer (non-terminal)
      const avail = root.clientHeight - chrome - 12;   // px for terminal CONTENT (host has 6px top+bottom pad)
      if (!(projCellPx > 0) || avail <= 0) return;     // mid-layout / not painted → skip this measurement
      const want = Math.max(10, Math.min(160, Math.floor(avail / projCellPx)));
      const atTarget = term.cols === TARGET_MIRROR_COLS;
      if (atTarget && (want === term.rows || want === lastRowsRef.current)) return;   // converged / already asked
      lastRowsRef.current = want;
      fetch(`${apiBase}/${encodeURIComponent(sid)}/resize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols: TARGET_MIRROR_COLS, rows: want }),   // drive cols to the target + filled rows
      }).catch(() => {});
    };
    // DEBOUNCE the row-resize: measure once after layout SETTLES (300ms), not on every paint/relayout —
    // a mid-paint or feedback-loop measurement (the POST→pane-grow→size-event→re-measure cycle) produced
    // unstable row-counts. Coalescing to the settled value makes it converge in one resize.
    let rzTimer: ReturnType<typeof setTimeout> | undefined;
    const resizeMirrorSoon = () => { clearTimeout(rzTimer); rzTimer = setTimeout(resizeMirror, 300); };
    let slideQ = false;                                // rAF-coalesce so a busy stream re-slides once/frame
    const slideSoon = () => { if (slideQ) return; slideQ = true; requestAnimationFrame(() => { slideQ = false; slide(); }); };
    const relayout = () => { fitFont(); slide(); };    // width-refit + slide; rows are recomputed separately
    requestAnimationFrame(relayout);                   // once the host has a measured width
    // Recompute mirror ROWS only on STABLE triggers — orientation (window resize) — NOT on every
    // ResizeObserver reflow (those fire mid-paint / on the keyboard and produced unstable counts). The
    // first measurement is kicked by the size event below (once the real pane cols are known + painted).
    const onWinResize = () => { relayout(); if (mirror) resizeMirrorSoon(); else { shellSized = false; requestAnimationFrame(resizeShellOnce); } };
    window.addEventListener('resize', onWinResize);
    // observe HOST width (→ fitFont) AND root height (→ slide: the section shrinks under the keyboard).
    const ro = new ResizeObserver(() => requestAnimationFrame(relayout));
    ro.observe(hostRef.current);
    if (rootRef.current) ro.observe(rootRef.current);
    term.onRender(slideSoon);                          // terminal painted / changed height → re-slide (coalesced)

    // touch-drag → wheel-scroll: convert a vertical finger drag into SGR wheel events for natural
    // scrolling on mobile (xterm won't generate wheel from touch, and alt-screen has no scrollback).
    const host = hostRef.current;
    let lastY: number | null = null, accum = 0;
    const onTS = (e: TouchEvent) => { if (e.touches.length === 1) { lastY = e.touches[0].clientY; accum = 0; } };
    const onTM = (e: TouchEvent) => {
      if (lastY == null || e.touches.length !== 1) return;
      const y = e.touches[0].clientY; const dy = y - lastY; lastY = y;
      // the drag's own batching is now the shared accumulator's — same quantization, same one-POST
      // -per-frame flush the wheel path uses. Behaviour is unchanged; there is just one of it.
      accum += dy;
      intent.pushPx(dy);
      if (Math.abs(accum) >= 15) {
        accum %= 15;
        e.preventDefault(); e.stopPropagation();   // claim from page scroll + xterm's touch/mouse handling
      }
    };
    const onTE = () => { lastY = null; };
    // Hardware wheel / BT-trackpad. CAPTURE PHASE IS LOAD-BEARING, not stylistic: xterm's own mouse
    // reporting is today's ONLY sender of wheel SGR (it converts the event and emits it through
    // onData → sendBytes → postBytes, one POST per event). A handler bound in the bubble phase would
    // run AFTER xterm had already sent, and the head would receive both streams — double the scroll.
    // Claiming in capture and stopping propagation makes this the single sender.
    //
    // VERTICAL ONLY. Horizontal-dominant events are deliberately left to propagate: ConsoleDeck's
    // axis-lock owns them for pane-switching, and swallowing them here would kill that gesture over
    // any terminal pane.
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;   // the deck's gesture, not ours
      intent.pushWheel(e);
      e.preventDefault();
      e.stopPropagation();
    };

    if (interactive && host) {
      // capture phase so we beat xterm's own touch handlers to the vertical-drag gesture
      host.addEventListener('touchstart', onTS, { passive: false, capture: true });
      host.addEventListener('touchmove', onTM, { passive: false, capture: true });
      host.addEventListener('touchend', onTE, { capture: true });
      host.addEventListener('wheel', onWheel, { passive: false, capture: true });
    }

    // SSE stream with a VISIBLE reconnect state (audit 2026-07-02: a mid-session transport drop
    // left the terminal silently frozen — onerror was a no-op with no indicator). The browser
    // auto-retries transient drops (readyState CONNECTING → show "reconnecting…"); a FATAL close
    // (readyState CLOSED, e.g. an SSO 4xx after token expiry) never auto-retries, so we re-open
    // manually with bounded backoff, and surface "stream lost" if that too runs dry.
    let retries = 0;
    let retryTimer: number | undefined;
    const openStream = () => {
      const es = new EventSource(`${apiBase}/${encodeURIComponent(sess.sid)}/stream`);
      es.onopen = () => { retries = 0; setStream('live'); };
      es.onmessage = (e) => {
        // raw PTY bytes — let xterm render cursor/scrollback/ANSI natively (no repaint, no decode)
        try { term.write(b64bytes(e.data)); } catch { /* */ }
      };
      es.addEventListener('size', (e) => {
        const [c, r] = (e as MessageEvent).data.split('x').map(Number);
        if (c > 0 && r > 0) { sized = true; try { term.resize(c, r); } catch { /* */ } relayout(); if (mirror) resizeMirrorSoon(); else requestAnimationFrame(resizeShellOnce); }   // real cols known → (re)compute rows
      });
      es.addEventListener('closed', () => { closeSession(); });
      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
          es.close();
          if (retries < 5) {
            retries += 1;
            setStream('reconnecting');
            retryTimer = window.setTimeout(openStream, Math.min(8000, 500 * 2 ** retries));
          } else {
            setStream('lost');
          }
        } else {
          setStream('reconnecting');   // browser is auto-retrying; the relay re-streams on reconnect
        }
      };
      esRef.current = es;
    };
    setStream('live');
    openStream();

    return () => {
      window.removeEventListener('resize', onWinResize);
      clearTimeout(rzTimer);
      clearTimeout(retryTimer);
      ro.disconnect();
      if (interactive && host) {
        host.removeEventListener('touchstart', onTS, { capture: true });
        host.removeEventListener('touchmove', onTM, { capture: true });
        host.removeEventListener('touchend', onTE, { capture: true });
        host.removeEventListener('wheel', onWheel, { capture: true });
        intent.dispose();   // a pending frame must not emit into a torn-down session
      }
      teardownXterm();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sess?.sid, interactive]);

  const toggleScrub = async () => {
    if (!sess) return;
    const next = !sess.scrub;
    setSess({ ...sess, scrub: next });
    try {
      await fetch(`${apiBase}/${encodeURIComponent(sess.sid)}/scrub`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: next }),
      });
    } catch { /* */ }
  };

  const connecting = active && !sess;
  // SSE transport state — 'reconnecting' while a drop is being retried (browser auto-retry or our
  // bounded manual re-open), 'lost' when retries ran dry. Anything but 'live' overlays a chip so a
  // frozen mirror can never pass for a live one.
  const [stream, setStream] = useState<'live' | 'reconnecting' | 'lost'>('live');

  return (
    // ROOT = the clip viewport: its height tracks the section's flex box (which the visualViewport shrinks
    // when the keyboard opens). overflow:hidden clips the terminal top that the BLOCK's translate slides
    // up under the header.
    <div ref={rootRef} style={{ height: '100%', minHeight: 0, overflow: 'hidden', position: 'relative' }}>
      {/* touch-action: pan-x pinch-zoom — KEEP pan-x even though we now fit-to-width (nothing to pan): it's
          what actually delivers single-finger VERTICAL drags to our capture-phase touchmove handler (verified:
          pan-x pinch-zoom = touch-scroll works 6/6; pinch-zoom alone = 0 touchmoves, dead). Pinch-to-read
          preserved; overscroll-behavior:contain stops the drag chaining to the deck swipe / dragging the page. */}
      <style>{`.hq-term-host,.hq-term-host *{touch-action:pan-x pinch-zoom !important}
        /* keep the terminal at its NATURAL (fit-to-width) height — never let the flex column stretch it. */
        .hq-term-host>.xterm{flex:0 0 auto !important}
        .hq-term-mirror .xterm-cursor,.hq-term-mirror .xterm-cursor-outline{display:none !important;border:0 !important;background:transparent !important}`}</style>
      {/* BLOCK = header(controls) → terminal → accessory-bar → live-input as ONE contiguous,
          NATURAL-height column. Top-anchored under the header (slack, if any, sits BELOW the input).
          `slide()` sets translateY to ride the live-input just above the keyboard when the section
          shrinks (the visualViewport shrinks it when the native keyboard opens). */}
      <div ref={blockRef} style={{ display: 'flex', flexDirection: 'column', willChange: 'transform' }}>
      {showControls && sess && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 6px 6px', flex: '0 0 auto' }}>
          {kind === 'pane' && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, color: C.muted, cursor: 'pointer' }}>
              <input type="checkbox" checked={sess.scrub} onChange={toggleScrub} /> scrub secrets
            </label>
          )}
          {kind === 'shell' && <span style={{ fontSize: 10, color: C.amber }}>blank shell · $HOME · full access</span>}
          {onClose && (
            <button type="button" onClick={() => { closeSession(); onClose(); }}
              style={{ marginLeft: 'auto', fontFamily: C.mono, fontSize: 11, padding: '3px 11px', borderRadius: C.radius, cursor: 'pointer', border: `1px solid ${C.red}`, background: 'rgba(255,107,107,.08)', color: C.red }}>
              ⏹ close{kind === 'shell' ? ' + kill shell' : ''}
            </button>
          )}
        </div>
      )}

      {/* xterm host — sizes to the terminal's NATURAL fit-to-width height (flex:0 0 auto: it does NOT fill).
          That kills the dead band: the key-bar butts directly against the last terminal row. The block (not
          the host) owns vertical positioning, via `slide()`. minHeight keeps room for the "connecting…"
          overlay before the first paint. */}
      <div ref={hostRef} className={`hq-term-host${kind === 'pane' ? ' hq-term-mirror' : ''}`} style={{ flex: '0 0 auto', minHeight: 96, background: '#04070a', borderRadius: C.radius, overflowX: 'hidden', overflowY: 'hidden', overscrollBehavior: 'contain', padding: 6, position: 'relative', touchAction: 'pan-x pinch-zoom', display: 'flex', flexDirection: 'column' }}>
        {connecting && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.faint, fontFamily: C.mono, fontSize: 12 }}>connecting…</div>}
        {!connecting && sess && stream !== 'live' && (
          <div style={{ position: 'absolute', top: 4, right: 6, zIndex: 2, display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 6px', border: `1px solid ${stream === 'lost' ? C.red : C.amber}`, borderRadius: C.radius,
            color: stream === 'lost' ? C.red : C.amber, fontFamily: C.mono, fontSize: 10,
            background: 'rgba(4,7,10,.85)' }}>
            {stream === 'lost' ? '✗ stream lost — reopen the terminal' : '⚡ reconnecting…'}
          </div>
        )}
        {/* predictive-echo strip — an OVERLAY, deliberately not written into the xterm grid (fake
            bytes would corrupt the mirror and double with the real echo). pointerEvents:none. */}
        {echoOn && echo.length > 0 && (
          <div aria-hidden className="hq-echo-strip" style={{ position: 'absolute', left: 8, bottom: 6, zIndex: 2, pointerEvents: 'none',
            fontFamily: "'SFMono-Regular',ui-monospace,Consolas,monospace", fontSize: 13, lineHeight: 1.25,
            background: 'rgba(4,7,10,.78)', padding: '1px 6px', borderRadius: 4,
            maxWidth: 'calc(100% - 16px)', overflow: 'hidden', whiteSpace: 'nowrap' }}>
            {echo.slice(-24).map((e) => (
              <span key={e.id} style={{
                color: e.state === 'failed' ? C.red : C.green,
                opacity: e.state === 'acked' ? 0.5 : 0.95,
                textDecoration: e.state === 'sent' ? 'underline' : e.state === 'failed' ? 'line-through' : 'none',
                textUnderlineOffset: 2, transition: 'opacity .35s ease',
              }}>{e.glyphs}</span>
            ))}
          </div>
        )}
      </div>

      {interactive && sess && (() => {
        const anyMod = ctrlArmed || altArmed || shiftArmed;
        const modBtn = (label: string, armed: boolean, onClick: () => void, title: string) => (
          <button type="button" onMouseDown={(e) => { e.preventDefault(); onClick(); }} title={title}
            style={{ flexShrink: 0, fontFamily: C.mono, fontSize: 12, padding: '6px 11px', borderRadius: C.radius, cursor: 'pointer',
              border: `1px solid ${armed ? C.amber : C.line2}`, background: armed ? 'rgba(255,207,92,.18)' : C.raised, color: armed ? C.amber : C.ink }}>{label}</button>
        );
        // seq keys are complete sequences (→ sendSeq); char keys compose with modifiers (→ sendChar).
        const keyBtn = (k: Key, mode: 'seq' | 'char') => (
          <button key={k.label} type="button" onMouseDown={(e) => { e.preventDefault(); mode === 'char' ? sendChar(k.bytes) : sendSeq(k.bytes); }}
            title={k.title || `send ${k.label}`}
            style={{ flexShrink: 0, fontFamily: C.mono, fontSize: 12, padding: '6px 10px', borderRadius: C.radius, cursor: 'pointer',
              border: `1px solid ${C.line2}`, background: C.raised, color: C.ink, whiteSpace: 'nowrap' }}>{k.label}</button>
        );
        const groupSep = () => <span style={{ flexShrink: 0, width: 1, alignSelf: 'stretch', margin: '2px 3px', background: C.line }} />;
        return (
        <>
          {/* ACCESSORY bar — everything a phone keyboard can't emit, LIVE to the PTY. Sticky modifiers
              (Ctrl/Alt/Shift) compose with the next key from the bar OR the native keyboard, so any
              Ctrl+X / Alt+X and the tmux ⌃B-prefix chords are reachable. "⋯" expands the full tray. */}
          <div style={{ display: 'flex', gap: 5, padding: '6px 2px 0', overflowX: 'auto', flex: '0 0 auto' }}>
            {modBtn('Ctrl', ctrlArmed, toggleCtrl, 'sticky Ctrl — next key sends its control byte (⌃A…⌃Z, ⌃Space=NUL)')}
            {modBtn('Alt', altArmed, toggleAlt, 'sticky Alt/Meta — next key is ESC-prefixed')}
            {modBtn('⇧', shiftArmed, toggleShift, 'sticky Shift — next key is shifted/upper')}
            {groupSep()}
            {NAV_KEYS.map((k) => keyBtn(k, 'seq'))}
            <button type="button" onMouseDown={(e) => { e.preventDefault(); postBytes(TMUX_PREFIX); disarmMods(); }}
              title="tmux prefix (Ctrl-B) — then tap the next key: c=new window, %=split, ←→=pane, z=zoom…"
              style={{ flexShrink: 0, fontFamily: C.mono, fontSize: 12, padding: '6px 10px', borderRadius: C.radius, cursor: 'pointer',
                border: `1px solid ${C.violet}`, background: 'rgba(167,139,250,.12)', color: C.violet, whiteSpace: 'nowrap' }}>⌃B</button>
            {groupSep()}
            <button type="button" onMouseDown={(e) => { e.preventDefault(); sendWheel('up'); }} title="scroll the terminal view up"
              style={{ flexShrink: 0, fontFamily: C.mono, fontSize: 13, padding: '6px 10px', borderRadius: C.radius, cursor: 'pointer', border: `1px solid ${C.line2}`, background: C.raised, color: C.ink }}>⤒</button>
            <button type="button" onMouseDown={(e) => { e.preventDefault(); sendWheel('down'); }} title="scroll the terminal view down"
              style={{ flexShrink: 0, fontFamily: C.mono, fontSize: 13, padding: '6px 10px', borderRadius: C.radius, cursor: 'pointer', border: `1px solid ${C.line2}`, background: C.raised, color: C.ink }}>⤓</button>
            {groupSep()}
            <button type="button" onMouseDown={(e) => { e.preventDefault(); setTrayOpen((o) => !o); }} title="more keys — Home/End/PgUp, F-keys, tmux chords, symbols"
              style={{ flexShrink: 0, fontFamily: C.mono, fontSize: 13, padding: '6px 11px', borderRadius: C.radius, cursor: 'pointer',
                border: `1px solid ${trayOpen ? C.green : C.line2}`, background: trayOpen ? 'rgba(34,255,106,.12)' : C.raised, color: trayOpen ? C.green : C.ink }}>⋯</button>
          </div>

          {/* expandable tray — grouped rows: nav/edit · ctrl-combos · tmux chords · function keys · symbols */}
          {trayOpen && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '5px 2px 0', flex: '0 0 auto' }}>
              <div style={{ display: 'flex', gap: 5, overflowX: 'auto' }}>{NAV2_KEYS.map((k) => keyBtn(k, 'seq'))}</div>
              <div style={{ display: 'flex', gap: 5, overflowX: 'auto' }}>{CTRL_KEYS.map((k) => keyBtn(k, 'seq'))}</div>
              <div style={{ display: 'flex', gap: 5, overflowX: 'auto' }}>{TMUX_KEYS.map((k) => keyBtn(k, 'seq'))}</div>
              <div style={{ display: 'flex', gap: 5, overflowX: 'auto' }}>{FN_KEYS.map((k) => keyBtn(k, 'seq'))}</div>
              <div style={{ display: 'flex', gap: 5, overflowX: 'auto' }}>{SYM_KEYS.map((k) => keyBtn(k, 'char'))}</div>
            </div>
          )}

          {/* LIVE native-keyboard input — the single input surface for the terminal. It summons the
              phone's native keyboard and forwards every keystroke straight to the PTY; the field stays
              empty (your text, prompt + cursor render in the terminal ABOVE, echoed by the head/shell).
              onInput composes printable text through the armed modifiers (Ctrl/Alt/Shift) then clears;
              onKeyDown forwards keys that emit no input data (Enter/Backspace/Tab/Esc/arrows/nav), with
              Shift+Tab→back-tab. Same for pane + shell. onMouseDown on the accessory buttons
              preventDefault so tapping a key never steals focus (the native keyboard stays up). */}
          <div style={{ display: 'flex', gap: 6, padding: '7px 2px 0', flex: '0 0 auto' }}>
            <input
              defaultValue="" inputMode="text" autoCapitalize="off" autoCorrect="off" spellCheck={false}
              autoFocus={kind === 'shell'}
              placeholder={anyMod
                ? `${ctrlArmed ? '⌃' : ''}${altArmed ? '⌥' : ''}${shiftArmed ? '⇧' : ''} armed — next key composes`
                : `type — keystrokes go live to ${kind === 'shell' ? 'the shell' : (sessionTarget ?? 'the head')} ↑`}
              onInput={(e) => {
                const el = e.target as HTMLInputElement;
                const v = el.value;
                el.value = '';
                if (!v) return;
                if (ctrlRef.current || altRef.current || shiftRef.current) { sendChar(v[0]); if (v.length > 1) postBytes(v.slice(1)); }
                else postBytes(v);   // fast path — paste/autocorrect batches straight through
              }}
              onKeyDown={(e) => {
                if (e.key === 'Tab') { sendSeq(shiftRef.current || e.shiftKey ? '\x1b[Z' : '\t'); e.preventDefault(); return; }
                if (SPECIAL_KEYS[e.key]) { sendSeq(SPECIAL_KEYS[e.key]); e.preventDefault(); }
              }}
              style={{ flex: 1, background: '#04070a', color: anyMod ? C.amber : C.green, border: `1px solid ${anyMod ? C.amber : C.line2}`, borderRadius: C.radius, fontFamily: C.mono, fontSize: 16, padding: '8px 9px', caretColor: C.green }} />
          </div>
        </>
        );
      })()}
      </div>
    </div>
  );
}
