/* global chrome */

(function () {
const CONTENT_SCRIPT_VERSION = 2;
if (window.__fbifYoutubeTimelineCaptionsVersion__ === CONTENT_SCRIPT_VERSION) return;
window.__fbifYoutubeTimelineCaptionsVersion__ = CONTENT_SCRIPT_VERSION;

const CAPTION_REQUEST_TYPE = 'fbif:youtube-timeline:v2:get-captions';
const VIDEO_TIME_REQUEST_TYPE = 'fbif:youtube-timeline:v2:get-video-time';
const ORIGINAL_AUDIO_MUTE_REQUEST_TYPE = 'fbif:youtube-timeline:v2:set-original-audio-muted';

function makeError(code, message) {
  return { ok: false, error: { code, message } };
}

function validateOriginalAudioMuteMessage(message) {
  if (typeof message?.muted !== 'boolean') {
    return makeError('caption_fetch_failed', 'YouTube original audio muted value must be a boolean.');
  }
  if (message.videoId !== undefined && typeof message.videoId !== 'string') {
    return makeError('caption_fetch_failed', 'YouTube original audio videoId must be a string when provided.');
  }
  return null;
}

// Bound every startup network hop so a single slow/hung response cannot block
// caption fetching indefinitely (which would leave the user "connected" with no
// first dubbed line). Returns undefined where AbortSignal.timeout is missing so
// older runtimes still issue the fetch un-aborted rather than throwing.
const NETWORK_FETCH_TIMEOUT_MS = 5000;

function buildFetchSignal() {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(NETWORK_FETCH_TIMEOUT_MS);
  }
  return undefined;
}

function readTrackName(track) {
  if (track?.name?.simpleText) return track.name.simpleText;
  if (Array.isArray(track?.name?.runs)) {
    return track.name.runs.map((run) => run?.text || '').join('');
  }
  return track?.languageCode || '';
}

function getCurrentUrlVideoId() {
  try {
    const url = new URL(window.location.href);
    if (url.pathname === '/watch') return url.searchParams.get('v') || '';
    const [, kind, id] = url.pathname.split('/');
    if ((kind === 'shorts' || kind === 'embed') && id) return id;
  } catch {
    /* ignore malformed locations */
  }
  return '';
}

function extractBalancedObject(source, openBraceIndex) {
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaping = false;

  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === '\\') {
        escaping = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openBraceIndex, index + 1);
    }
  }

  return null;
}

function extractJsonAfter(source, marker) {
  const markerIndex = source.search(marker);
  if (markerIndex === -1) return null;
  const afterMarker = source.slice(markerIndex);
  const openBraceOffset = afterMarker.indexOf('{');
  if (openBraceOffset === -1) return null;
  return extractBalancedObject(source, markerIndex + openBraceOffset);
}

