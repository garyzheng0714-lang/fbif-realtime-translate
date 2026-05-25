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

async function fetchFreshPlayerResponse(urlVideoId) {
  const watchUrl = new URL('https://www.youtube.com/watch');
  watchUrl.searchParams.set('v', urlVideoId);
  watchUrl.searchParams.set('hl', 'en');
  watchUrl.searchParams.set('persist_hl', '1');

  const response = await fetch(watchUrl.toString(), {
    credentials: 'include',
  });
  if (!response.ok) return null;

  const html = await response.text();
  const playerResponse = parsePlayerResponseFromScript(html);
  if (getPlayerResponseVideoId(playerResponse) !== urlVideoId) return null;
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

async function getCaptions() {
  const urlVideoId = getCurrentUrlVideoId();
  if (!urlVideoId) {
    return makeError('no_video', 'No YouTube video ID was found in the current page URL.');
  }

  const { playerResponse: pagePlayerResponse, foundStaleResponse } = findPlayerResponse(urlVideoId);
  const playerResponse = pagePlayerResponse || await fetchFreshPlayerResponse(urlVideoId);
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

  const selectedTrack = selectCaptionTrack(tracks);

  try {
    const json3 = await fetchJson3(selectedTrack);
    return {
      ok: true,
      payload: {
        videoId: urlVideoId,
        title: playerResponse?.videoDetails?.title || document.title || '',
        sourceLanguage: selectedTrack.languageCode,
        tracks,
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

function getVideoTime() {
  const video = document.querySelector('video');
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

function setOriginalAudioMuted(muted, expectedVideoId) {
  const currentVideoId = getCurrentUrlVideoId();
  if (expectedVideoId && currentVideoId !== expectedVideoId) {
    return makeError(
      'no_video',
      `Expected YouTube video ${expectedVideoId}, but current page video is ${currentVideoId || 'unavailable'}.`,
    );
  }

  const video = document.querySelector('video');
  if (!video) {
    return makeError('no_video', 'No YouTube video element was found on this page.');
  }

  const previousMuted = video.muted;
  video.muted = muted;

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
