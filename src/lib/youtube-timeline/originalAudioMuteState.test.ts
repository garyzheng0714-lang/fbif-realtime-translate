import { describe, expect, it } from 'vitest';
import { consumeTimelineOriginalAudioMutedState } from './originalAudioMuteState';

describe('consumeTimelineOriginalAudioMutedState', () => {
  it('returns the saved muted state once and clears it before async restore work runs', () => {
    const ref = {
      current: {
        tabId: 7,
        videoId: 'video-123',
        previousMuted: false,
      },
    };

    expect(consumeTimelineOriginalAudioMutedState(ref)).toEqual({
      tabId: 7,
      videoId: 'video-123',
      previousMuted: false,
    });
    expect(ref.current).toBeNull();
    expect(consumeTimelineOriginalAudioMutedState(ref)).toBeNull();
  });
});
