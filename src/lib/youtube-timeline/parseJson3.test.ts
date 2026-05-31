import { describe, expect, it } from 'vitest';
import { parseYouTubeJson3 } from './parseJson3';

describe('parseYouTubeJson3', () => {
  it('joins text segments and returns stable cue timing', () => {
    const result = parseYouTubeJson3({
      events: [
        {
          tStartMs: 1250,
          dDurationMs: 2100,
          segs: [{ utf8: 'Hello' }, { utf8: ' world' }],
        },
      ],
    });

    expect(result).toEqual([
      {
        id: 'yt-1250-3350-0',
        startMs: 1250,
        endMs: 3350,
        sourceText: 'Hello world',
      },
    ]);
  });

  it('drops empty formatting events', () => {
    const result = parseYouTubeJson3({
      events: [
        { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: '\n' }] },
        { tStartMs: 1000, dDurationMs: 1000 },
      ],
    });

    expect(result).toEqual([]);
  });

  it('returns no cues for non-object payloads', () => {
    expect(parseYouTubeJson3(null)).toEqual([]);
    expect(parseYouTubeJson3('not-json')).toEqual([]);
  });

  it('uses the next cue start as end when duration is missing', () => {
    const result = parseYouTubeJson3({
      events: [
        { tStartMs: 1000, segs: [{ utf8: 'First' }] },
        { tStartMs: 2600, dDurationMs: 900, segs: [{ utf8: 'Second' }] },
      ],
    });

    expect(result[0].endMs).toBe(2600);
    expect(result[1].endMs).toBe(3500);
  });

  it('skips empty formatting events when finding the next cue boundary', () => {
    const result = parseYouTubeJson3({
      events: [
        { tStartMs: 1000, segs: [{ utf8: 'First' }] },
        { tStartMs: 1500, dDurationMs: 300, segs: [{ utf8: '\n' }] },
        { tStartMs: 2600, dDurationMs: 900, segs: [{ utf8: 'Second' }] },
      ],
    });

    expect(result[0].endMs).toBe(2600);
    expect(result[1].startMs).toBe(2600);
  });

  it('uses a finite zero duration as the cue end', () => {
    const result = parseYouTubeJson3({
      events: [
        { tStartMs: 1000, dDurationMs: 0, segs: [{ utf8: 'Instant' }] },
        { tStartMs: 2600, dDurationMs: 900, segs: [{ utf8: 'Second' }] },
      ],
    });

    expect(result[0].endMs).toBe(1000);
  });

  it('falls back from negative duration instead of creating inverted timelines', () => {
    const result = parseYouTubeJson3({
      events: [
        { tStartMs: 1000, dDurationMs: -500, segs: [{ utf8: 'First' }] },
        { tStartMs: 1500, dDurationMs: 300, segs: [{ utf8: '\n' }] },
        { tStartMs: 2600, dDurationMs: 900, segs: [{ utf8: 'Second' }] },
      ],
    });

    expect(result[0].endMs).toBe(2600);
    expect(result[0].endMs).toBeGreaterThanOrEqual(result[0].startMs);
  });

  // WHY: YouTube ASR rolling captions emit overlapping [tStartMs, tStartMs+dDurationMs]
  // ranges. If endMs is allowed to exceed the next cue's startMs, getActiveCue matches
  // the stale earlier cue and TTS schedules two clips into the same window (overlapping
  // dubbing). Clamping endMs to the next start keeps cue windows non-overlapping.
  it('clamps a cue end that would overlap the next cue start', () => {
    const result = parseYouTubeJson3({
      events: [
        { tStartMs: 1000, dDurationMs: 3000, segs: [{ utf8: 'First' }] },
        { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: 'Second' }] },
      ],
    });

    expect(result[0].endMs).toBe(2000);
    expect(result[0].endMs).toBeLessThanOrEqual(result[1].startMs);
    expect(result[1].endMs).toBe(3000);
  });

  // WHY: innertube android fallback and segmented/appended caption tracks do not
  // guarantee events arrive in ascending tStartMs order. Downstream getCueWindow,
  // getActiveCue and conversation rendering all assume cues are sorted by startMs,
  // so an out-of-order input would silently mis-window captions and pick the wrong
  // nextStartMs for end clamping.
  it('sorts out-of-order events by start time and computes ends from real neighbours', () => {
    const result = parseYouTubeJson3({
      events: [
        { tStartMs: 3000, dDurationMs: 900, segs: [{ utf8: 'Third' }] },
        { tStartMs: 1000, dDurationMs: 5000, segs: [{ utf8: 'First' }] },
        { tStartMs: 2000, dDurationMs: 500, segs: [{ utf8: 'Second' }] },
      ],
    });

    expect(result.map((cue) => cue.sourceText)).toEqual(['First', 'Second', 'Third']);
    expect(result.map((cue) => cue.startMs)).toEqual([1000, 2000, 3000]);
    expect(result[0].endMs).toBe(2000);
    expect(result[1].endMs).toBe(2500);
  });
});
