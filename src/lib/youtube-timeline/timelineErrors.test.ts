import { describe, expect, it } from 'vitest';
import { getTimelineUserMessage, NO_CAPTION_TRACKS_MESSAGE } from './timelineErrors';

describe('getTimelineUserMessage', () => {
  it('maps only no_caption_tracks to the user-facing fallback copy', () => {
    const error = Object.assign(new Error('No caption tracks were found.'), { code: 'no_caption_tracks' });

    expect(getTimelineUserMessage(error)).toBe(NO_CAPTION_TRACKS_MESSAGE);
  });

  it('preserves other timeline errors', () => {
    const error = Object.assign(new Error('Active tab is not a YouTube page'), { code: 'not_youtube' });

    expect(getTimelineUserMessage(error)).toBe('Active tab is not a YouTube page');
  });
});
