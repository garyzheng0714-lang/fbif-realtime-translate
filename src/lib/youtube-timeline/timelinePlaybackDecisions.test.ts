import { describe, expect, it } from 'vitest';
import type { ConversationItem } from '../../services/clients';
import type { TimelineCue } from './types';
import {
  detectSeek,
  classifyCuePlayback,
  shouldFailTimeline,
  selectTranslatedCuesToStore,
  patchConversationItemsForCues,
  resolveTranslatedCues,
} from './timelinePlaybackDecisions';

const cue = (over: Partial<TimelineCue> = {}): TimelineCue => ({
  id: 'c',
  startMs: 10_000,
  endMs: 13_000,
  sourceText: 'hello',
  translatedText: '你好',
  ...over,
});

describe('detectSeek', () => {
  // WHY: the old code flagged a seek whenever two ticks read video positions more
  // than 2s apart. When the main thread stalls (serial translate/TTS), a single
  // slow tick advances the *real* video clock past that threshold even though the
  // user never touched the scrubber, triggering a full teardown -> more stall ->
  // worse stall (the avalanche). The real signal is the gap between how far the
  // video advanced and how much wall-clock actually elapsed.
  const opts = { jumpToleranceMs: 1_000, minElapsedMs: 50 };

  it('does not flag a seek when the video advanced roughly as much as wall-clock elapsed (slow tick)', () => {
    // A tick took 3s of wall-clock (main thread blocked); the video naturally
    // advanced ~3s. Advance ≈ elapsed, so this is a stall, NOT a seek.
    expect(detectSeek(5_000, 8_050, 3_000, opts)).toBe(false);
  });

  it('flags a seek when the video jumped far beyond the elapsed wall-clock (forward scrub)', () => {
    // Only 400ms of wall-clock passed but the video jumped 30s forward.
    expect(detectSeek(5_000, 35_000, 400, opts)).toBe(true);
  });

  it('flags a seek when the video jumped backwards regardless of elapsed time', () => {
    // Backward jumps can never be explained by playback advancing.
    expect(detectSeek(35_000, 5_000, 400, opts)).toBe(true);
  });

  it('does not flag a seek on the first tick when there is no previous position', () => {
    expect(detectSeek(null, 5_000, 400, opts)).toBe(false);
  });

  it('does not flag a seek when wall-clock elapsed is unknown/too small to judge', () => {
    // Without a trustworthy elapsed measurement we must not tear down on a stall.
    expect(detectSeek(5_000, 9_000, 0, opts)).toBe(false);
    expect(detectSeek(5_000, 9_000, null, opts)).toBe(false);
  });

  it('allows small forward drift within tolerance (normal jitter)', () => {
    // Video advanced 1.3s while ~1s of wall-clock elapsed: 300ms drift is within
    // the 1s tolerance, so it is jitter, not a seek.
    expect(detectSeek(5_000, 6_300, 1_000, opts)).toBe(false);
  });

  // WHY: backward movement can NEVER be produced by forward playback, so any real
  // rewind is a seek regardless of how far it went. The old code gated the backward
  // branch on jumpToleranceMs (the FORWARD drift knob, 2000ms in production), so a
  // user rewinding the scrubber by less than that — e.g. 1s — was NOT flagged. The
  // dubbing pipeline then kept playing the pre-seek timeline against the rewound
  // video, desyncing audio from picture. Backward detection must be independent of
  // the forward tolerance, governed only by a tiny pure-jitter threshold.
  it('flags a real backward rewind smaller than the forward jump tolerance', () => {
    // jumpToleranceMs is 1000ms here; a 600ms rewind is below it but is still a
    // genuine seek, not forward jitter.
    expect(detectSeek(5_000, 4_400, 400, opts)).toBe(true);
  });

  it('still ignores sub-jitter negative noise in the video clock', () => {
    // A tiny negative jitter (<= the backward jitter floor) is not a real rewind.
    expect(detectSeek(5_000, 4_950, 400, opts)).toBe(false);
  });

  it('honours an explicit backwardToleranceMs override for the rewind floor', () => {
    // With a 700ms backward floor a 600ms rewind is treated as jitter, while a
    // 900ms rewind crosses it and is a seek — proving backward uses its own knob.
    const tuned = { ...opts, backwardToleranceMs: 700 };
    expect(detectSeek(5_000, 4_400, 400, tuned)).toBe(false);
    expect(detectSeek(5_000, 4_100, 400, tuned)).toBe(true);
  });
});

