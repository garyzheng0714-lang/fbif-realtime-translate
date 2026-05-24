import { describe, expect, it } from 'vitest';
import { getActiveCue, getCueWindow, shouldDropPreparedCue } from './timelineScheduler';
import type { TimelineCue } from './types';

const cues: TimelineCue[] = [
  {
    id: 'a',
    startMs: 0,
    endMs: 2000,
    sourceText: 'First',
  },
  {
    id: 'b',
    startMs: 3000,
    endMs: 5000,
    sourceText: 'Second',
  },
  {
    id: 'c',
    startMs: 8000,
    endMs: 9000,
    sourceText: 'Third',
  },
];

describe('timelineScheduler', () => {
  it('returns cues whose active windows overlap the prebuffer window', () => {
    expect(getCueWindow(cues, 2500, 7000).map((cue) => cue.id)).toEqual(['b', 'c']);
  });

  it('does not return cues that have already expired', () => {
    expect(getCueWindow(cues, 5200, 3000).map((cue) => cue.id)).toEqual(['c']);
  });

  it('returns the active cue at the current timeline position', () => {
    expect(getActiveCue(cues, 3200)?.id).toBe('b');
    expect(getActiveCue(cues, 7000)).toBeNull();
  });

  it('drops prepared cues only after their end time has passed', () => {
    expect(shouldDropPreparedCue(cues[0], 2000)).toBe(false);
    expect(shouldDropPreparedCue(cues[0], 2001)).toBe(true);
  });
});
