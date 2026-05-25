import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const scriptPath = path.resolve(process.cwd(), 'extension/content/youtube-timeline-captions.js');

function installContentScript(video: { muted: boolean }, href = 'https://www.youtube.com/watch?v=video-123') {
  let listener: ((message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => void) | null = null;
  const context = vm.createContext({
    URL,
    fetch,
    console,
    window: { location: { href } },
    document: {
      scripts: [],
      title: 'Video',
      querySelector: vi.fn((selector: string) => (selector === 'video' ? video : null)),
    },
    chrome: {
      runtime: {
        onMessage: {
          addListener: vi.fn((callback) => {
            listener = callback;
          }),
        },
      },
    },
  });

  vm.runInContext(fs.readFileSync(scriptPath, 'utf8'), context);

  return {
    send(message: unknown) {
      if (!listener) throw new Error('Content script listener was not installed');
      let response: unknown;
      listener(message, {}, (value) => {
        response = value;
      });
      return response;
    },
    sendAsync(message: unknown) {
      if (!listener) throw new Error('Content script listener was not installed');
      return new Promise((resolve) => {
        listener(message, {}, resolve);
      });
    },
  };
}

describe('youtube timeline captions content script', () => {
  it('rejects non-boolean original audio mute messages without changing the video', () => {
    const video = { muted: false };
    const contentScript = installContentScript(video);

    const response = contentScript.send({
      type: 'fbif:youtube-timeline:set-original-audio-muted',
      muted: 'false',
      videoId: 'video-123',
    });

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'caption_fetch_failed',
        message: 'YouTube original audio muted value must be a boolean.',
      },
    });
    expect(video.muted).toBe(false);
  });

  it('rejects non-string videoId in original audio mute messages without changing the video', () => {
    const video = { muted: false };
    const contentScript = installContentScript(video);

    const response = contentScript.send({
      type: 'fbif:youtube-timeline:set-original-audio-muted',
      muted: true,
      videoId: 123,
    });

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'caption_fetch_failed',
        message: 'YouTube original audio videoId must be a string when provided.',
      },
    });
    expect(video.muted).toBe(false);
  });

  it('loads a fresh watch page player response when the current SPA page has no usable player response', async () => {
    const video = { muted: false };
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/watch?')) {
        return {
          ok: true,
          text: async () => `
            <script>
              var ytInitialPlayerResponse = {
                "videoDetails": { "videoId": "video-123", "title": "Fresh video title" },
                "captions": {
                  "playerCaptionsTracklistRenderer": {
                    "captionTracks": [{
                      "baseUrl": "https://www.youtube.com/api/timedtext?v=video-123&lang=en",
                      "languageCode": "en",
                      "name": { "simpleText": "English" },
                      "kind": "asr",
                      "isTranslatable": true
                    }]
                  }
                }
              };
            </script>
          `,
        };
      }
      return {
        ok: true,
        text: async () => JSON.stringify({
          events: [
            {
              tStartMs: 1000,
              dDurationMs: 1500,
              segs: [{ utf8: 'Fresh caption' }],
            },
          ],
        }),
      };
    });
    let listener: ((message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => void) | null = null;
    const context = vm.createContext({
      URL,
      fetch: fetchMock,
      console,
      window: { location: { href: 'https://www.youtube.com/watch?v=video-123&t=42s' } },
      document: {
        scripts: [],
        title: 'SPA Video',
        querySelector: vi.fn((selector: string) => (selector === 'video' ? video : null)),
      },
      chrome: {
        runtime: {
          onMessage: {
            addListener: vi.fn((callback) => {
              listener = callback;
            }),
          },
        },
      },
    });
    vm.runInContext(fs.readFileSync(scriptPath, 'utf8'), context);

    const response = await new Promise<any>((resolve) => {
      listener?.({ type: 'fbif:youtube-timeline:get-captions' }, {}, resolve);
    });

    expect(response).toMatchObject({
      ok: true,
      payload: {
        videoId: 'video-123',
        title: 'Fresh video title',
        sourceLanguage: 'en',
      },
    });
    expect(response.payload.json3.events[0].segs[0].utf8).toBe('Fresh caption');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.youtube.com/watch?v=video-123&hl=en&persist_hl=1',
      { credentials: 'include' },
    );
  });
});
