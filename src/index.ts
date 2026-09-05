// @charlotte/agent-console-kit — shared agent-console primitives.
// SINGLE SOURCE OF TRUTH: both hydra-hq and merritt import from here. Fix a bug once, both get it.
// The crown jewels (v0.2): the PTY-over-SSE terminal engine + the slash-command composer,
// parameterized (sessionTarget/apiBase — hydra-hq PR #122 pinned the contract). Consumers
// provide react + xterm (peer deps).
export { default as HeadTerminal, type HeadTerminalProps } from './HeadTerminal';
export { default as Composer } from './Composer';
export { type SlashCommand, type CommandsResponse } from './types';
export { default as TuiKeyboard } from './TuiKeyboard';
export { default as RichMarkdown, CodeBlock, DiffBlock, looksLikeDiff, InlineText, PathToken, isPathToken } from './render/RichMarkdown';
export { default as PreviewDock } from './render/PreviewDock';
export { tokenize, type TokClass } from './render/highlight';
export { safeUrl } from './render/sanitizeUrl';
export { C } from './render/tokens';
export { visiblePoll } from './usePoll';
export { useMediaQuery, useIsMobile, MOBILE_QUERY } from './useMediaQuery';

// ❓ explain / ✍️ sharpen — the Sonnet sidecar (v0.10.0). Transport-agnostic: the consumer supplies
// a `postWorkshop(payload)` callback and its turn `adapter`; the kit owns the state machine + UI.
// Pure logic (ported from hydra-hq's explain.ts) + two hooks + five drop-in components.
export {
  EXPLAIN_CONTEXT_TURNS, explainRequest, followupThread, priorContext,
  turnIndexOfNode, resolveSelection, flatTurnAdapter, blockTurnAdapter,
  type ExplainAdapter, type ExplainPair, type ExplainRequest, type FlatTurn, type BlockTurn,
} from './workshop/explain';
export {
  useExplain, useSharpen,
  TurnExplainButton, SelectionExplainChip, ExplainCard, SharpenButton, OpenQuestionsStrip,
  type WorkshopPost, type ExplainCardState, type SelChip,
} from './workshop/WorkshopSidecar';

// StatusLine — the console's bottom data-line (busy/idle indicator, name + model, live context/output
// tokens, ⊟ compact + ♻️ refresh controls, account Claude-limit bars, responsive shedding). v0.11.0:
// TRANSPORT-AGNOSTIC — the consumer polls the data + supplies the action callbacks; the kit owns the
// rendering + the small controls' state machines. Ported from hydra-hq. See src/status/.
export { default as StatusLine, fmtTok, fmtUsd, type StatusLineProps } from './status/StatusLine';
export { default as CompactButton, urgency, AMBER_AT, RED_AT, BLINK_AT, type CompactButtonProps } from './status/CompactButton';
export { default as ConsolidateRefreshButton, type ConsolidateRefreshButtonProps } from './status/ConsolidateRefreshButton';
export { default as InterruptButton, type InterruptButtonProps } from './status/InterruptButton';
export {
  type HeadStatus, type SessionUsage, type Limits, type ModelLimit,
  type CompactAction, type RefreshAction, type InterruptAction,
} from './status/types';

// fit-to-width arithmetic behind HeadTerminal's mirror font (v0.11.1) — pure, reusable by consumers.
export {
  createFitter, fitFontSize, nextFit, rowProjectionFont,
  CHAR_RATIO_DEFAULT, MIRROR_FS_MIN, MIRROR_FS_MAX, FS_STEP, FIT_MAX_PASSES, ROW_PROJECTION_FS_MAX,
  type FitState, type Fitter, type FitterIO,
} from './fitFont';
