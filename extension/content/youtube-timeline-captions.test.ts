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

/**
 * Builds a DOM mock that distinguishes the YouTube main player video from
 * other <video> elements on the page (hover previews, ads, picture-in-picture).
 * The content script must target the main player; a plain
 * document.querySelector('video') returns whichever video is first in DOM
 * order, which is frequently NOT the main player.
 */
function installContentScriptWithVideos(
  videos: Array<Record<string, unknown>>,
  mainPlayerSelectorVideo: Record<string, unknown> | null,
  href = 'https://www.youtube.com/watch?v=video-123',
) {
  let listener: ((message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => void) | null = null;
  const context = vm.createContext({
    URL,
    fetch,
    console,
    window: { location: { href } },
    document: {
      scripts: [],
      title: 'Video',
      querySelector: vi.fn((selector: string) => {
        // The main-player-scoped selectors resolve to the real player.
        if (selector === '#movie_player video' || selector === '.html5-main-video') {
          return mainPlayerSelectorVideo;
        }
        // A bare 'video' selector returns DOM-order first, like the browser.
        if (selector === 'video') return videos[0] ?? null;
        return null;
      }),
      querySelectorAll: vi.fn((selector: string) => (selector === 'video' ? videos : [])),
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
  };
}

function makeVideoElement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    currentTime: 0,
    duration: 0,
    paused: true,
    muted: false,
    readyState: 0,
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    ...overrides,
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

  // Why this matters: getCaptions awaits a serial chain of network hops
  // (watch HTML -> timedtext -> innertube -> timedtext). None of them had a
  // timeout, so a single slow/hung hop (e.g. a stalled timedtext response)
  // would block caption fetching indefinitely and the user perceives "connected
  // but nothing happens, no first dubbed line". Every network fetch must carry
  // an abort signal so a stuck hop fails fast instead of hanging forever.
  it('attaches an abort timeout signal to every startup network fetch so a hung hop cannot block forever', async () => {
    const video = { muted: false };
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/watch?')) {
        return {
          ok: true,
          text: async () => `
            <script>
              var ytInitialPlayerResponse = {
                "videoDetails": { "videoId": "video-123", "title": "Title" },
                "captions": {
                  "playerCaptionsTracklistRenderer": {
                    "captionTracks": [{
                      "baseUrl": "https://www.youtube.com/api/timedtext?v=video-123&lang=en",
                      "languageCode": "en",
                      "name": { "simpleText": "English" },
                      "kind": "asr"
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
          events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Caption' }] }],
        }),
      };
    });
    let listener: ((message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => void) | null = null;
    const context = vm.createContext({
      URL,
      fetch: fetchMock,
      AbortSignal,
      console,
      window: { location: { href: 'https://www.youtube.com/watch?v=video-123' } },
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

    await new Promise<any>((resolve) => {
      listener?.({ type: 'fbif:youtube-timeline:v2:get-captions' }, {}, resolve);
    });

    expect(fetchMock).toHaveBeenCalled();
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit)?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  // Why this matters: the Android innertube call is the LAST caption fallback.
  // A hard-coded clientVersion ('20.10.38') will eventually be rejected by the
  // server as stale, silently killing the fallback. The page's own ytcfg /
  // INNERTUBE_CONTEXT carries the live client version; using it keeps the
  // fallback working as YouTube bumps its client without us redeploying.
  it('uses the live clientVersion from the page innertube context for the Android fallback', async () => {
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
              ytcfg.set({
                "INNERTUBE_API_KEY": "test-key",
                "INNERTUBE_CONTEXT": { "client": { "clientName": "WEB", "clientVersion": "2.20991231.99.99" } }
              });
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
        return { ok: true, text: async () => '' };
      }

      if (requestUrl.includes('source=android')) {
        return {
          ok: true,
          text: async () => JSON.stringify({
            events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Android caption' }] }],
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
      window: { location: { href: 'https://www.youtube.com/watch?v=video-123' } },
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

    await new Promise<any>((resolve) => {
      listener?.({ type: 'fbif:youtube-timeline:v2:get-captions' }, {}, resolve);
    });

    const androidCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/youtubei/v1/player'));
    const body = JSON.parse(String(androidCall?.[1]?.body));
    expect(body.context.client.clientVersion).toBe('2.20991231.99.99');
    expect(body.context.client.clientVersion).not.toBe('20.10.38');
  });

  // Why these matter: the 350ms tick reads getVideoTime().currentTime to drive
  // the entire subtitle/dubbing schedule, and setOriginalAudioMuted must mute
  // the ORIGINAL audio of the main player. Reading a hover-preview or ad <video>
  // (whose currentTime is unrelated to the main video) makes captions jump and
  // leaves the main audio un-muted (translated voice over original). The content
  // script must therefore resolve the main player, not DOM-order-first <video>.
  it('reads currentTime from the YouTube main player, not the DOM-first video element', () => {
    const previewVideo = makeVideoElement({ currentTime: 3.2, duration: 12, paused: false, readyState: 4 });
    const mainPlayerVideo = makeVideoElement({ currentTime: 42.5, duration: 600, paused: false, readyState: 4 });
    // DOM order puts the preview first; a bare querySelector('video') would pick it.
    const contentScript = installContentScriptWithVideos([previewVideo, mainPlayerVideo], mainPlayerVideo);

    const response = contentScript.send({ type: 'fbif:youtube-timeline:v2:get-video-time' }) as any;

    expect(response).toMatchObject({
      ok: true,
      payload: {
        currentTimeMs: 42500,
        durationMs: 600000,
        paused: false,
      },
    });
  });

  it('mutes the YouTube main player, not the DOM-first preview video', () => {
    const previewVideo = makeVideoElement({ muted: false, currentTime: 3.2, readyState: 4 });
    const mainPlayerVideo = makeVideoElement({ muted: false, currentTime: 42.5, readyState: 4 });
    const contentScript = installContentScriptWithVideos([previewVideo, mainPlayerVideo], mainPlayerVideo);

    const response = contentScript.send({
      type: 'fbif:youtube-timeline:v2:set-original-audio-muted',
      muted: true,
      videoId: 'video-123',
    }) as any;

    expect(response).toMatchObject({ ok: true, payload: { currentMuted: true } });
    expect(mainPlayerVideo.muted).toBe(true);
    // The unrelated preview video must be left untouched.
    expect(previewVideo.muted).toBe(false);
  });

  it('falls back to the playing video when no main-player selector matches', () => {
    // No #movie_player / .html5-main-video match (e.g. embed/shorts variant);
    // resolution must prefer an actually-playing video over a paused decoy.
    const pausedDecoy = makeVideoElement({ currentTime: 1, paused: true, readyState: 4, getBoundingClientRect: () => ({ width: 100, height: 60 }) });
    const playingMain = makeVideoElement({ currentTime: 77, duration: 300, paused: false, readyState: 4, getBoundingClientRect: () => ({ width: 50, height: 30 }) });
    const contentScript = installContentScriptWithVideos([pausedDecoy, playingMain], null);

    const response = contentScript.send({ type: 'fbif:youtube-timeline:v2:get-video-time' }) as any;

    expect(response).toMatchObject({ ok: true, payload: { currentTimeMs: 77000, paused: false } });
  });

  // Why this matters: the caller stores the previousMuted from the FIRST mute
  // to restore the original audio when the session ends. If a later set(true)
  // re-reads the live video.muted (now true, because the extension already
  // muted it or the user toggled YouTube's mute), the caller would "restore"
  // the audio to muted=true and the user ends the session with the video
  // silenced. The content script must snapshot the pre-intervention mute state
  // once and return that stable value across repeated mute calls.
  it('returns the stable pre-intervention muted snapshot across repeated mute calls', () => {
    const video = { muted: false };
    const contentScript = installContentScript(video);

    const first = contentScript.send({
      type: 'fbif:youtube-timeline:v2:set-original-audio-muted',
      muted: true,
      videoId: 'video-123',
    }) as any;
    expect(first.payload.previousMuted).toBe(false);
    expect(video.muted).toBe(true);

    // Simulate the user (or a second extension call) leaving the video muted,
    // then the extension issuing another mute(true) within the same session.
    const second = contentScript.send({
      type: 'fbif:youtube-timeline:v2:set-original-audio-muted',
      muted: true,
      videoId: 'video-123',
    }) as any;
    // The snapshot must still be the original false, NOT the now-live true.
    expect(second.payload.previousMuted).toBe(false);
  });

  it('still reports the original snapshot when restoring, not the live (already-muted) state', () => {
    const video = { muted: false };
    const contentScript = installContentScript(video);

    contentScript.send({
      type: 'fbif:youtube-timeline:v2:set-original-audio-muted',
      muted: true,
      videoId: 'video-123',
    });
    // Restore. The live video.muted is now true (we just muted it); a naive
    // implementation that re-reads video.muted would report previousMuted=true,
    // misleading the caller about the pre-session state.
    const restore = contentScript.send({
      type: 'fbif:youtube-timeline:v2:set-original-audio-muted',
      muted: false,
      videoId: 'video-123',
    }) as any;
    expect(restore.payload.previousMuted).toBe(false);
    expect(video.muted).toBe(false);
  });

  // Why this matters: when the user's original video was ALREADY muted before
  // the session, the restore call replays muted=true (the captured snapshot).
  // The module-level snapshot is reused across sessions on the same persistent
  // content-script instance. If restore does not clear the snapshot when the
  // restored value happens to be `true`, the stale `true` leaks into the next
  // session: even after the user un-mutes the video, the next mute(true) skips
  // re-capture, reuses the stale `true`, and the following restore wrongly
  // keeps the now-should-be-audible video silenced. Restore is a one-shot
  // consume — it must clear the snapshot regardless of the restored value.
  it('clears the snapshot after restoring an originally-muted video so the next session re-captures', () => {
    // Session 1: user entered the page with the video already muted.
    const video = { muted: true };
    const contentScript = installContentScript(video);

    // Start translation: mute(true). Captures the pre-intervention state (true).
    const startA = contentScript.send({
      type: 'fbif:youtube-timeline:v2:set-original-audio-muted',
      muted: true,
      videoId: 'video-123',
    }) as any;
    expect(startA.payload.previousMuted).toBe(true);

    // Session 1 ends: the caller replays the captured value (true) to restore.
    const restoreA = contentScript.send({
      type: 'fbif:youtube-timeline:v2:set-original-audio-muted',
      muted: true,
      videoId: 'video-123',
    }) as any;
    expect(restoreA.payload.previousMuted).toBe(true);

    // Between sessions the user UN-mutes the video themselves.
    video.muted = false;

    // Session 2 starts on the SAME content-script instance: mute(true) must
    // re-capture the now-live false, NOT reuse the leaked snapshot from
    // session 1. If the snapshot leaked, previousMuted would wrongly be true.
    const startB = contentScript.send({
      type: 'fbif:youtube-timeline:v2:set-original-audio-muted',
      muted: true,
      videoId: 'video-123',
    }) as any;
    expect(startB.payload.previousMuted).toBe(false);

    // Session 2 ends: restore replays the freshly captured false, leaving the
    // video audible — which is what the user expects.
    const restoreB = contentScript.send({
      type: 'fbif:youtube-timeline:v2:set-original-audio-muted',
      muted: false,
      videoId: 'video-123',
    }) as any;
    expect(restoreB.payload.previousMuted).toBe(false);
    expect(video.muted).toBe(false);
  });

  // Why this matters: parsing ytInitialPlayerResponse out of <script> text is a
  // single fragile point — YouTube has repeatedly changed how that global is
  // injected, and an A/B variant can leave it absent. The live player exposes
  // movie_player.getPlayerResponse() with the same data; preferring it when the
  // script scan finds nothing avoids a needless extra watch-HTML round trip and
  // survives injection-format changes that would otherwise kill caption fetch.
  it('reads the player response from the live movie_player API when the page script scan finds none', async () => {
    const video = { muted: false };
    const playerResponseFromApi = {
      videoDetails: { videoId: 'video-123', title: 'Live API title' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{
            baseUrl: 'https://www.youtube.com/api/timedtext?v=video-123&lang=en',
            languageCode: 'en',
            name: { simpleText: 'English' },
            kind: 'asr',
          }],
        },
      },
    };
    const moviePlayer = { getPlayerResponse: vi.fn(() => playerResponseFromApi) };
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/watch?')) {
        // If reached, the script scan fallback failed; return empty so the test
        // fails loudly on the old code path instead of silently succeeding.
        return { ok: true, text: async () => '<script></script>' };
      }
      return {
        ok: true,
        text: async () => JSON.stringify({
          events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Live caption' }] }],
        }),
      };
    });
    let listener: ((message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => void) | null = null;
    const context = vm.createContext({
      URL,
      fetch: fetchMock,
      AbortSignal,
      console,
      window: { location: { href: 'https://www.youtube.com/watch?v=video-123' } },
      document: {
        scripts: [],
        title: 'SPA Video',
        querySelector: vi.fn((selector: string) => {
          if (selector === 'video') return video;
          if (selector === '#movie_player') return moviePlayer;
          return null;
        }),
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
      payload: { videoId: 'video-123', title: 'Live API title', sourceLanguage: 'en' },
    });
    expect(response.payload.json3.events[0].segs[0].utf8).toBe('Live caption');
    expect(moviePlayer.getPlayerResponse).toHaveBeenCalled();
    // No watch-HTML round trip should be needed when the live API answers.
    const watchCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/watch?'));
    expect(watchCall).toBeUndefined();
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
