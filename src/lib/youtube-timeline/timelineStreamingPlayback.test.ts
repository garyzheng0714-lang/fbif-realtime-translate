import { describe, expect, it } from 'vitest';
import { decideStreamingCueAction, type StreamingCueState } from './timelineStreamingPlayback';

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