describe('classifyCuePlayback', () => {
  // WHY: the start window decides whether a cue's dubbing should play now, be
  // skipped (we are too late and would talk over the next caption), or wait
  // (the cue is still in the future). Getting this wrong either drops audio or
  // plays stale dubbing over a later caption.
  const params = { smallLeadMs: 150, maxLateStartMs: 750, minRemainingCueMs: 600 };

  it("returns 'play' when the cue is starting within the small lead window", () => {
    expect(classifyCuePlayback(cue({ startMs: 10_000, endMs: 13_000 }), 9_900, params)).toBe('play');
    expect(classifyCuePlayback(cue({ startMs: 10_000, endMs: 13_000 }), 10_100, params)).toBe('play');
  });

  it("returns 'wait' when the cue starts further in the future than the lead window", () => {
    expect(classifyCuePlayback(cue({ startMs: 10_000 }), 9_000, params)).toBe('wait');
  });

  it("returns 'skip' when we are past the max late-start window", () => {
    // 10_000 + 750 = 10_750; current 10_800 is too late to start without lagging.
    expect(classifyCuePlayback(cue({ startMs: 10_000, endMs: 13_000 }), 10_800, params)).toBe('skip');
  });

  it("returns 'skip' when too little of the cue remains to be worth dubbing", () => {
    // endMs 13_000, current 12_500 -> 500ms left < 600ms minimum.
    expect(classifyCuePlayback(cue({ startMs: 10_000, endMs: 13_000 }), 12_500, params)).toBe('skip');
  });

  it("returns 'skip' when the cue has already fully ended", () => {
    expect(classifyCuePlayback(cue({ startMs: 10_000, endMs: 13_000 }), 13_500, params)).toBe('skip');
  });
});

describe('shouldFailTimeline', () => {
  // WHY: a single blank Bing reply or one cue that fails TTS must NOT kill the
  // whole video session (the old fail-fast behaviour). Only an unrecoverable
  // engine/service error should escalate to failTimeline.
  it('escalates when the translation service is unavailable', () => {
    expect(shouldFailTimeline(new Error('视频同步模式需要先配置可用的文本翻译服务：boom'))).toBe(true);
  });

  it('escalates when the video was switched mid-session', () => {
    expect(shouldFailTimeline(new Error('视频已切换，请重新开始同步翻译'))).toBe(true);
  });

  it('does NOT escalate on a single empty-translation cue error (per-cue skip)', () => {
    expect(shouldFailTimeline(new Error('视频同步模式字幕翻译结果为空，已停止播放以避免朗读英文原文'))).toBe(false);
  });

  it('does NOT escalate on a transient/unknown per-cue error', () => {
    expect(shouldFailTimeline(new Error('edge-tts socket hiccup'))).toBe(false);
  });

  it('does NOT escalate on a disposed error (teardown in progress, expected)', () => {
    expect(shouldFailTimeline(new Error('Timeline translation disposed'))).toBe(false);
    expect(shouldFailTimeline(new Error('Timeline TTS disposed'))).toBe(false);
  });
});

