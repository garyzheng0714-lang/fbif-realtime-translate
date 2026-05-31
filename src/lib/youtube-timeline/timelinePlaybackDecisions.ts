import type { ConversationItem } from '../../services/clients';
import type { TimelineCue } from './types';

export interface DetectSeekOptions {
  // How much faster than wall-clock the video may advance before we treat it as
  // a user scrub rather than a slow tick. Forward drift below this is jitter.
  jumpToleranceMs: number;
  // Minimum trustworthy wall-clock measurement. Below this we cannot tell a stall
  // from a seek, so we conservatively do NOT flag a seek (avoid teardown churn).
  minElapsedMs: number;
}

/**
 * Decide whether the video position moved because the user scrubbed (a real
 * seek) or because a tick was simply slow (the main thread stalled and the
 * video naturally kept playing).
 *
 * The previous heuristic compared two sampled video positions and flagged a
 * seek whenever they differed by more than a fixed threshold. A blocked main
 * thread makes consecutive samples arbitrarily far apart even with no user
 * input, so it mistook stalls for seeks and tore the session down — which made
 * the next tick slower still (the avalanche described in findings 5 & 14).
 *
 * The real signal is the gap between how far the video advanced and how much
 * wall-clock actually elapsed between the two samples. Normal playback advances
 * the video by ~elapsed; a forward scrub advances it by far more; any backward
 * jump cannot be explained by playback at all.
 */
export function detectSeek(
  prevVideoTimeMs: number | null,
  currVideoTimeMs: number,
  elapsedWallClockMs: number | null,
  opts: DetectSeekOptions,
): boolean {
  if (prevVideoTimeMs === null) return false;

  const advance = currVideoTimeMs - prevVideoTimeMs;

  // Backward movement is never produced by forward playback -> always a seek.
  if (advance < 0) {
    // ...but only if we trust the measurement enough to act. A tiny negative
    // jitter inside tolerance is still just jitter.
    if (-advance > opts.jumpToleranceMs) return true;
  }

  // Without a trustworthy elapsed measurement we cannot distinguish a stall from
  // a seek, so we must not tear down.
  if (elapsedWallClockMs === null || elapsedWallClockMs < opts.minElapsedMs) {
    return false;
  }

  // Forward: a seek is when the video advanced far beyond what wall-clock allows.
  return advance - elapsedWallClockMs > opts.jumpToleranceMs;
}

export type CuePlaybackDecision = 'play' | 'skip' | 'wait';

export interface ClassifyCuePlaybackParams {
  // The cue may start a little before now and still be worth playing.
  smallLeadMs: number;
  // Past start + this, starting would lag too far behind the caption.
  maxLateStartMs: number;
  // If less than this remains of the cue, it is not worth dubbing.
  minRemainingCueMs: number;
}

/**
 * Classify a cue's playback state relative to the current video position:
 *  - 'play' when the cue is at/near its start and there is enough left to dub,
 *  - 'skip' when we are too late, too little remains, or it already ended,
 *  - 'wait' when the cue is still further in the future than the lead window.
 *
 * Mirrors the per-cue gating that lived inline in the tick loop (findings 18 /
 * start-window handling) so it can be unit-tested away from React/timers.
 */
export function classifyCuePlayback(
  cue: TimelineCue,
  currentTimeMs: number,
  params: ClassifyCuePlaybackParams,
): CuePlaybackDecision {
  if (cue.endMs <= currentTimeMs) return 'skip';
  if (cue.endMs - currentTimeMs < params.minRemainingCueMs) return 'skip';
  if (currentTimeMs > cue.startMs + params.maxLateStartMs) return 'skip';
  if (cue.startMs > currentTimeMs + params.smallLeadMs) return 'wait';
  return 'play';
}

const FATAL_TIMELINE_ERROR_FRAGMENTS = [
  // Translation service unavailable / misconfigured — cannot recover per-cue.
  '视频同步模式需要先配置可用的文本翻译服务',
  // Video switched out from under the session — the whole session is invalid.
  '视频已切换',
  // Caption count mismatch means the translator contract is broken.
  '翻译结果数量不匹配',
];

