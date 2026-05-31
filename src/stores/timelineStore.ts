import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { TimelineCue, YouTubeTimelineResponse } from '../lib/youtube-timeline/types';

export type TimelineStatus =
  | 'idle'
  | 'loading_captions'
  | 'captions_ready'
  | 'translating'
  | 'prebuffering'
  | 'playing'
  | 'error';

interface TimelineState {
  status: TimelineStatus;
  videoId: string | null;
  title: string;
  cues: TimelineCue[];
  activeCueId: string | null;
  error: string | null;
}

interface TimelineActions {
  setLoadingCaptions: (videoId?: string | null, title?: string) => void;
  setCaptionsReady: (response: YouTubeTimelineResponse) => void;
  setPlaying: (activeCueId?: string | null) => void;
  setError: (error: string | Error) => void;
  resetTimeline: () => void;
}

type TimelineStore = TimelineState & TimelineActions;

const initialTimelineState: TimelineState = {
  status: 'idle',
  videoId: null,
  title: '',
  cues: [],
  activeCueId: null,
  error: null,
};

const getErrorMessage = (error: string | Error): string => (
  typeof error === 'string' ? error : error.message
);

const useTimelineStore = create<TimelineStore>()(
  subscribeWithSelector((set, get) => ({
    ...initialTimelineState,

    setLoadingCaptions: (videoId = null, title = '') => {
      set({
        status: 'loading_captions',
        videoId,
        title,
        cues: [],
        activeCueId: null,
        error: null,
      });
    },

    setCaptionsReady: (response) => {
      set({
        status: 'captions_ready',
        videoId: response.videoId,
        title: response.title,
        cues: response.cues,
        activeCueId: null,
        error: null,
      });
    },

    setPlaying: (activeCueId = null) => {
      // MainPanel's tick calls this ~3x/second with the same activeCueId for
      // the whole duration a caption is on screen. A zustand set() always
      // notifies every subscribeWithSelector listener regardless of whether
      // the value changed, so short-circuit when nothing would actually move.
      const current = get();
      if (
        current.status === 'playing' &&
        current.activeCueId === activeCueId &&
        current.error === null
      ) {
        return;
      }
      set({
        status: 'playing',
        activeCueId,
        error: null,
      });
    },

    setError: (error) => {
      set({
        status: 'error',
        error: getErrorMessage(error),
      });
    },

    resetTimeline: () => {
      set(initialTimelineState);
    },
  })),
);

export default useTimelineStore;

export const useTimelineStatus = () => useTimelineStore((state) => state.status);
export const useTimelineVideoId = () => useTimelineStore((state) => state.videoId);
export const useTimelineTitle = () => useTimelineStore((state) => state.title);
export const useTimelineCues = () => useTimelineStore((state) => state.cues);
export const useTimelineActiveCueId = () => useTimelineStore((state) => state.activeCueId);
export const useTimelineError = () => useTimelineStore((state) => state.error);

export const useSetLoadingCaptions = () => useTimelineStore((state) => state.setLoadingCaptions);
export const useSetCaptionsReady = () => useTimelineStore((state) => state.setCaptionsReady);
export const useSetTimelinePlaying = () => useTimelineStore((state) => state.setPlaying);
export const useSetTimelineError = () => useTimelineStore((state) => state.setError);
export const useResetTimeline = () => useTimelineStore((state) => state.resetTimeline);
