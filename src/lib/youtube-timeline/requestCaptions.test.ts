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
