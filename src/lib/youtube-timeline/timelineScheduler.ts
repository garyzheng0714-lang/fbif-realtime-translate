import type { TimelineCue } from './types';

export function getCueWindow(
  cues: TimelineCue[],
  currentTimeMs: number,
  prebufferMs: number,
): TimelineCue[] {
  return cues.filter((cue) => (
    cue.endMs >= currentTimeMs &&
    cue.startMs <= currentTimeMs + prebufferMs
  ));
}

export function getActiveCue(cues: TimelineCue[], currentTimeMs: number): TimelineCue | null {
  return cues.find((cue) => (
    cue.startMs <= currentTimeMs &&
    cue.endMs >= currentTimeMs
  )) ?? null;
}

export function shouldDropPreparedCue(cue: TimelineCue, currentTimeMs: number): boolean {
  return cue.endMs < currentTimeMs;
}
