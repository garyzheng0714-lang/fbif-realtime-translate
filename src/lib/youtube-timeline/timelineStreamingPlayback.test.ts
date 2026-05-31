import { describe, expect, it } from 'vitest';
import {
  decideStreamingCueAction,
  decideTickErrorAction,
  resolvePrepareCueOutcome,
  type StreamingCueState,
} from './timelineStreamingPlayback';

const state = (over: Partial<StreamingCueState> = {}): StreamingCueState => ({
  started: false,
  generationDone: false,
  pendingChunkCount: 0,
  ...over,
});

describe('decideStreamingCueAction', () => {
  // WHY: the whole point of streaming is that a long cue starts the instant its
  // first chunk exists instead of waiting for generateChinese to return the whole
  // sentence. So 'play' + at least one buffered chunk must begin playback now.
  it('starts a not-yet-started cue as soon as it is in the play window and has a chunk', () => {
    expect(decideStreamingCueAction('play', state({ pendingChunkCount: 1 }))).toBe('start');
  });

  // WHY: starting with zero buffered chunks would push nothing and burn the
  // lenient start window before any audio was generated, leaving a silent gap and
  // then a too-late cue. Wait until the first chunk actually lands.
  it('waits in the play window while no chunk has been buffered yet', () => {
    expect(decideStreamingCueAction('play', state({ pendingChunkCount: 0 }))).toBe('idle');
  });

  // WHY: a cue further in the future than the lead window is not ready to play;
  // its chunks may still be generating but must not be queued early.
  it('idles a future cue even if some chunks are already buffered', () => {
    expect(decideStreamingCueAction('wait', state({ pendingChunkCount: 2 }))).toBe('idle');
  });

  // WHY: this mirrors the old `decision === 'skip'` branch that discarded the
  // prepared buffer for a cue the playhead already passed before it ever started.
  it('drops a not-yet-started cue the scheduler decided to skip', () => {
    expect(decideStreamingCueAction('skip', state({ pendingChunkCount: 3 }))).toBe('drop');
  });

  // WHY: while a cue is playing, every later batch of chunks from TTS must be
  // pushed onto the same streaming track so the sentence continues seamlessly.
  it('appends newly arrived chunks to an already-started cue', () => {
    expect(decideStreamingCueAction('play', state({ started: true, pendingChunkCount: 2 }))).toBe('append');
  });

  // WHY: once a cue is playing, cutting it because the playhead drifted past the
  // lenient start window would chop the sentence mid-word. A started cue is never
  // dropped — its tail keeps appending/finishing regardless of the now-'skip'
  // classification.
  it('never drops a started cue even when the playback decision becomes skip', () => {
    expect(decideStreamingCueAction('skip', state({ started: true, pendingChunkCount: 1 }))).toBe('append');
    expect(decideStreamingCueAction('skip', state({ started: true, generationDone: true }))).toBe('finish');
  });

  // WHY: a started cue that has no pending chunks and whose generation is still
  // running must simply wait for the next chunk; it is neither finished nor idle-droppable.
  it('idles a started cue that is awaiting more chunks mid-generation', () => {
    expect(decideStreamingCueAction('play', state({ started: true, pendingChunkCount: 0, generationDone: false }))).toBe('idle');
  });

  // WHY: a cue is only retired (deleted + de-duplicated) once generation finished
  // AND every buffered chunk was drained, so the whole tail plays before cleanup.
  it('finishes a started cue only after generation is done and all chunks drained', () => {
    expect(decideStreamingCueAction('play', state({ started: true, pendingChunkCount: 0, generationDone: true }))).toBe('finish');
  });

  // WHY: even if generation finished, any pending chunk must be appended before
  // the cue can finish, otherwise the last chunk would be dropped on cleanup.
  it('appends remaining chunks before finishing even when generation is already done', () => {
    expect(decideStreamingCueAction('play', state({ started: true, pendingChunkCount: 1, generationDone: true }))).toBe('append');
  });
});

