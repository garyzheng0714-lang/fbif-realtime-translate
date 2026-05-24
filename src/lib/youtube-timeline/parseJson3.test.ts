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
});
