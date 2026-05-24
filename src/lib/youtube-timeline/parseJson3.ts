import type { TimelineCue } from './types';

interface Json3Segment {
  utf8?: string;
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Json3Segment[];
}

interface Json3Payload {
  events?: Json3Event[];
}

function normalizeCaptionText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function getCaptionText(event: Json3Event): string {
  return normalizeCaptionText(
    (event.segs || []).map((segment) => segment.utf8 || '').join(''),
  );
}

export function parseYouTubeJson3(payload: Json3Payload): TimelineCue[] {
  const events = Array.isArray(payload.events) ? payload.events : [];
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
    const endMs = typeof durationMs === 'number' && Number.isFinite(durationMs)
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
