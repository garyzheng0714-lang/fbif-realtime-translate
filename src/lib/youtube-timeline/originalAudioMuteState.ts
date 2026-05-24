export interface TimelineOriginalAudioMutedState {
  tabId: number;
  videoId: string;
  previousMuted: boolean;
}

interface MutableRefLike<T> {
  current: T;
}

export function consumeTimelineOriginalAudioMutedState(
  ref: MutableRefLike<TimelineOriginalAudioMutedState | null>,
): TimelineOriginalAudioMutedState | null {
  const state = ref.current;
  ref.current = null;
  return state;
}