describe('resolvePrepareCueOutcome', () => {
  // WHY: a normal completion with at least one chunk just flags the entry done so
  // the tick can drain the tail and retire the cue. It is NOT a failure, so the
  // cue must not be poisoned into the failed set.
  it('flags generationDone on a normal completion that produced audio', () => {
    expect(resolvePrepareCueOutcome('completed', { hasPreparedEntry: true, started: true })).toEqual({
      markGenerationDone: true,
      deletePrepared: false,
      markFailed: false,
    });
  });

  // WHY (finding 2): edge-tts can resolve generateChinese for a non-blank cue
  // without ever firing onChunk (zero audio). No entry is created, so the old code
  // left the cue in NO set at all — every later tick re-entered prepareCueAudio and
  // fired a fresh edge-tts round trip every 350ms while the cue sat in the window.
  // A zero-chunk completion must mark the cue failed so it is never re-picked.
  it('marks a zero-chunk completion as failed so the tick never re-sends it', () => {
    expect(resolvePrepareCueOutcome('completed', { hasPreparedEntry: false, started: false })).toEqual({
      markGenerationDone: false,
      deletePrepared: false,
      markFailed: true,
    });
  });

  // WHY (finding 5): a long cue whose first chunk arrived and was already started
  // (tick set started=true, drained chunks) then has its edge-tts socket drop
  // mid-stream (a non-fatal error). The catch must flag the started entry done so
  // the tick's finish path drains the tail and DELETES the entry; otherwise the
  // entry sits forever as {started:true, generationDone:false, chunks:[]} →
  // decideStreamingCueAction returns 'idle' forever → entry leaks and the dub is
  // cut half-way with no completion.
  it('flags generationDone on a failed cue that had already started so the tick can finish and clean it up', () => {
    expect(resolvePrepareCueOutcome('failed', { hasPreparedEntry: true, started: true })).toEqual({
      markGenerationDone: true,
      deletePrepared: false,
      markFailed: true,
    });
  });

  // WHY (finding 5): a cue that failed before it ever started playing has a stale
  // prepared entry (chunks buffered but never drained). It must be deleted so it
  // does not leak, and marked failed so it is not retried for the session.
  it('deletes the prepared entry of a failed cue that never started', () => {
    expect(resolvePrepareCueOutcome('failed', { hasPreparedEntry: true, started: false })).toEqual({
      markGenerationDone: false,
      deletePrepared: true,
      markFailed: true,
    });
  });

  // WHY: a failure with no entry (TTS errored before any chunk) just records the
  // per-cue skip; there is nothing to clean up.
  it('only marks failed when a failed cue produced no entry', () => {
    expect(resolvePrepareCueOutcome('failed', { hasPreparedEntry: false, started: false })).toEqual({
      markGenerationDone: false,
      deletePrepared: false,
      markFailed: true,
    });
  });
});

describe('decideTickErrorAction', () => {
  const maxConsecutive = 3;

  // WHY (finding 3): requestYouTubeVideoTimeFromTab can throw caption_fetch_failed
  // for a TRANSIENT reason — a buffering hiccup makes video.currentTime NaN, or a
  // single chrome.runtime message times out / the content script is briefly
  // re-injecting. The old tick had no try/catch, so any such throw bubbled to
  // tick().catch(failTimeline) and killed the whole session on the FIRST blip. A
  // recoverable error inside the retry budget must just retry next tick.
  it('retries a transient video-time error on the first occurrence', () => {
    const transient = Object.assign(new Error('Content script returned an incomplete video time response'), {
      code: 'caption_fetch_failed' as const,
    });
    expect(decideTickErrorAction(transient, 1, maxConsecutive)).toBe('retry');
  });

  // WHY: a genuinely fatal error (the video was switched out from under the
  // session) must fail immediately regardless of the retry budget — retrying would
  // dub against the wrong video.
  it('fails immediately on a fatal error even on the first occurrence', () => {
    const fatal = new Error('视频已切换，请重新开始同步翻译');
    expect(decideTickErrorAction(fatal, 1, maxConsecutive)).toBe('fail');
  });

  // WHY: a transient fault that never clears (tab closed, content script gone for
  // good) would otherwise retry forever. Once the consecutive-error budget is
  // exhausted the session fails loudly instead of silently spinning.
  it('fails a transient error once the consecutive-error budget is exhausted', () => {
    const transient = Object.assign(new Error('Receiving end does not exist'), {
      code: 'caption_fetch_failed' as const,
    });
    expect(decideTickErrorAction(transient, maxConsecutive, maxConsecutive)).toBe('fail');
    // ...but still retries while strictly under the budget.
    expect(decideTickErrorAction(transient, maxConsecutive - 1, maxConsecutive)).toBe('retry');
  });
});
