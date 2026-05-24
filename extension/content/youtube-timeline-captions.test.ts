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
});
