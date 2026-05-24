import { parseYouTubeJson3 } from './parseJson3';
import type { TimelineError, YouTubeCaptionTrack, YouTubeTimelineResponse } from './types';

export const YOUTUBE_TIMELINE_CAPTION_REQUEST = 'fbif:youtube-timeline:get-captions';

type TimelineErrorCode = TimelineError['code'];

interface ChromeTabsWithMessages {
  query(queryInfo: { active: boolean; currentWindow: boolean }, callback: (tabs: ChromeTab[]) => void): void;
  query(queryInfo: { active: boolean; currentWindow: boolean }): Promise<ChromeTab[]>;
  sendMessage(tabId: number, message: unknown, callback?: (response: unknown) => void): Promise<unknown> | void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return isRecord(value) && typeof value.then === 'function';
}

function isTimelineErrorCode(value: unknown): value is TimelineErrorCode {
  return (
    value === 'not_youtube' ||
    value === 'no_video' ||
    value === 'no_caption_tracks' ||
    value === 'caption_fetch_failed' ||
    value === 'caption_parse_failed'
  );
}

function createTimelineError(code: TimelineErrorCode, message: string): Error & { code: TimelineErrorCode } {
  const error = new Error(message) as Error & { code: TimelineErrorCode };
  error.code = code;
  return error;
}

function getChromeTabs(): { chromeApi: Chrome; tabs: ChromeTabsWithMessages } {
  const chromeApi = typeof chrome === 'undefined' ? undefined : chrome;
  const tabs = chromeApi?.tabs as ChromeTabsWithMessages | undefined;
  if (!chromeApi || !tabs?.query || !tabs?.sendMessage) {
    throw createTimelineError('caption_fetch_failed', 'Chrome tabs API is unavailable');
  }
  return { chromeApi, tabs };
}

function getVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./, '');
    if (hostname === 'youtu.be') return parsed.pathname.split('/').filter(Boolean)[0] ?? null;
    if (hostname !== 'youtube.com' && !hostname.endsWith('.youtube.com')) return null;
    if (parsed.pathname === '/watch') return parsed.searchParams.get('v');
    const shortVideoId = parsed.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1];
    return shortVideoId ?? null;
  } catch {
    return null;
  }
}

function isYouTubeUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return hostname === 'youtu.be' || hostname === 'youtube.com' || hostname.endsWith('.youtube.com');
  } catch {
    return false;
  }
}

function queryActiveTab(chromeApi: Chrome, tabs: ChromeTabsWithMessages): Promise<ChromeTab[]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    try {
      const maybePromise = tabs.query({ active: true, currentWindow: true }, (result) => {
        const runtimeError = chromeApi.runtime.lastError;
        if (runtimeError) {
          settle(() => reject(createTimelineError('caption_fetch_failed', runtimeError.message ?? 'Failed to query active tab')));
          return;
        }
        settle(() => resolve(result));
      });

      if (isPromiseLike<ChromeTab[]>(maybePromise)) {
        maybePromise.then(
          (result) => settle(() => resolve(result)),
          (error) => settle(() => reject(error)),
        );
      }
    } catch (error) {
      settle(() => reject(error));
    }
  });
}

function sendCaptionRequest(chromeApi: Chrome, tabs: ChromeTabsWithMessages, tabId: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    try {
      const maybePromise = tabs.sendMessage(
        tabId,
        { type: YOUTUBE_TIMELINE_CAPTION_REQUEST },
        (response) => {
          const runtimeError = chromeApi.runtime.lastError;
          if (runtimeError) {
            settle(() => reject(createTimelineError('caption_fetch_failed', runtimeError.message ?? 'Failed to request captions')));
            return;
          }
          settle(() => resolve(response));
        },
      );

      if (isPromiseLike<unknown>(maybePromise)) {
        maybePromise.then(
          (response) => settle(() => resolve(response)),
          (error) => settle(() => reject(error)),
        );
      }
    } catch (error) {
      settle(() => reject(error));
    }
  });
}

function getResponseError(response: Record<string, unknown>): { code: TimelineErrorCode; message: string } | null {
  if (response.ok !== false && response.success !== false) return null;
  const error = response.error;
  const code = isRecord(error) && isTimelineErrorCode(error.code)
    ? error.code
    : isTimelineErrorCode(response.code)
      ? response.code
      : 'caption_fetch_failed';
  const message = isRecord(error) && typeof error.message === 'string'
    ? error.message
    : typeof response.message === 'string'
      ? response.message
      : 'Failed to fetch captions';
  return { code, message };
}

function isCaptionTrack(value: unknown): value is YouTubeCaptionTrack {
  return (
    isRecord(value) &&
    typeof value.baseUrl === 'string' &&
    typeof value.languageCode === 'string' &&
    typeof value.name === 'string' &&
    typeof value.isTranslatable === 'boolean'
  );
}

function parseTimelineResponse(response: unknown, tab: ChromeTab, fallbackVideoId: string): YouTubeTimelineResponse {
  if (!isRecord(response)) {
    throw createTimelineError('caption_fetch_failed', 'Content script returned an invalid caption response');
  }

  const responseError = getResponseError(response);
  if (responseError) {
    throw createTimelineError(responseError.code, responseError.message);
  }

  const payload = isRecord(response.payload) ? response.payload : response;
  const json3 = response.ok === true ? payload.json3 : response.json3 ?? response.captionJson3 ?? response.captions ?? response;
  const cues = parseYouTubeJson3(json3);
  if (cues.length === 0) {
    throw createTimelineError('caption_parse_failed', 'No usable caption cues were parsed');
  }

  const tracks = Array.isArray(payload.tracks) ? payload.tracks.filter(isCaptionTrack) : [];
  const sourceLanguage = typeof payload.sourceLanguage === 'string'
    ? payload.sourceLanguage
    : tracks[0]?.languageCode ?? '';

  return {
    videoId: typeof payload.videoId === 'string' ? payload.videoId : fallbackVideoId,
    title: typeof payload.title === 'string' ? payload.title : tab.title ?? '',
    sourceLanguage,
    tracks,
    cues,
  };
}

export async function requestCaptions(): Promise<YouTubeTimelineResponse> {
  const { chromeApi, tabs } = getChromeTabs();
  const [tab] = await queryActiveTab(chromeApi, tabs);
  if (!tab?.id) {
    throw createTimelineError('no_video', 'No active tab was found');
  }
  if (!isYouTubeUrl(tab.url)) {
    throw createTimelineError('not_youtube', 'Active tab is not a YouTube page');
  }

  const videoId = getVideoId(tab.url);
  if (!videoId) {
    throw createTimelineError('no_video', 'Active YouTube tab does not contain a video id');
  }

  try {
    const response = await sendCaptionRequest(chromeApi, tabs, tab.id);
    return parseTimelineResponse(response, tab, videoId);
  } catch (error) {
    if (error instanceof Error && isTimelineErrorCode((error as Error & { code?: unknown }).code)) {
      throw error;
    }
    if (isRecord(error) && isTimelineErrorCode(error.code)) {
      throw createTimelineError(error.code, typeof error.message === 'string' ? error.message : 'Timeline request failed');
    }
    const message = error instanceof Error ? error.message : 'Failed to request captions';
    throw createTimelineError('caption_fetch_failed', message);
  }
}
