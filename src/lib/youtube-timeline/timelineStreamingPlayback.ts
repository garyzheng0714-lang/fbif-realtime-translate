import { shouldFailTimeline, type CuePlaybackDecision } from './timelinePlaybackDecisions';

/**
 * Per-cue streaming TTS state tracked by the tick loop. The audio for one cue is
 * generated chunk-by-chunk by prepareCueAudio's onChunk callback; the tick drains
 * pendingChunkCount into the streaming track. This decouples "audio is being
 * buffered" from "this cue has started playing" so a long cue can start the
 * moment its first chunk lands instead of waiting for the whole sentence.
 */
export interface StreamingCueState {
  // Whether the first chunk has already been pushed to the streaming track.
  started: boolean;
  // Whether TTS generation for this cue has finished (no more chunks will arrive).
  generationDone: boolean;
  // How many buffered chunks have not yet been pushed to the streaming track.
  pendingChunkCount: number;
}

export type StreamingCueAction =
  // Push the buffered chunks and mark the cue started (first playback of this cue).
  | 'start'
  // Push the newly arrived buffered chunks to an already-started cue.
  | 'append'
  // Generation finished and every chunk has been drained: retire the cue.
  | 'finish'
  // The cue is not worth playing and has not started yet: drop its buffer.
  | 'drop'
  // Nothing to do this tick (waiting for the start window or for more chunks).
  | 'idle';

/**
 * Decide what the tick should do with one cue's streaming TTS buffer this frame.
 *
 * WHY this exists as a pure function: the streaming pipeline turns the old
 * "buffer the whole sentence, then play it atomically" into a small state
 * machine (start -> append* -> finish) that also has to honour the existing
 * start-window alignment and the "already-playing cues are never cut" rule. That
 * decision is exactly the kind of branching logic that is painful to verify
 * through React + timers, so it lives here and the tick only wires the side
 * effects (addAudioData / map + set bookkeeping).
 *
 * Invariants:
 *  - A cue only STARTS when classifyCuePlayback says 'play' AND at least one
 *    chunk is buffered. Starting with zero chunks would queue silence and burn
 *    the start window before any audio exists.
 *  - Once a cue has STARTED it is never dropped, even if the playback decision
 *    later becomes 'skip' (the playhead moved past its lenient start window).
 *    Cutting audio mid-sentence is worse than letting the tail finish, and the
 *    chunks are already aligned to the track.
 *  - A started cue only FINISHES when generation is done and no chunk is pending,
 *    so the whole tail is drained before the cue is retired and de-duplicated.
 *  - 'drop' applies only to a not-yet-started cue the scheduler decided to skip,
 *    mirroring the old `decision === 'skip'` branch that discarded the prepared
 *    buffer.
 */
export function decideStreamingCueAction(
  playbackDecision: CuePlaybackDecision,
  state: StreamingCueState,
): StreamingCueAction {
  if (state.started) {
    if (state.pendingChunkCount > 0) return 'append';
    if (state.generationDone) return 'finish';
    return 'idle';
  }

  // Not started yet.
  if (playbackDecision === 'skip') return 'drop';
  if (playbackDecision === 'wait') return 'idle';
  // playbackDecision === 'play': start only once we actually have audio to push.
  return state.pendingChunkCount > 0 ? 'start' : 'idle';
}

/** How prepareCueAudio's generation attempt ended for one cue. */
export type PrepareCueOutcome = 'completed' | 'failed';

/** Snapshot of the cue's prepared-audio entry at the moment generation ended. */
export interface PrepareCueEntryState {
  // Whether a prepared entry exists (the first chunk created it).
  hasPreparedEntry: boolean;
  // Whether the tick already flipped that entry to started (drained its first chunk).
  started: boolean;
}

/** Bookkeeping the tick loop must apply once a cue's TTS generation ends. */
export interface PrepareCueResolution {
  // Flag the entry generationDone so the tick's finish path drains the tail and
  // retires the cue. Only meaningful when an entry exists.
  markGenerationDone: boolean;
  // Delete the stale prepared entry outright (it never started, so nothing plays).
  deletePrepared: boolean;
  // Record the cue in the failed set so prepareCueAudio never re-picks it.
  markFailed: boolean;
}

/**
 * Decide how to settle a cue's prepared-audio bookkeeping once its TTS generation
 * ends, covering the two leak/re-send regressions the streaming rewrite missed:
 *
 *  - finding 2: a NON-BLANK cue can complete with ZERO chunks (edge-tts returns
 *    empty audio without firing onChunk). No entry is created, so the cue lands in
 *    none of the prepared / generating / queued / failed sets and every later tick
 *    fires a fresh edge-tts round trip for it. Marking it failed stops the storm.
 *
 *  - finding 5: a cue whose socket drops mid-stream after it already STARTED
 *    playing must be finished, not abandoned. The old catch only added it to the
 *    failed set, leaving {started:true, generationDone:false, chunks:[]} forever —
 *    decideStreamingCueAction returns 'idle' for that state, so the entry leaks and
 *    the dub is cut half-way. Flagging generationDone lets the tick drain + retire
 *    it. A failed cue that never started instead has its stale entry deleted.
 *
 * Pure so the start/finish/leak matrix is verifiable away from React + timers; the
 * tick only wires the three boolean side effects.
 */
export function resolvePrepareCueOutcome(
  outcome: PrepareCueOutcome,
  entry: PrepareCueEntryState,
): PrepareCueResolution {
  if (outcome === 'completed') {
    // A non-blank cue that produced no audio at all: poison it so it is never
    // re-sent (finding 2). With audio, just flag the tail done for the tick.
    if (!entry.hasPreparedEntry) {
      return { markGenerationDone: false, deletePrepared: false, markFailed: true };
    }
    return { markGenerationDone: true, deletePrepared: false, markFailed: false };
  }

  // outcome === 'failed': always a per-cue skip, plus clean up any entry (finding 5).
  if (entry.hasPreparedEntry) {
    return entry.started
      ? { markGenerationDone: true, deletePrepared: false, markFailed: true }
      : { markGenerationDone: false, deletePrepared: true, markFailed: true };
  }
  return { markGenerationDone: false, deletePrepared: false, markFailed: true };
}

/** What the tick should do after requestYouTubeVideoTimeFromTab throws. */
export type TickErrorAction = 'fail' | 'retry';

/**
 * Decide whether an error thrown while polling the video time should kill the
 * whole timeline session or just be swallowed so the next tick retries.
 *
 * WHY (finding 3): the tick reads video time every 350ms. A single transient
 * fault — a buffering hiccup that briefly reports NaN currentTime (now rejected
 * as caption_fetch_failed), a one-off chrome.runtime message timeout, the content
 * script mid-reinjection — is recoverable: the very next poll usually succeeds.
 * The old tick had no try/catch around the poll, so ANY such throw bubbled to
 * tick().catch(failTimeline) and tore the entire session down on the first blip,
 * forcing the user to manually restart. Only escalate when the error is genuinely
 * fatal (e.g. the video was switched), or when the same transient fault has
 * persisted across the consecutive-error budget (tab closed / content script gone
 * for good) — fail loud rather than spin forever.
 *
 * @param consecutiveErrors number of back-to-back tick errors INCLUDING this one.
 * @param maxConsecutiveErrors budget; at or above it a transient error escalates.
 */
export function decideTickErrorAction(
  error: unknown,
  consecutiveErrors: number,
  maxConsecutiveErrors: number,
): TickErrorAction {
  if (shouldFailTimeline(error)) return 'fail';
  return consecutiveErrors >= maxConsecutiveErrors ? 'fail' : 'retry';
}
