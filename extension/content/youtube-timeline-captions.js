/* global chrome */

const REQUEST_TYPE = 'fbif:youtube-timeline:get-captions';

function makeError(code, message) {
  return { ok: false, error: { code, message } };
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

  const { playerResponse, foundStaleResponse } = findPlayerResponse(urlVideoId);
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== REQUEST_TYPE) return undefined;

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
