import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const scriptPath = path.resolve(process.cwd(), 'extension/content/subtitle-overlay-content.js');

function installContentScript() {
  let messageListener: ((message: unknown) => void) | null = null;
  let iframeStyle = '';

  const body = { appendChild: vi.fn() };
  const shadow = { appendChild: vi.fn() };

  const context = vm.createContext({
    console,
    window: {
      innerWidth: 1440,
      innerHeight: 900,
      addEventListener: vi.fn(),
    },
    document: {
      body,
      createElement: vi.fn((tagName: string) => {
        const element = {
          id: '',
          src: '',
          allow: '',
          style: {
            get cssText() {
              return tagName === 'iframe' ? iframeStyle : '';
            },
            set cssText(value: string) {
              if (tagName === 'iframe') iframeStyle = value;
            },
          },
          attachShadow: vi.fn(() => shadow),
          remove: vi.fn(),
        };
        return element;
      }),
    },
    chrome: {
      runtime: {
        getURL: vi.fn((asset: string) => `chrome-extension://test/${asset}`),
        onMessage: {
          addListener: vi.fn((callback) => {
            messageListener = callback;
          }),
        },
      },
    },
  });

  vm.runInContext(fs.readFileSync(scriptPath, 'utf8'), context);

  return {
    enterSubtitleMode() {
      if (!messageListener) throw new Error('Content script listener was not installed');
      messageListener({ type: 'subtitle:enter' });
      return iframeStyle;
    },
  };
}

describe('subtitle overlay content script', () => {
  it('defaults the injected subtitle iframe to the bottom-right corner so new lines read as a log', () => {
    const contentScript = installContentScript();

    const iframeStyle = contentScript.enterSubtitleMode();

    expect(iframeStyle).toContain('position: fixed');
    expect(iframeStyle).toContain('right: 24px');
    expect(iframeStyle).toContain('bottom: 80px');
    expect(iframeStyle).toContain('left: auto');
    expect(iframeStyle).toContain('transform: none');
    expect(iframeStyle).not.toContain('left: 50%');
    expect(iframeStyle).not.toContain('translateX(-50%)');
  });
});
