import type { CuePlaybackDecision } from './timelinePlaybackDecisions';

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