function parsePlayerResponseFromScript(scriptText) {
  const patterns = [
    /(?:^|[;\s])(?:var\s+)?ytInitialPlayerResponse\s*=/,
    /(?:window\s*\[\s*)["']ytInitialPlayerResponse["']\s*\]\s*=/,
    /(?:window\s*\.\s*)ytInitialPlayerResponse\s*=/,
  ];

  for (const pattern of patterns) {
    const jsonText = extractJsonAfter(scriptText, pattern);
    if (!jsonText) continue;
    try {
      return JSON.parse(jsonText);
    } catch {
      continue;
    }
  }

  return null;
}

function getPlayerResponseVideoId(playerResponse) {
  return (
    playerResponse?.videoDetails?.videoId ||
    playerResponse?.microformat?.playerMicroformatRenderer?.externalVideoId ||
    ''
  );
}

function extractInnertubeApiKey(html) {
  return (
    html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)?.[1] ||
    html.match(/INNERTUBE_API_KEY\\"\s*:\s*\\"([^\\"]+)\\"/)?.[1] ||
    ''
  );
}

// Conservative fallback only used when the page exposes no client version.
// A hard-coded version eventually goes stale and the server rejects it, so we
// prefer the live value from the page's ytcfg / INNERTUBE_CONTEXT.
const FALLBACK_INNERTUBE_CLIENT_VERSION = '20.10.38';

function extractInnertubeClientVersion(html) {
  return (
    html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION"\s*:\s*"([^"]+)"/)?.[1] ||
    html.match(/"clientVersion"\s*:\s*"([^"]+)"/)?.[1] ||
    html.match(/clientVersion\\"\s*:\s*\\"([^\\"]+)\\"/)?.[1] ||
    FALLBACK_INNERTUBE_CLIENT_VERSION
  );
}

// The live player exposes the same data the page-injected global carries, so
// preferring it when the script scan finds nothing avoids an extra watch-HTML
// round trip and survives YouTube changing how ytInitialPlayerResponse is
// injected (the script-text parse is otherwise a single fragile point).
function readPlayerResponseFromApi(urlVideoId) {
  const moviePlayer = document.querySelector('#movie_player');
  const getPlayerResponse = moviePlayer?.getPlayerResponse;
  if (typeof getPlayerResponse !== 'function') return null;

  let playerResponse = null;
  try {
    playerResponse = getPlayerResponse.call(moviePlayer);
  } catch {
    return null;
  }
  if (!playerResponse) return null;
  if (getPlayerResponseVideoId(playerResponse) !== urlVideoId) return null;
  return playerResponse;
}

function findPlayerResponse(urlVideoId) {
  const scripts = Array.from(document.scripts).reverse();
  let foundStaleResponse = false;

  for (const script of scripts) {
    const text = script.textContent || '';
    if (!text.includes('ytInitialPlayerResponse')) continue;
    const response = parsePlayerResponseFromScript(text);
    if (!response) continue;

    if (getPlayerResponseVideoId(response) === urlVideoId) {
      return { playerResponse: response, foundStaleResponse };
    }

    foundStaleResponse = true;
  }

  return { playerResponse: null, foundStaleResponse };
}

async function fetchFreshWatchHtml(urlVideoId) {
  const watchUrl = new URL('https://www.youtube.com/watch');
  watchUrl.searchParams.set('v', urlVideoId);
  watchUrl.searchParams.set('hl', 'en');
  watchUrl.searchParams.set('persist_hl', '1');

  const response = await fetch(watchUrl.toString(), {
    credentials: 'include',
    signal: buildFetchSignal(),
  });
  if (!response.ok) return '';

  return response.text();
}

function parseFreshPlayerResponse(html, urlVideoId) {
  const playerResponse = parsePlayerResponseFromScript(html);
  if (getPlayerResponseVideoId(playerResponse) !== urlVideoId) return null;
  return playerResponse;
}

async function fetchAndroidPlayerResponse(urlVideoId, html) {
  const apiKey = extractInnertubeApiKey(html);
  if (!apiKey) return null;

  const clientVersion = extractInnertubeClientVersion(html);

  const response = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${apiKey}`, {
    method: 'POST',
    credentials: 'include',
    signal: buildFetchSignal(),
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: 'ANDROID',
          clientVersion,
        },
      },
      videoId: urlVideoId,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  });
  if (!response.ok) return null;

  const playerResponse = await response.json();
  if (playerResponse?.playabilityStatus?.status && playerResponse.playabilityStatus.status !== 'OK') {
    return null;
  }
  return playerResponse;
}

function readCaptionTracks(playerResponse) {
  const captionTracks =
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(captionTracks)) return [];

  return captionTracks
    .filter((track) => track?.baseUrl && track?.languageCode)
    .map((track) => ({
      baseUrl: track.baseUrl,
      languageCode: track.languageCode,
      name: readTrackName(track),
      kind: track.kind,
      isTranslatable: Boolean(track.isTranslatable),
    }));
}

function selectCaptionTrack(tracks) {
  return (
    tracks.find((track) => track.languageCode === 'en') ||
    tracks.find((track) => track.languageCode?.startsWith('en')) ||
    tracks.find((track) => track.kind === 'asr') ||
    tracks[0]
  );
}

function withJson3Format(baseUrl) {
  const absoluteUrl = new URL(baseUrl, window.location.href).toString();
  if (/[?&]fmt=/.test(absoluteUrl)) {
    return absoluteUrl.replace(/([?&]fmt=)[^&]*/, '$1json3');
  }
  return `${absoluteUrl}${absoluteUrl.includes('?') ? '&' : '?'}fmt=json3`;
}

async function fetchJson3(track) {
  const response = await fetch(withJson3Format(track.baseUrl), {
    credentials: 'include',
    signal: buildFetchSignal(),
  });

  if (!response.ok) {
    throw new Error(`Timedtext request failed with HTTP ${response.status}`);
  }

  const text = await response.text();
  if (!text.trim()) {
    throw new Error('Timedtext request returned an empty response.');
  }

  return JSON.parse(text);
}

async function fetchSelectedTrackJson3(tracks) {
  const selectedTrack = selectCaptionTrack(tracks);
  return {
    selectedTrack,
    json3: await fetchJson3(selectedTrack),
  };
}

async function getCaptions() {
  const urlVideoId = getCurrentUrlVideoId();
  if (!urlVideoId) {
    return makeError('no_video', 'No YouTube video ID was found in the current page URL.');
  }

  const { playerResponse: pagePlayerResponse, foundStaleResponse } = findPlayerResponse(urlVideoId);
  let freshHtml = '';
  let playerResponse = pagePlayerResponse || readPlayerResponseFromApi(urlVideoId);
  if (!playerResponse) {
    freshHtml = await fetchFreshWatchHtml(urlVideoId);
    playerResponse = freshHtml ? parseFreshPlayerResponse(freshHtml, urlVideoId) : null;
  }
  if (!playerResponse) {
    if (foundStaleResponse) {
      return makeError('no_video', '当前 YouTube 页面状态尚未同步，请稍后重试。');
    }
    return makeError('no_video', 'No YouTube video player response was found on this page.');
  }

  const tracks = readCaptionTracks(playerResponse);
  if (tracks.length === 0) {
    return makeError('no_caption_tracks', 'No caption tracks were found for this YouTube video.');
  }

  try {
    let selectedTrack = selectCaptionTrack(tracks);
    let json3 = null;
    let resolvedTracks = tracks;
    let webCaptionError = null;

    try {
      json3 = await fetchJson3(selectedTrack);
    } catch (error) {
      webCaptionError = error;
    }

    if (!json3?.events && !freshHtml) {
      freshHtml = await fetchFreshWatchHtml(urlVideoId);
    }

    if (!json3?.events) {
      const androidPlayerResponse = freshHtml
        ? await fetchAndroidPlayerResponse(urlVideoId, freshHtml)
        : null;
      const androidTracks = readCaptionTracks(androidPlayerResponse);
      if (androidTracks.length > 0) {
        const androidResult = await fetchSelectedTrackJson3(androidTracks);
        selectedTrack = androidResult.selectedTrack;
        json3 = androidResult.json3;
        resolvedTracks = androidTracks;
      }
    }

    if (!json3?.events && webCaptionError) {
      throw webCaptionError;
    }

    return {
      ok: true,
      payload: {
        videoId: urlVideoId,
        title: playerResponse?.videoDetails?.title || document.title || '',
        sourceLanguage: selectedTrack.languageCode,
        tracks: resolvedTracks,
        json3,
      },
    };
  } catch (error) {
    return makeError(
      'caption_fetch_failed',
      error instanceof Error ? error.message : 'Failed to fetch YouTube timedtext captions.',
    );
  }
}

function getMainVideo() {
  // Prefer the YouTube main player. A watch page often hosts several <video>
  // elements (hover-preview thumbnails, ads, picture-in-picture); a bare
  // document.querySelector('video') returns DOM-order-first, which is usually
  // NOT the main player. The 350ms tick reads currentTime to drive scheduling
  // and we must mute the main player's original audio, so both callers need
  // the same, correct element.
  const scoped =
    document.querySelector('#movie_player video') ||
    document.querySelector('.html5-main-video');
  if (scoped) return scoped;

  const all =
    typeof document.querySelectorAll === 'function'
      ? Array.from(document.querySelectorAll('video'))
      : [];
  if (all.length === 0) return document.querySelector('video');

  // Fall back to an actually-playing, decoded video; otherwise the largest one.
  const playing = all.filter((video) => !video.paused && video.readyState > 2);
  const candidates = playing.length > 0 ? playing : all;
  return candidates.reduce((largest, video) => {
    const rect = typeof video.getBoundingClientRect === 'function' ? video.getBoundingClientRect() : null;
    const area = rect ? rect.width * rect.height : 0;
    const largestRect = typeof largest.getBoundingClientRect === 'function' ? largest.getBoundingClientRect() : null;
    const largestArea = largestRect ? largestRect.width * largestRect.height : 0;
    return area > largestArea ? video : largest;
  }, candidates[0]);
}

function getVideoTime() {
  const video = getMainVideo();
  if (!video) {
    return makeError('no_video', 'No YouTube video element was found on this page.');
  }

  return {
    ok: true,
    payload: {
      currentTimeMs: Math.max(0, Math.round(video.currentTime * 1000)),
      durationMs: Number.isFinite(video.duration) ? Math.max(0, Math.round(video.duration * 1000)) : null,
      paused: video.paused,
      videoId: getCurrentUrlVideoId(),
    },
  };
}

// Snapshot of the user's original mute state captured the first time the
// extension mutes the original audio in a session. Repeated mute(true) calls
// (or the user toggling YouTube's own mute) must NOT overwrite it, so restore
// reports the true pre-intervention value instead of the now-live state.
let capturedOriginalMuted = null;

function setOriginalAudioMuted(muted, expectedVideoId) {
  const currentVideoId = getCurrentUrlVideoId();
  if (expectedVideoId && currentVideoId !== expectedVideoId) {
    return makeError(
      'no_video',
      `Expected YouTube video ${expectedVideoId}, but current page video is ${currentVideoId || 'unavailable'}.`,
    );
  }

  const video = getMainVideo();
  if (!video) {
    return makeError('no_video', 'No YouTube video element was found on this page.');
  }

  // A snapshot already present at call entry means a session is in flight, so
  // this call cannot be the session's first mute(true) capture. The caller
  // drives restore by replaying the captured value, so a call that arrives
  // with an existing snapshot AND sets the video back to exactly that snapshot
  // value is the restore (a one-shot consume), regardless of whether that
  // value is muted or unmuted.
  const hadSnapshotBeforeCall = capturedOriginalMuted !== null;

  if (muted) {
    // Capture the pre-intervention state once, on the first mute of a session.
    if (capturedOriginalMuted === null) {
      capturedOriginalMuted = video.muted;
    }
  }

  const previousMuted = capturedOriginalMuted === null ? video.muted : capturedOriginalMuted;
  video.muted = muted;

  if (hadSnapshotBeforeCall && muted === capturedOriginalMuted) {
    // Restore complete; clear the snapshot so the next session re-captures.
    // This fires for an originally-unmuted restore (muted=false) AND an
    // originally-muted restore (muted=true) — otherwise a stale `true` would
    // leak into the next session and silence a video the user later un-muted.
    capturedOriginalMuted = null;
  }

  return {
    ok: true,
    payload: {
      previousMuted,
      currentMuted: video.muted,
      videoId: currentVideoId,
    },
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === VIDEO_TIME_REQUEST_TYPE) {
    sendResponse(getVideoTime());
    return false;
  }

  if (message?.type === ORIGINAL_AUDIO_MUTE_REQUEST_TYPE) {
    const validationError = validateOriginalAudioMuteMessage(message);
    if (validationError) {
      sendResponse(validationError);
      return false;
    }
    sendResponse(setOriginalAudioMuted(message.muted, message.videoId));
    return false;
  }

  if (message?.type !== CAPTION_REQUEST_TYPE) return undefined;

  getCaptions()
    .then(sendResponse)
    .catch((error) => {
      sendResponse(makeError(
        'caption_fetch_failed',
        error instanceof Error ? error.message : 'Failed to read YouTube captions.',
      ));
    });

  return true;
});
})();