describe('selectTranslatedCuesToStore', () => {
  // WHY:波1 changed translateTimelineCueBatch to return the original cue
  // (translatedText still undefined) for a blank reply instead of throwing.
  // Storing such a cue would mark it "translated" forever and the cue would
  // never be retried in a later window. Only cues that actually got text may
  // be stored; the rest are left for re-selection.
  it('keeps only cues whose translatedText is defined and non-blank', () => {
    const result = selectTranslatedCuesToStore([
      cue({ id: 'a', translatedText: '已译' }),
      cue({ id: 'b', translatedText: undefined }),
      cue({ id: 'c', translatedText: '   ' }),
    ]);
    expect(result.map((c) => c.id)).toEqual(['a']);
  });

  it('returns an empty array when nothing was translated', () => {
    expect(selectTranslatedCuesToStore([cue({ translatedText: undefined })])).toEqual([]);
  });
});

describe('patchConversationItemsForCues', () => {
  // WHY: rebuilding the entire systemAudioItems array on every translated batch
  // forced an O(n) memo recompute + a full cross-process subtitle push per batch.
  // We only ever add/replace the items for the cues that just got translated, so
  // we patch by id and keep a stable, time-sorted array. Items for cues NOT in
  // this batch must be preserved untouched.
  const baseTime = 1_000_000;
  const existing: ConversationItem[] = [
    {
      id: 'timeline-a',
      role: 'assistant',
      type: 'message',
      status: 'completed',
      source: 'participant',
      createdAt: baseTime + 1_000,
      formatted: { text: '旧A', transcript: '旧A' },
    },
  ];

  it('appends a new item for a freshly translated cue, sorted by start time', () => {
    const result = patchConversationItemsForCues(
      existing,
      [cue({ id: 'b', startMs: 500, endMs: 900, translatedText: '新B' })],
      baseTime,
    );
    expect(result.map((i) => i.id)).toEqual(['timeline-b', 'timeline-a']);
    expect(result.find((i) => i.id === 'timeline-b')?.formatted?.text).toBe('新B');
    // existing item object is reused (referential stability for memo)
    expect(result.find((i) => i.id === 'timeline-a')).toBe(existing[0]);
  });

  it('replaces an existing item in place when the same cue is re-translated', () => {
    const result = patchConversationItemsForCues(
      existing,
      [cue({ id: 'a', startMs: 1_000, endMs: 2_000, translatedText: '新A' })],
      baseTime,
    );
    expect(result.map((i) => i.id)).toEqual(['timeline-a']);
    expect(result[0].formatted?.text).toBe('新A');
  });

  it('skips cues with no usable translated text (does not create blank items)', () => {
    const result = patchConversationItemsForCues(
      existing,
      [cue({ id: 'c', translatedText: '   ' }), cue({ id: 'd', translatedText: undefined })],
      baseTime,
    );
    expect(result).toBe(existing);
  });

  it('returns the same array reference when no patch is needed (no churn)', () => {
    expect(patchConversationItemsForCues(existing, [], baseTime)).toBe(existing);
  });
});

describe('resolveTranslatedCues', () => {
  // WHY: the tick used to map ALL cues through the translation map every 350ms,
  // allocating N new objects per tick on a long video (finding 16). We only need
  // the translated text for the small window of cues near the playhead, so this
  // resolves a subset against the map, overlaying translatedText only where it
  // exists and reusing the ORIGINAL cue object (no allocation) when it doesn't.
  const a = cue({ id: 'a', translatedText: undefined });
  const b = cue({ id: 'b', translatedText: undefined });
  const translated = new Map<string, TimelineCue>([
    ['a', cue({ id: 'a', translatedText: '已译A' })],
  ]);

  it('overlays the translated cue where the map has it', () => {
    const [ra] = resolveTranslatedCues([a], translated);
    expect(ra.translatedText).toBe('已译A');
  });

  it('reuses the original cue object (no allocation) when untranslated', () => {
    const [rb] = resolveTranslatedCues([b], translated);
    expect(rb).toBe(b);
  });

  it('only resolves the cues passed in, not the whole timeline', () => {
    expect(resolveTranslatedCues([a, b], translated).map((c) => c.id)).toEqual(['a', 'b']);
  });
});
