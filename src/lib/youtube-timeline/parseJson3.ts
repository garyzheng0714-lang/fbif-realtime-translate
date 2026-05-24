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

export function parseYouTubeJson3(payload: Json3Payload): TimelineCue[] {
  const events = Array.isArray(payload.events) ? payload.events : [];
  const cues: TimelineCue[] = [];

  events.forEach((event, index) => {
    const startMs = Number(event.tStartMs);
    if (!Number.isFinite(startMs)) return;

    const text = normalizeCaptionText(
      (event.segs || []).map((segment) => segment.utf8 || '').join(''),
    );
    if (!text) return;

    const nextStartMs = events
      .slice(index + 1)
      .map((candidate) => Number(candidate.tStartMs))
      .find((value) => Number.isFinite(value) && value > startMs);
    const durationMs = Number(event.dDurationMs);
    const endMs = Number.isFinite(durationMs) && durationMs > 0
      ? startMs + durationMs
      : nextStartMs || startMs + 2500;

    cues.push({
      id: `yt-${startMs}-${endMs}-${cues.length}`,
      startMs,
      endMs,
      sourceText: text,
    });
  });

  return cues;
}
