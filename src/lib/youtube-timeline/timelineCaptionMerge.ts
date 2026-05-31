import type { TimelineCue } from './types';

/**
 * Merge freshly fetched caption cues into the cues already held by an active
 * timeline session, for live / dynamically-growing caption tracks.
 *
 * A live stream keeps appending new cues to its caption track, but the session
 * only fetched the captions once at start, so it never picks up cues that
 * appeared later. Periodically re-fetching and merging here lets the playhead
 * eventually reach those new cues.
 *
 * Rules (the WHY):
 *  - De-dupe by id, and for an id that already exists keep the EXISTING cue by
 *    reference. The existing object may have been translated, queued, prepared,
 *    or be mid-playback (its translatedText / identity is tracked in by-id maps
 *    keyed off this very object); replacing it with a fresh fetch would drop the
 *    translation and could resurrect a cue the tick already retired.
 *  - Only cues whose id is NOT already present are appended. A re-fetch of a
 *    live track returns the whole (growing) list every time, so the vast
 *    majority are already-seen ids that must pass through untouched.
 *  - The result is sorted by startMs so a late-arriving cue lands in its correct
 *    time slot — the tick's getCueWindow / getActiveCue assume start order.
 *  - When nothing new arrived, the SAME array reference is returned so the
 *    caller can skip a needless cues reassignment / setState.
 */
export function mergeNewCues(existing: TimelineCue[], fetched: TimelineCue[]): TimelineCue[] {
  const existingIds = new Set(existing.map((cue) => cue.id));
  const additions = fetched.filter((cue) => !existingIds.has(cue.id));
  if (additions.length === 0) return existing;
  return [...existing, ...additions].sort((a, b) => a.startMs - b.startMs);
}
