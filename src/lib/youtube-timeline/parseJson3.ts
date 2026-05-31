import type { TimelineCue } from './types';

interface Json3Event {
  tStartMs?: unknown;
  dDurationMs?: unknown;
  segs?: unknown;
}

function normalizeCaptionText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function getEvents(payload: unknown): Json3Event[] {
  if (!isRecord(payload) || !Array.isArray(payload.events)) return [];
  return payload.events.filter(isRecord);
}

function getCaptionText(event: Json3Event): string {
  const segments = Array.isArray(event.segs) ? event.segs.filter(isRecord) : [];

  return normalizeCaptionText(
    segments.map((segment) => (
      typeof segment.utf8 === 'string' ? segment.utf8 : ''
    )).join(''),
  );
}

export function parseYouTubeJson3(payload: unknown): TimelineCue[] {
  // Sort by tStartMs first: segmented/appended caption tracks and the innertube
  // android fallback path do not guarantee ascending order, and every downstream
  // consumer (getCueWindow, getActiveCue, conversation rendering) assumes cues are
  // ordered by startMs. Sorting up front also makes nextStartMs lookups correct.
  const events = [...getEvents(payload)].sort(
    (a, b) => Number(a.tStartMs) - Number(b.tStartMs),
  );
  const cues: TimelineCue[] = [];

  events.forEach((event, index) => {
    const startMs = Number(event.tStartMs);
    if (!Number.isFinite(startMs)) return;

    const text = getCaptionText(event);
    if (!text) return;

    const nextCue = events.slice(index + 1).find((candidate) => {
      const candidateStartMs = Number(candidate.tStartMs);
      return (
        Number.isFinite(candidateStartMs) &&
        candidateStartMs > startMs &&
        Boolean(getCaptionText(candidate))
      );
    });
    const nextStartMs = nextCue ? Number(nextCue.tStartMs) : undefined;
    const durationMs = event.dDurationMs;
    const rawEndMs = typeof durationMs === 'number' &&
      Number.isFinite(durationMs) &&
      durationMs >= 0
      ? startMs + durationMs
      : nextStartMs ?? startMs + 2500;

    // Clamp the end to the next cue's start so overlapping ASR rolling-caption
    // ranges cannot produce cues that are simultaneously active. When the raw end
    // already overlaps the next start, degrade to nextStartMs instead of inverting.
    const endMs = nextStartMs !== undefined ? Math.min(rawEndMs, nextStartMs) : rawEndMs;

    cues.push({
      id: `yt-${startMs}-${endMs}-${cues.length}`,
      startMs,
      endMs,
      sourceText: text,
    });
  });

  return cues;
}
