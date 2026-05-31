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
        id: 'yt-1250',
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

  // WHY: the innertube android fallback can mix in an event with no tStartMs. The
  // sort comparator did `Number(a.tStartMs) - Number(b.tStartMs)`, and for the
  // tStartMs-less event `Number(undefined)` is NaN, so every comparison involving
  // it returns NaN. ECMAScript leaves the result undefined when a comparator
  // returns NaN, and V8's TimSort can then scramble the relative order of the
  // *valid* events too — even though the bad event is filtered out afterwards. A
  // scrambled order silently mis-windows captions downstream. The valid cues must
  // stay in ascending startMs order no matter where the junk event sits.
  it('keeps valid cues in start order when an event without tStartMs is mixed in', () => {
    const result = parseYouTubeJson3({
      events: [
        { tStartMs: 3000, dDurationMs: 900, segs: [{ utf8: 'Third' }] },
        { dDurationMs: 900, segs: [{ utf8: 'Garbage' }] },
        { tStartMs: 1000, dDurationMs: 5000, segs: [{ utf8: 'First' }] },
        { tStartMs: 2000, dDurationMs: 500, segs: [{ utf8: 'Second' }] },
      ],
    });

    expect(result.map((cue) => cue.sourceText)).toEqual(['First', 'Second', 'Third']);
    expect(result.map((cue) => cue.startMs)).toEqual([1000, 2000, 3000]);
    // End clamping still uses the correct neighbour after sorting.
    expect(result[0].endMs).toBe(2000);
    expect(result[1].endMs).toBe(2500);
  });

  // WHY: a larger junk batch makes V8 actually switch from insertion sort to the
  // merge path, where a NaN-returning comparator most visibly corrupts unrelated
  // runs. Even then the valid, finite-tStartMs cues must come out fully sorted.
  it('survives many junk events without corrupting the valid cue order', () => {
    const events = [
      { tStartMs: 90, segs: [{ utf8: 'i' }] },
      { segs: [{ utf8: 'junk-a' }] },
      { tStartMs: 30, segs: [{ utf8: 'd' }] },
      { tStartMs: 70, segs: [{ utf8: 'g' }] },
      { segs: [{ utf8: 'junk-b' }] },
      { tStartMs: 10, segs: [{ utf8: 'b' }] },
      { tStartMs: 50, segs: [{ utf8: 'f' }] },
      { tStartMs: 20, segs: [{ utf8: 'c' }] },
      { segs: [{ utf8: 'junk-c' }] },
      { tStartMs: 80, segs: [{ utf8: 'h' }] },
      { tStartMs: 40, segs: [{ utf8: 'e' }] },
      { tStartMs: 5, segs: [{ utf8: 'a' }] },
    ];

    const result = parseYouTubeJson3({ events });
    const starts = result.map((cue) => cue.startMs);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(starts).toEqual([5, 10, 20, 30, 40, 50, 70, 80, 90]);
  });

  // WHY: YouTube ASR rolling captions repeatedly re-emit the SAME tStartMs for a
  // line being updated (e.g. two events both at tStartMs=2000). The nextCue lookup
  // required candidateStartMs > startMs (strictly greater), so a same-start sibling
  // was skipped and BOTH cues clamped their end to the next *different* start —
  // producing two fully overlapping cues that are simultaneously active. getActiveCue
  // / getCueWindow then schedule two TTS clips into one slot (overlapping dubbing),
  // the exact symptom clamping was meant to remove. Same-start duplicates must not
  // both stay active over the same window.
  it('does not leave two same-tStartMs cues simultaneously active over the same window', () => {
    const result = parseYouTubeJson3({
      events: [
        { tStartMs: 2000, dDurationMs: 3000, segs: [{ utf8: 'Rolling A' }] },
        { tStartMs: 2000, dDurationMs: 3000, segs: [{ utf8: 'Rolling B' }] },
        { tStartMs: 6000, dDurationMs: 1000, segs: [{ utf8: 'Next' }] },
      ],
    });

    const atSameStart = result.filter((cue) => cue.startMs === 2000);
    expect(atSameStart.length).toBeGreaterThan(0);

    // No instant in the window should have more than one same-start cue active.
    const overlapping = atSameStart.filter((a) =>
      atSameStart.some((b) => a !== b && b.startMs < a.endMs && a.startMs < b.endMs),
    );
    expect(overlapping).toEqual([]);
  });

  // WHY (finding 1): the cue id is the de-dupe key used by mergeNewCues across
  // repeated live re-fetches. The old id embedded the cues.length index AND the
  // next-start-clamped endMs, both of which shift between fetches when an earlier
  // event's text/parsability changes (ASR latency). The same caption line then got
  // a DIFFERENT id on the second fetch, mergeNewCues saw it as new, and appended a
  // duplicate — the line was translated/dubbed twice with subtitle ghosting. The id
  // must be derived only from stable content (startMs + sourceText), so the same
  // line keeps the same id regardless of index/endMs drift.
  it('derives a stable id from content, independent of index position and clamped end', () => {
    // First fetch: an early ASR event has not produced text yet, so the real line
    // sits at index 1 and its end is clamped by the following event at 4000.
    const first = parseYouTubeJson3({
      events: [
        { tStartMs: 1000, segs: [{ utf8: '' }] }, // empty -> dropped, shifts index
        { tStartMs: 2000, dDurationMs: 5000, segs: [{ utf8: 'Real line' }] },
        { tStartMs: 4000, dDurationMs: 1000, segs: [{ utf8: 'Later' }] },
      ],
    });

    // Second fetch 20s later: the early event now has text (index no longer shifts)
    // and the trailing event is gone, so the same line's endMs is no longer clamped.
    const second = parseYouTubeJson3({
      events: [
        { tStartMs: 1000, dDurationMs: 800, segs: [{ utf8: 'Now present' }] },
        { tStartMs: 2000, dDurationMs: 5000, segs: [{ utf8: 'Real line' }] },
      ],
    });

    const firstReal = first.find((cue) => cue.sourceText === 'Real line')!;
    const secondReal = second.find((cue) => cue.sourceText === 'Real line')!;
    // Despite different index and different clamped endMs across fetches, the id is
    // identical so mergeNewCues treats them as the same cue (no duplicate append).
    expect(firstReal.endMs).not.toBe(secondReal.endMs);
    expect(secondReal.id).toBe(firstReal.id);
  });

  // WHY: live ASR rolling captions refine the SAME line under the SAME tStartMs
  // over successive fetches ("Hello" -> "Hello world"). If the id embeds the text,
  // the refined emission gets a new id, mergeNewCues appends it as a brand-new cue
  // sharing the same startMs, and getActiveCue/getCueWindow then schedule two TTS
  // clips into one slot (duplicate dubbing + subtitle ghosting). The id must stay
  // stable across text refinement, so it derives from startMs alone.
  it('keeps a stable id when live ASR refines the same line text across fetches', () => {
    const first = parseYouTubeJson3({
      events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'Hello' }] }],
    });
    const second = parseYouTubeJson3({
      events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'Hello world' }] }],
    });

    expect(first[0].sourceText).toBe('Hello');
    expect(second[0].sourceText).toBe('Hello world');
    // Same line (same start), refined text -> same id so it is not re-dubbed.
    expect(second[0].id).toBe(first[0].id);
  });
});
