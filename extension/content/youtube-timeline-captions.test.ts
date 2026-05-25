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
      type: 'fbif:youtube-timeline:v2:set-original-audio-muted',
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
      type: 'fbif:youtube-timeline:v2:set-original-audio-muted',
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
      listener?.({ type: 'fbif:youtube-timeline:v2:get-captions' }, {}, resolve);
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

  it('falls back to Android player captions when the web timedtext track is empty', async () => {
    const video = { muted: false };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl.includes('/watch?')) {
        return {
          ok: true,
          text: async () => `
            <script>
              window.ytInitialPlayerResponse = {
                "videoDetails": { "videoId": "video-123", "title": "Fresh video title" },
                "captions": {
                  "playerCaptionsTracklistRenderer": {
                    "captionTracks": [{
                      "baseUrl": "https://www.youtube.com/api/timedtext?source=web&v=video-123&lang=en",
                      "languageCode": "en",
                      "name": { "simpleText": "English" },
                      "kind": "asr",
                      "isTranslatable": true
                    }]
                  }
                }
              };
              window.ytInitialData = { "INNERTUBE_API_KEY": "test-key" };
            </script>
          `,
        };
      }

      if (requestUrl.includes('/youtubei/v1/player')) {
        return {
          ok: true,
          json: async () => ({
            playabilityStatus: { status: 'OK' },
            captions: {
              playerCaptionsTracklistRenderer: {
                captionTracks: [{
                  baseUrl: 'https://www.youtube.com/api/timedtext?source=android&v=video-123&lang=en&fmt=srv3',
                  languageCode: 'en',
                  name: { simpleText: 'English' },
                  kind: 'asr',
                  isTranslatable: true,
                }],
              },
            },
          }),
        };
      }

      if (requestUrl.includes('source=web')) {
        return {
          ok: true,
          text: async () => '',
        };
      }

      if (requestUrl.includes('source=android')) {
        return {
          ok: true,
          text: async () => JSON.stringify({
            events: [
              {
                tStartMs: 2500,
                dDurationMs: 1000,
                segs: [{ utf8: 'Android fallback caption' }],
              },
            ],
          }),
        };
      }

      throw new Error(`Unexpected fetch ${requestUrl} ${JSON.stringify(init)}`);
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
      listener?.({ type: 'fbif:youtube-timeline:v2:get-captions' }, {}, resolve);
    });

    expect(response).toMatchObject({
      ok: true,
      payload: {
        videoId: 'video-123',
        title: 'Fresh video title',
        sourceLanguage: 'en',
      },
    });
    expect(response.payload.json3.events[0].segs[0].utf8).toBe('Android fallback caption');

    const androidCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/youtubei/v1/player'));
    expect(androidCall).toBeTruthy();
    expect(androidCall?.[0]).toBe('https://www.youtube.com/youtubei/v1/player?key=test-key');
    expect(androidCall?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
      },
    });
    expect(JSON.parse(String(androidCall?.[1]?.body))).toMatchObject({
      context: {
        client: {
          clientName: 'ANDROID',
          clientVersion: '20.10.38',
        },
      },
      videoId: 'video-123',
      contentCheckOk: true,
      racyCheckOk: true,
    });
  });

  it('installs a v2 listener even when an already-open page has the stale v1 loaded flag', () => {
    let listener: ((message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => void) | null = null;
    const context = vm.createContext({
      URL,
      fetch,
      console,
      window: {
        location: { href: 'https://www.youtube.com/watch?v=video-123' },
        __fbifYoutubeTimelineCaptionsLoaded__: true,
      },
      document: {
        scripts: [],
        title: 'Video',
        querySelector: vi.fn((selector: string) => (
          selector === 'video'
            ? { currentTime: 12.5, duration: 60, paused: false, muted: false }
            : null
        )),
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

    const response = new Promise<any>((resolve) => {
      listener?.({ type: 'fbif:youtube-timeline:v2:get-video-time' }, {}, resolve);
    });

    return expect(response).resolves.toMatchObject({
      ok: true,
      payload: {
        currentTimeMs: 12500,
        durationMs: 60000,
        paused: false,
        videoId: 'video-123',
      },
    });
  });
});
