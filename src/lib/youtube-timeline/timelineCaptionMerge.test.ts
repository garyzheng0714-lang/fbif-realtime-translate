import { describe, expect, it } from 'vitest';
import type { TimelineCue } from './types';
import { mergeNewCues } from './timelineCaptionMerge';

const cue = (over: Partial<TimelineCue> = {}): TimelineCue => ({
  id: 'c',
  startMs: 1_000,
  endMs: 2_000,
  sourceText: 'hello',
  ...over,
});

describe('mergeNewCues', () => {
  it('appends cues whose id is not already present', () => {
    const existing = [cue({ id: 'a', startMs: 1_000 })];
    const fetched = [
      cue({ id: 'a', startMs: 1_000 }),
      cue({ id: 'b', startMs: 2_000 }),
    ];
    const merged = mergeNewCues(existing, fetched);
    expect(merged.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('keeps the EXISTING cue object for an id already present, never the fetched copy', () => {
    // WHY: the existing cue may already carry a translation and be tracked by
    // reference in the prepared/translated maps. A live re-fetch returns the
    // untranslated source again; adopting it would silently wipe the translation
    // and could resurrect a cue the tick already retired.
    const translated = cue({ id: 'a', startMs: 1_000, translatedText: '你好' });
    const existing = [translated];
    const fetched = [cue({ id: 'a', startMs: 1_000 })]; // no translatedText
    const merged = mergeNewCues(existing, fetched);
    expect(merged[0]).toBe(translated);
    expect(merged[0].translatedText).toBe('你好');
  });

  it('returns the SAME array reference when no new cues arrived', () => {
    // WHY: a live re-fetch usually returns only already-seen ids; the caller
    // uses reference identity to skip a needless cues reassignment / setState.
    const existing = [cue({ id: 'a' }), cue({ id: 'b', startMs: 2_000 })];
    const fetched = [cue({ id: 'a' }), cue({ id: 'b', startMs: 2_000 })];
    expect(mergeNewCues(existing, fetched)).toBe(existing);
  });

  it('sorts the merged result by startMs so a late-arriving cue lands in order', () => {
    // WHY: a new live cue can arrive with a startMs between existing cues; the
    // tick's getCueWindow / getActiveCue assume start-sorted order.
    const existing = [cue({ id: 'a', startMs: 1_000 }), cue({ id: 'c', startMs: 3_000 })];
    const fetched = [cue({ id: 'b', startMs: 2_000 })];
    const merged = mergeNewCues(existing, fetched);
    expect(merged.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('handles an empty existing list by adopting all fetched cues', () => {
    const fetched = [cue({ id: 'a', startMs: 1_000 }), cue({ id: 'b', startMs: 2_000 })];
    expect(mergeNewCues([], fetched).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('returns the same (empty) reference when both sides are empty', () => {
    const existing: TimelineCue[] = [];
    expect(mergeNewCues(existing, [])).toBe(existing);
  });
});
