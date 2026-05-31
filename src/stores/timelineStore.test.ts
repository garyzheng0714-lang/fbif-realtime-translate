import { beforeEach, describe, expect, it, vi } from 'vitest';
import useTimelineStore from './timelineStore';

describe('timelineStore.setPlaying', () => {
  beforeEach(() => {
    useTimelineStore.getState().resetTimeline();
  });

  it('transitions to playing with the given activeCueId', () => {
    // Baseline behaviour: the first tick must move the timeline into the
    // playing state and record which cue is active so the UI can highlight it.
    useTimelineStore.getState().setPlaying('cue-1');
    expect(useTimelineStore.getState().status).toBe('playing');
    expect(useTimelineStore.getState().activeCueId).toBe('cue-1');
  });

  it('does not write to the store when activeCueId is unchanged while already playing', () => {
    // WHY: MainPanel's tick calls setPlaying(activeCue?.id) every 350ms with the
    // SAME cue id for the whole duration a caption is on screen. A zustand set()
    // always notifies every subscribeWithSelector listener (each runs its
    // selector + equality check), even when nothing actually changed. Making
    // setPlaying idempotent keeps the timeline store quiet between cue
    // transitions instead of churning ~3 times/second for no observable change.
    useTimelineStore.getState().setPlaying('cue-1');

    const listener = vi.fn();
    const unsubscribe = useTimelineStore.subscribe(listener);
    useTimelineStore.getState().setPlaying('cue-1');
    unsubscribe();

    expect(listener).not.toHaveBeenCalled();
  });

  it('writes to the store when the active cue changes', () => {
    // A genuine cue transition MUST still notify listeners, otherwise the
    // highlighted caption would never advance.
    useTimelineStore.getState().setPlaying('cue-1');

    const listener = vi.fn();
    const unsubscribe = useTimelineStore.subscribe(listener);
    useTimelineStore.getState().setPlaying('cue-2');
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(useTimelineStore.getState().activeCueId).toBe('cue-2');
  });

  it('writes to the store when entering playing from a non-playing status', () => {
    // Coming out of prebuffering/translating into playing is a real state
    // change that listeners must see, even if activeCueId happens to match.
    useTimelineStore.getState().setLoadingCaptions('video-1');

    const listener = vi.fn();
    const unsubscribe = useTimelineStore.subscribe(listener);
    useTimelineStore.getState().setPlaying(null);
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(useTimelineStore.getState().status).toBe('playing');
  });

  it('clears a prior error when transitioning into playing', () => {
    // If a previous error was set, the first playing tick must clear it so the
    // UI stops showing the error banner. This is a real change and must notify.
    useTimelineStore.getState().setError('boom');

    const listener = vi.fn();
    const unsubscribe = useTimelineStore.subscribe(listener);
    useTimelineStore.getState().setPlaying('cue-1');
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(useTimelineStore.getState().error).toBeNull();
  });
});
