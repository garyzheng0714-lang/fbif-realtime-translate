import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const scriptPath = path.resolve(process.cwd(), 'extension/content/subtitle-overlay-content.js');

function installContentScript() {
  let messageListener: ((message: unknown) => void) | null = null;
  let iframeStyle = '';
  const documentEventListeners: Record<string, Array<(event?: unknown) => void>> = {};
  const windowEventListeners: Record<string, Array<(event?: unknown) => void>> = {};

  // Track which element currently parents the host so tests can assert the
  // host follows the fullscreen element instead of being stranded under body.
  let hostParent: unknown = null;
  let hostElement: any = null;

  // Model parentNode / isConnected so the re-parent guard can be exercised
  // realistically. appendChild attaches the host (connected); a SPA that
  // rebuilds the player subtree can detach it (orphaned) via detachHost().
  const linkHostTo = (parent: any) => {
    hostParent = parent;
    if (hostElement) {
      hostElement.parentNode = parent;
      // The host is connected only when its parent is itself attached to the
      // document tree. A detached/replaced player container is not connected.
      hostElement.isConnected = parent ? !!parent.isConnected : false;
    }
  };

  const body: any = {
    isConnected: true,
    appendChild: vi.fn((child: unknown) => {
      if (child === hostElement) linkHostTo(body);
    }),
  };
  const fullscreenElement: any = {
    isConnected: true,
    appendChild: vi.fn((child: unknown) => {
      if (child === hostElement) linkHostTo(fullscreenElement);
    }),
  };
  const shadow = { appendChild: vi.fn() };

  const documentMock: any = {
    body,
    fullscreenElement: null,
    addEventListener: vi.fn((type: string, cb: (event?: unknown) => void) => {
      (documentEventListeners[type] ||= []).push(cb);
    }),
    removeEventListener: vi.fn((type: string, cb: (event?: unknown) => void) => {
      const list = documentEventListeners[type];
      if (list) documentEventListeners[type] = list.filter((entry) => entry !== cb);
    }),
    createElement: vi.fn((tagName: string) => {
      const element: any = {
        id: '',
        src: '',
        allow: '',
        parentNode: null,
        isConnected: false,
        style: {
          get cssText() {
            return tagName === 'iframe' ? iframeStyle : '';
          },
          set cssText(value: string) {
            if (tagName === 'iframe') iframeStyle = value;
          },
        },
        attachShadow: vi.fn(() => shadow),
        remove: vi.fn(() => {
          if (element === hostElement) {
            hostParent = null;
            element.parentNode = null;
            element.isConnected = false;
          }
        }),
      };
      // The first non-iframe div created is the host.
      if (tagName === 'div' && !hostElement) hostElement = element;
      return element;
    }),
  };

  const context = vm.createContext({
    console,
    window: {
      innerWidth: 1440,
      innerHeight: 900,
      addEventListener: vi.fn((type: string, cb: (event?: unknown) => void) => {
        (windowEventListeners[type] ||= []).push(cb);
      }),
      removeEventListener: vi.fn((type: string, cb: (event?: unknown) => void) => {
        const list = windowEventListeners[type];
        if (list) windowEventListeners[type] = list.filter((entry) => entry !== cb);
      }),
    },
    document: documentMock,
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

  const fire = (registry: Record<string, Array<(event?: unknown) => void>>, type: string) => {
    for (const cb of registry[type] || []) cb();
  };

  return {
    enterSubtitleMode() {
      if (!messageListener) throw new Error('Content script listener was not installed');
      messageListener({ type: 'subtitle:enter' });
      return iframeStyle;
    },
    exitSubtitleMode() {
      if (!messageListener) throw new Error('Content script listener was not installed');
      messageListener({ type: 'subtitle:exit' });
    },
    enterFullscreen() {
      documentMock.fullscreenElement = fullscreenElement;
      fire(documentEventListeners, 'fullscreenchange');
    },
    exitFullscreen() {
      documentMock.fullscreenElement = null;
      fire(documentEventListeners, 'fullscreenchange');
    },
    // Simulate YouTube's SPA rebuilding the player subtree while still in
    // fullscreen: the player container the host was re-parented into is
    // detached from the document, so the host is now an orphan (still pointing
    // at that container via parentNode, but no longer connected to the page).
    detachFullscreenPlayerSubtree() {
      fullscreenElement.isConnected = false;
      if (hostElement && hostElement.parentNode === fullscreenElement) {
        hostElement.isConnected = false;
      }
    },
    // The live player container reappears in the document (still the fullscreen
    // element), but the host has not been re-appended yet, so it stays orphaned.
    reattachFullscreenPlayerSubtree() {
      fullscreenElement.isConnected = true;
    },
    // Fire fullscreenchange without changing which element is fullscreen (e.g.
    // a redundant/secondary event while still in fullscreen).
    fireFullscreenChangeStillFullscreen() {
      fire(documentEventListeners, 'fullscreenchange');
    },
    isHostConnected() {
      return !!(hostElement && hostElement.isConnected);
    },
    fullscreenAppendCount() {
      return fullscreenElement.appendChild.mock.calls.length;
    },
    getHostParent() {
      return hostParent;
    },
    isFullscreenParent(parent: unknown) {
      return parent === fullscreenElement;
    },
    isBodyParent(parent: unknown) {
      return parent === body;
    },
    documentListenerCount(type: string) {
      return (documentEventListeners[type] || []).length;
    },
    windowListenerCount(type: string) {
      return (windowEventListeners[type] || []).length;
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

  // Why this matters: watching a video fullscreen is the most common posture.
  // The browser only renders the fullscreen element and its descendants in the
  // top layer; a host parented under document.body — a sibling of the fullscreen
  // element — is fully occluded regardless of z-index. The subtitle overlay must
  // re-parent into the fullscreen element so translations stay visible.
  it('re-parents the subtitle host into the fullscreen element when YouTube enters native fullscreen', () => {
    const contentScript = installContentScript();
    contentScript.enterSubtitleMode();

    // Initially the host lives under document.body.
    expect(contentScript.isBodyParent(contentScript.getHostParent())).toBe(true);

    contentScript.enterFullscreen();

    expect(contentScript.isFullscreenParent(contentScript.getHostParent())).toBe(true);
  });

  // Why this matters: the re-parent guard `host.parentNode === target` skips
  // re-attaching when the host already sits under the target. But YouTube's SPA
  // can rebuild the #movie_player subtree mid-fullscreen, detaching the very
  // container the host was moved into. The host's parentNode still points at
  // that now-orphaned container (so the guard's `===` is satisfied) yet the host
  // is no longer connected to the document — the subtitle overlay is invisible.
  // The guard must also verify the host is still connected, re-attaching it to
  // the live target when it has been orphaned, instead of early-returning and
  // leaving it stranded.
  it('re-attaches an orphaned host when the player subtree was rebuilt mid-fullscreen', () => {
    const contentScript = installContentScript();
    contentScript.enterSubtitleMode();
    contentScript.enterFullscreen();
    expect(contentScript.isFullscreenParent(contentScript.getHostParent())).toBe(true);
    expect(contentScript.fullscreenAppendCount()).toBe(1);

    // YouTube rebuilds the player subtree: the host's parent is detached, so the
    // host is orphaned (parentNode still === fullscreenElement, but disconnected).
    contentScript.detachFullscreenPlayerSubtree();
    expect(contentScript.isHostConnected()).toBe(false);

    // The live player container reappears (re-attached to the document) and a
    // fullscreenchange fires while still fullscreen.
    contentScript.reattachFullscreenPlayerSubtree();
    contentScript.fireFullscreenChangeStillFullscreen();

    // The guard must NOT early-return on the stale parentNode === target match;
    // it must re-append the orphaned host so it becomes visible again.
    expect(contentScript.fullscreenAppendCount()).toBe(2);
    expect(contentScript.isHostConnected()).toBe(true);
  });

  it('moves the subtitle host back under document.body when fullscreen exits', () => {
    const contentScript = installContentScript();
    contentScript.enterSubtitleMode();
    contentScript.enterFullscreen();
    expect(contentScript.isFullscreenParent(contentScript.getHostParent())).toBe(true);

    contentScript.exitFullscreen();

    expect(contentScript.isBodyParent(contentScript.getHostParent())).toBe(true);
  });

  // Why this matters: window 'resize' / 'message' / document 'fullscreenchange'
  // listeners that are registered on mount but never removed on unmount stay
  // bound to the page for the content script's whole lifetime. Each
  // enter/exit cycle then leaks another set, and the stale callbacks keep
  // firing against a torn-down overlay. Mount and unmount must be symmetric.
  it('removes the viewport and fullscreen listeners it added when the overlay unmounts', () => {
    const contentScript = installContentScript();

    contentScript.enterSubtitleMode();
    expect(contentScript.windowListenerCount('resize')).toBe(1);
    expect(contentScript.windowListenerCount('message')).toBe(1);
    expect(contentScript.documentListenerCount('fullscreenchange')).toBe(1);

    contentScript.exitSubtitleMode();
    expect(contentScript.windowListenerCount('resize')).toBe(0);
    expect(contentScript.windowListenerCount('message')).toBe(0);
    expect(contentScript.documentListenerCount('fullscreenchange')).toBe(0);
  });

  it('does not accumulate listeners across repeated enter/exit cycles', () => {
    const contentScript = installContentScript();

    contentScript.enterSubtitleMode();
    contentScript.exitSubtitleMode();
    contentScript.enterSubtitleMode();
    contentScript.exitSubtitleMode();
    contentScript.enterSubtitleMode();

    expect(contentScript.windowListenerCount('resize')).toBe(1);
    expect(contentScript.windowListenerCount('message')).toBe(1);
    expect(contentScript.documentListenerCount('fullscreenchange')).toBe(1);
  });
});