const DISPOSED_ERROR_MESSAGES = new Set([
  'Timeline translation disposed',
  'Timeline TTS disposed',
]);

/**
 * Decide whether an error caught from the translate/TTS pipeline should kill the
 * whole timeline session (failTimeline) or be degraded to a per-cue skip.
 *
 * The old code threw on a single blank translation and let it bubble to
 * failTimeline, so one jittery Bing reply stopped the entire video (findings 9 /
 * 15). Only genuinely unrecoverable failures — translation engine unavailable,
 * the video being switched, a broken count contract — escalate. Disposed errors
 * are expected teardown noise and never escalate.
 */
export function shouldFailTimeline(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (DISPOSED_ERROR_MESSAGES.has(error.message)) return false;
  return FATAL_TIMELINE_ERROR_FRAGMENTS.some((fragment) => error.message.includes(fragment));
}

function hasUsableTranslation(cue: TimelineCue): boolean {
  return cue.translatedText !== undefined && cue.translatedText.trim() !== '';
}

/**
 * From a batch returned by translateTimelineCueBatch, keep only the cues that
 * actually received a non-blank translation.
 *
 *波1 changed translateTimelineCueBatch to return the ORIGINAL cue (translatedText
 * still undefined) on a blank reply instead of throwing. Storing such a cue in
 * the translated-cue map would permanently mark it "done" and it would never be
 * retried in a later window. Callers must only store the cues this returns
 * (finding 9).
 */
export function selectTranslatedCuesToStore(cues: TimelineCue[]): TimelineCue[] {
  return cues.filter(hasUsableTranslation);
}

/**
 * Overlay translated text onto a SUBSET of cues (e.g. the prebuffer window near
 * the playhead) using the by-id translation map.
 *
 * The tick previously mapped the whole cue list through the translation map on
 * every frame, allocating N objects every 350ms on a long video (finding 16).
 * Only the cues near the playhead actually need their translated text resolved,
 * so callers pass the small window here. Untranslated cues are returned by
 * reference (no allocation); translated cues come straight from the map.
 */
export function resolveTranslatedCues(
  cues: TimelineCue[],
  translatedById: ReadonlyMap<string, TimelineCue>,
): TimelineCue[] {
  return cues.map((cue) => translatedById.get(cue.id) ?? cue);
}

function timelineCueToConversationItem(cue: TimelineCue, baseTime: number): ConversationItem {
  const text = cue.translatedText!.trim();
  return {
    id: `timeline-${cue.id}`,
    role: 'assistant',
    type: 'message',
    status: 'completed',
    source: 'participant',
    createdAt: baseTime + cue.startMs,
    formatted: {
      text,
      transcript: text,
    },
  };
}

/**
 * Incrementally patch only the conversation items for the cues that were just
 * translated, instead of rebuilding the entire array from all cues on every
 * batch (findings 4 / 8). Untouched items are reused by reference so memo /
 * cross-process subtitle subscribers don't churn, and the result stays sorted
 * by start time so insertion order is stable.
 *
 * Returns the SAME array reference when nothing changed, so callers can skip a
 * needless setState.
 */
export function patchConversationItemsForCues(
  existing: ConversationItem[],
  cues: TimelineCue[],
  baseTime: number,
): ConversationItem[] {
  const usable = cues.filter(hasUsableTranslation);
  if (usable.length === 0) return existing;

  const byId = new Map(existing.map((item) => [item.id, item]));
  let changed = false;

  for (const cue of usable) {
    const id = `timeline-${cue.id}`;
    const prev = byId.get(id);
    const next = timelineCueToConversationItem(cue, baseTime);
    if (!prev || prev.formatted?.text !== next.formatted?.text) {
      byId.set(id, next);
      changed = true;
    }
  }

  if (!changed) return existing;

  return Array.from(byId.values()).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}
