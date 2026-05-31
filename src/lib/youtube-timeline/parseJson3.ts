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

interface ParsedEvent {
  startMs: number;
  durationMs: number | undefined;
  text: string;
}

function getDurationMs(event: Json3Event): number | undefined {
  const durationMs = event.dDurationMs;
  return typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0
    ? durationMs
    : undefined;
}

export function parseYouTubeJson3(payload: unknown): TimelineCue[] {
  // Filter out events that cannot become a cue (no finite tStartMs, no caption text)
  // BEFORE sorting. The old comparator did `Number(a.tStartMs) - Number(b.tStartMs)`,
  // so a tStartMs-less event produced NaN comparisons; a NaN-returning comparator
  // leaves the sort order undefined per spec and V8's TimSort can scramble the order
  // of the *valid* events too. Filtering first keeps only finite keys in the
  // comparator, and every downstream consumer (getCueWindow, getActiveCue,
  // conversation rendering) relies on the resulting ascending startMs order.
  const parsed: ParsedEvent[] = getEvents(payload)
    .map((event) => ({
      startMs: Number(event.tStartMs),
      durationMs: getDurationMs(event),
      text: getCaptionText(event),
    }))
    .filter((event) => Number.isFinite(event.startMs) && event.text.length > 0)
    .sort((a, b) => a.startMs - b.startMs);

  // Collapse repeated events that share a tStartMs. YouTube ASR rolling captions
  // re-emit the same line under the same tStartMs as it is refined; keeping every
  // emission would produce multiple fully-overlapping cues that are simultaneously
  // active, so getActiveCue / getCueWindow would schedule two TTS clips into one
  // slot (overlapping dubbing). Keep the LAST emission for each start — it is the
  // most complete version of that line.
  const deduped: ParsedEvent[] = [];
  for (const event of parsed) {
    const previous = deduped[deduped.length - 1];
    if (previous && previous.startMs === event.startMs) {
      deduped[deduped.length - 1] = event;
    } else {
      deduped.push(event);
    }
  }

  return deduped.map((event, index) => {
    const { startMs, durationMs, text } = event;
    // After de-duplication every later event has a strictly greater start, so the
    // immediate successor is the next cue boundary.
    const nextStartMs = index + 1 < deduped.length ? deduped[index + 1].startMs : undefined;
    const rawEndMs = durationMs !== undefined ? startMs + durationMs : nextStartMs ?? startMs + 2500;

    // Clamp the end to the next cue's start so overlapping ASR rolling-caption
    // ranges cannot produce cues that are simultaneously active. When the raw end
    // already overlaps the next start, degrade to nextStartMs instead of inverting.
    const endMs = nextStartMs !== undefined ? Math.min(rawEndMs, nextStartMs) : rawEndMs;

    return {
      // The id is the de-dupe key used by mergeNewCues across repeated live
      // re-fetches, so it must depend only on stable content. Earlier ids embedded
      // the running index and the next-start-clamped endMs, both of which shift
      // between fetches when an earlier event's text/parsability changes; the same
      // line then got a new id and was appended (and re-dubbed) as a duplicate.
      // startMs + sourceText identifies a caption line stably across fetches.
      id: `yt-${startMs}-${text}`,
      startMs,
      endMs,
      sourceText: text,
    };
  });
}
