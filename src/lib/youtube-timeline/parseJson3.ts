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
  const events = getEvents(payload);
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
    const endMs = typeof durationMs === 'number' &&
      Number.isFinite(durationMs) &&
      durationMs >= 0
      ? startMs + durationMs
      : nextStartMs ?? startMs + 2500;

    cues.push({
      id: `yt-${startMs}-${endMs}-${cues.length}`,
      startMs,
      endMs,
      sourceText: text,
    });
  });

  return cues;
}
