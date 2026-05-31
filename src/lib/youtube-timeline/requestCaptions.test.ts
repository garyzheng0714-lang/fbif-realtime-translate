import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  requestCaptions,
  requestCaptionsFromTab,
  setYouTubeOriginalAudioMutedInTab,
  setYouTubeOriginalAudioMutedFromActiveTab,
  requestYouTubeVideoTimeFromActiveTab,
  requestYouTubeVideoTimeFromTab,
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
          id: 'yt-1000-Hello timeline',
          startMs: 1000,
          endMs: 2500,
          sourceText: 'Hello timeline',
        },
      ],
    });
  });

  // WHY: the timeline tick needs the exact tab the captions were fetched from so
  // every later video-time poll targets that one tab directly. If requestCaptions
  // did not surface the tab id, MainPanel would have to re-query the active tab
  // each frame (the redundant tabs.query this optimization removes) and could
  // even latch onto a different tab the user switched to mid-session.
  it('returns the resolved tab id alongside the caption payload', async () => {
    installChromeMock({
      ok: true,
      payload: {
        videoId: 'video-123',
        title: 'Real video title',
        sourceLanguage: 'en',
        tracks: [],
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

    expect(result.tabId).toBe(activeYouTubeTab.id);
  });

  // WHY (finding 1): the live-caption refresh loop must re-fetch from the EXACT
  // tab the session pinned at start (timelineVideoTabIdRef), the same tab the tick
  // polls video time from. The old refreshCaptions called the active-tab
  // requestCaptions(), so if the user opened the same video in a second tab and
  // switched to it, the 20s refresh merged captions from that second tab (possibly
  // a different caption track / progress) while the tick still read time from the
  // first tab — caption source and playhead source split. requestCaptionsFromTab
  // sends straight to the pinned tab id and never queries the active tab.
  it('fetches captions from a specific tab id without querying the active tab', async () => {
    const { query, sendMessage } = installChromeMock({
      ok: true,
      payload: {
        videoId: 'video-123',
        title: 'Real video title',
        sourceLanguage: 'en',
        tracks: [],
        json3: {
          events: [
            {
              tStartMs: 1000,
              dDurationMs: 1500,
              segs: [{ utf8: 'Pinned tab caption' }],
            },
          ],
        },
      },
    });

    const result = await requestCaptionsFromTab(99);

    expect(query).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      99,
      { type: YOUTUBE_TIMELINE_CAPTION_REQUEST },
      expect.any(Function),
    );
    expect(result).toMatchObject({
      videoId: 'video-123',
      cues: [{ startMs: 1000, endMs: 2500, sourceText: 'Pinned tab caption' }],
    });
  });

  // WHY: the refresh loop already swallows caption fetch failures, but the tab-id
  // path must still surface a real timeline error code (not a generic throw) so a
  // future caller can distinguish a transient failure from a contract break.
  it('preserves content script error codes from the tab-id caption path', async () => {
    installChromeMock({
      ok: false,
      error: {
        code: 'no_caption_tracks',
        message: 'No caption tracks were found for this YouTube video.',
      },
    });

    await expect(requestCaptionsFromTab(99)).rejects.toMatchObject({
      code: 'no_caption_tracks',
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

  // WHY: the content script contract is strictly { ok: true, payload } or { ok: false,
  // error }. A malformed response that lacks an explicit ok (e.g. a stale/partial reply)
  // used to slip past the success/ok "or" check and then fall into the dead json3
  // fallback branch, which parsed the whole envelope as captions and surfaced a
  // misleading caption_parse_failed. Treat anything that is not ok:true as a fetch error
  // so the tick retries against the real failure.
  it('treats a response without an explicit ok flag as a fetch failure', async () => {
    installChromeMock({
      payload: {
        videoId: 'video-123',
        json3: { events: [{ tStartMs: 0, segs: [{ utf8: 'Ghost' }] }] },
      },
    });

    await expect(requestCaptions()).rejects.toMatchObject({
      code: 'caption_fetch_failed',
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

  // WHY: the tab is fixed for the whole session once captions are fetched, so the
  // tick must read its video time straight from that tab id. Re-running
  // tabs.query({active,currentWindow}) + URL validation every 350ms is wasted
  // cross-process work and risks reading a different tab if the user switches
  // away. This variant sends the video-time request to the given tab id and never
  // queries the active tab.
  it('requests video time from a specific tab id without querying the active tab', async () => {
    const { query, sendMessage } = installChromeMock({
      ok: true,
      payload: {
        currentTimeMs: 8000,
        durationMs: 60000,
        paused: true,
        videoId: 'video-123',
      },
    });

    const result = await requestYouTubeVideoTimeFromTab(42);

    expect(query).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      42,
      { type: YOUTUBE_TIMELINE_VIDEO_TIME_REQUEST },
      expect.any(Function),
    );
    expect(result).toEqual({
      currentTimeMs: 8000,
      durationMs: 60000,
      paused: true,
      videoId: 'video-123',
    });
  });

  // WHY: the same NaN-poisoning guard that protects the active-tab path must
  // protect the tab-id path, otherwise an unloaded video reached by tab id would
  // feed NaN into the tick clock and silently stall the session.
  it('rejects a non-finite current time from the tab-id path', async () => {
    installChromeMock({
      ok: true,
      payload: {
        currentTimeMs: Number.NaN,
        durationMs: 60000,
        paused: false,
        videoId: 'video-123',
      },
    });

    await expect(requestYouTubeVideoTimeFromTab(42)).rejects.toMatchObject({
      code: 'caption_fetch_failed',
    });
  });

  it('preserves content script error codes from the tab-id video time path', async () => {
    installChromeMock({
      ok: false,
      error: {
        code: 'no_video',
        message: 'No video element was found.',
      },
    });

    await expect(requestYouTubeVideoTimeFromTab(42)).rejects.toMatchObject({
      code: 'no_video',
      message: 'No video element was found.',
    });
  });

  // WHY: a video element that has not loaded yet reports NaN for currentTime, and
  // typeof NaN === 'number' so the old check let it through. A NaN currentTimeMs then
  // poisons the whole tick: seek detection (Math.abs(now - last) > threshold) is always
  // false and getCueWindow's startMs <= NaN + prebuffer is always false, so the user
  // sees "connected but no subtitles and no audio". Reject non-finite/negative times so
  // tick retries instead of advancing on a poisoned clock.
  it('rejects a non-finite current time so the tick clock is never poisoned', async () => {
    installChromeMock({
      ok: true,
      payload: {
        currentTimeMs: Number.NaN,
        durationMs: 60000,
        paused: false,
        videoId: 'video-123',
      },
    });

    await expect(requestYouTubeVideoTimeFromActiveTab()).rejects.toMatchObject({
      code: 'caption_fetch_failed',
    });
  });

  it('rejects a negative current time instead of advancing the schedule backwards', async () => {
    installChromeMock({
      ok: true,
      payload: {
        currentTimeMs: -1,
        durationMs: 60000,
        paused: false,
        videoId: 'video-123',
      },
    });

    await expect(requestYouTubeVideoTimeFromActiveTab()).rejects.toMatchObject({
      code: 'caption_fetch_failed',
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
