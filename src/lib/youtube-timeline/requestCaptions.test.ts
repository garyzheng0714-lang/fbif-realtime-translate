import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  requestCaptions,
  setYouTubeOriginalAudioMutedInTab,
  setYouTubeOriginalAudioMutedFromActiveTab,
  requestYouTubeVideoTimeFromActiveTab,
  YOUTUBE_TIMELINE_CAPTION_REQUEST,
  YOUTUBE_TIMELINE_ORIGINAL_AUDIO_MUTE_REQUEST,
  YOUTUBE_TIMELINE_VIDEO_TIME_REQUEST,
} from './requestCaptions';

const activeYouTubeTab = {
  id: 7,
  url: 'https://www.youtube.com/watch?v=video-123',
  title: 'Fallback title',
};

function installChromeMock(response: unknown) {
  const query = vi.fn((_queryInfo, callback) => {
    callback([activeYouTubeTab]);
  });
  const sendMessage = vi.fn((_tabId, _message, callback) => {
    callback(response);
  });

  (globalThis as any).chrome = {
    runtime: {
      lastError: undefined,
    },
    tabs: {
      query,
      sendMessage,
    },
  };

  return { query, sendMessage };
}

describe('requestCaptions', () => {
  afterEach(() => {
    delete (globalThis as any).chrome;
  });

  it('parses json3 from the content script payload contract', async () => {
    const { sendMessage } = installChromeMock({
      ok: true,
      payload: {
        videoId: 'video-123',
        title: 'Real video title',
        sourceLanguage: 'en',
        tracks: [
          {
            baseUrl: 'https://example.test/timedtext',
            languageCode: 'en',
            name: 'English',
            isTranslatable: true,
          },
        ],
        json3: {
          events: [
            {
              tStartMs: 1000,
              dDurationMs: 1500,
              segs: [{ utf8: 'Hello timeline' }],
            },
          ],
        },
      },
    });

    const result = await requestCaptions();

    expect(sendMessage).toHaveBeenCalledWith(
      activeYouTubeTab.id,
      { type: YOUTUBE_TIMELINE_CAPTION_REQUEST },
      expect.any(Function),
    );
    expect(result).toMatchObject({
      videoId: 'video-123',
      title: 'Real video title',
      sourceLanguage: 'en',
      cues: [
        {
          id: 'yt-1000-2500-0',
          startMs: 1000,
          endMs: 2500,
          sourceText: 'Hello timeline',
        },
      ],
    });
  });

  it('uses v2 message types so stale listeners on already-open YouTube pages do not answer', () => {
    expect(YOUTUBE_TIMELINE_CAPTION_REQUEST).toBe('fbif:youtube-timeline:v2:get-captions');
    expect(YOUTUBE_TIMELINE_VIDEO_TIME_REQUEST).toBe('fbif:youtube-timeline:v2:get-video-time');
    expect(YOUTUBE_TIMELINE_ORIGINAL_AUDIO_MUTE_REQUEST).toBe('fbif:youtube-timeline:v2:set-original-audio-muted');
  });

  it('preserves content script error codes from ok:false responses', async () => {
    installChromeMock({
      ok: false,
      error: {
        code: 'no_caption_tracks',
        message: 'No caption tracks were found for this YouTube video.',
      },
    });

    await expect(requestCaptions()).rejects.toMatchObject({
      code: 'no_caption_tracks',
      message: 'No caption tracks were found for this YouTube video.',
    });
  });

  it('injects the timeline content script and retries when an existing YouTube tab has no fresh receiver', async () => {
    const successResponse = {
      ok: true,
      payload: {
        videoId: 'video-123',
        title: 'Real video title',
        sourceLanguage: 'en',
        tracks: [
          {
            baseUrl: 'https://example.test/timedtext',
            languageCode: 'en',
            name: 'English',
            isTranslatable: true,
          },
        ],
        json3: {
          events: [
            {
              tStartMs: 1000,
              dDurationMs: 1500,
              segs: [{ utf8: 'Hello after injection' }],
            },
          ],
        },
      },
    };
    const query = vi.fn((_queryInfo, callback) => {
      callback([activeYouTubeTab]);
    });
    const sendMessage = vi.fn((_tabId, _message, callback) => {
      const chromeMock = (globalThis as any).chrome;
      if (sendMessage.mock.calls.length === 1) {
        chromeMock.runtime.lastError = { message: 'The message port closed before a response was received.' };
        callback(undefined);
        chromeMock.runtime.lastError = undefined;
        return;
      }
      callback(successResponse);
    });
    const executeScript = vi.fn((_details, callback) => {
      callback?.([{ frameId: 0 }]);
    });

    (globalThis as any).chrome = {
      runtime: {
        lastError: undefined,
      },
      tabs: {
        query,
        sendMessage,
      },
      scripting: {
        executeScript,
      },
    };

    const result = await requestCaptions();

    expect(executeScript).toHaveBeenCalledWith(
      {
        target: { tabId: activeYouTubeTab.id },
        files: ['youtube-timeline-captions.js'],
      },
      expect.any(Function),
    );
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(result.cues[0]?.sourceText).toBe('Hello after injection');
  });

  it('requests the active YouTube tab video time through the content script', async () => {
    const { sendMessage } = installChromeMock({
      ok: true,
      payload: {
        currentTimeMs: 12500,
        durationMs: 60000,
        paused: false,
        videoId: 'video-123',
      },
    });

    const result = await requestYouTubeVideoTimeFromActiveTab();

    expect(sendMessage).toHaveBeenCalledWith(
      activeYouTubeTab.id,
      { type: YOUTUBE_TIMELINE_VIDEO_TIME_REQUEST },
      expect.any(Function),
    );
    expect(result).toEqual({
      currentTimeMs: 12500,
      durationMs: 60000,
      paused: false,
      videoId: 'video-123',
    });
  });

  it('preserves content script error codes when video time is unavailable', async () => {
    installChromeMock({
      ok: false,
      error: {
        code: 'no_video',
        message: 'No video element was found.',
      },
    });

    await expect(requestYouTubeVideoTimeFromActiveTab()).rejects.toMatchObject({
      code: 'no_video',
      message: 'No video element was found.',
    });
  });

  it('sets the active YouTube tab original audio muted state through the content script', async () => {
    const { sendMessage } = installChromeMock({
      ok: true,
      payload: {
        previousMuted: false,
        currentMuted: true,
        videoId: 'video-123',
      },
    });

    const result = await setYouTubeOriginalAudioMutedFromActiveTab(true);

    expect(sendMessage).toHaveBeenCalledWith(
      activeYouTubeTab.id,
      { type: YOUTUBE_TIMELINE_ORIGINAL_AUDIO_MUTE_REQUEST, muted: true, videoId: 'video-123' },
      expect.any(Function),
    );
    expect(result).toEqual({
      tabId: activeYouTubeTab.id,
      videoId: 'video-123',
      previousMuted: false,
      currentMuted: true,
    });
  });

  it('restores original audio in the specified tab without querying the active tab', async () => {
    const { query, sendMessage } = installChromeMock({
      ok: true,
      payload: {
        previousMuted: true,
        currentMuted: false,
        videoId: 'video-123',
      },
    });

    const result = await setYouTubeOriginalAudioMutedInTab(17, false, 'video-123');

    expect(query).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      17,
      { type: YOUTUBE_TIMELINE_ORIGINAL_AUDIO_MUTE_REQUEST, muted: false, videoId: 'video-123' },
      expect.any(Function),
    );
    expect(result).toEqual({
      tabId: 17,
      videoId: 'video-123',
      previousMuted: true,
      currentMuted: false,
    });
  });

  it('preserves content script error codes when original audio mute has no video element', async () => {
    installChromeMock({
      ok: false,
      error: {
        code: 'no_video',
        message: 'No video element was found.',
      },
    });

    await expect(setYouTubeOriginalAudioMutedFromActiveTab(true)).rejects.toMatchObject({
      code: 'no_video',
      message: 'No video element was found.',
    });
  });

  it('preserves content script error codes when restoring a mismatched YouTube video tab', async () => {
    const { query } = installChromeMock({
      ok: false,
      error: {
        code: 'no_video',
        message: 'Expected YouTube video video-123, but current page video is video-456.',
      },
    });

    await expect(setYouTubeOriginalAudioMutedInTab(17, false, 'video-123')).rejects.toMatchObject({
      code: 'no_video',
      message: 'Expected YouTube video video-123, but current page video is video-456.',
    });
    expect(query).not.toHaveBeenCalled();
  });
});
