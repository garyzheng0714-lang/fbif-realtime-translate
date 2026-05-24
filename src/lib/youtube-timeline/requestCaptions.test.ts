import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestCaptions, YOUTUBE_TIMELINE_CAPTION_REQUEST } from './requestCaptions';

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
});
