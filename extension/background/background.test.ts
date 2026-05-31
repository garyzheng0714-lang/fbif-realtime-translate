import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const scriptPath = path.resolve(process.cwd(), 'extension/background/background.js');

type MessageListener = (
  message: any,
  sender: any,
  sendResponse: (response: any) => void,
) => boolean | void;

type TabsUpdatedListener = (tabId: number, changeInfo: any, tab: any) => unknown;
type TabsRemovedListener = (tabId: number) => unknown;
type TabsActivatedListener = (activeInfo: { tabId: number }) => unknown;

interface InstalledBackground {
  /** Send a runtime message through the registered onMessage listener and await the response. */
  sendMessage(message: any, sender?: any): Promise<any>;
  /** Fire chrome.tabs.onUpdated for a navigation/complete event. */
  fireTabUpdated(tabId: number, changeInfo: any, tab: any): Promise<void>;
  /** Fire chrome.tabs.onActivated for a tab switch. */
  fireTabActivated(tabId: number): Promise<void>;
  /** Fire chrome.tabs.onRemoved. */
  fireTabRemoved(tabId: number): void;
  /** Spy on chrome.tabCapture.getMediaStreamId. */
  getMediaStreamId: ReturnType<typeof vi.fn>;
  /** Spy on chrome.sidePanel.setOptions. */
  setOptions: ReturnType<typeof vi.fn>;
  /** Captured console.info calls (used to observe activeTabCaptures bookkeeping). */
  infoLogs: any[][];
}

/**
 * Load background.js inside an isolated VM context with a mocked chrome API.
 * background.js only registers listeners and declares top-level functions at
 * load time, so the script is safe to evaluate with stub listeners that we
 * capture for later invocation.
 */
function installBackground(
  options: {
    /** getMediaStreamId returns a fresh id on every call so streamId reuse is observable. */
    streamIds?: string[];
    /** Tabs that chrome.tabs.get should resolve for; others reject as "Tab not found". */
    knownTabs?: number[];
    /** Per-tab URL returned by chrome.tabs.get (defaults to a YouTube watch URL). */
    tabUrls?: Record<number, string>;
  } = {},
): InstalledBackground {
  const streamIds = options.streamIds ?? ['stream-1', 'stream-2', 'stream-3', 'stream-4'];
  const knownTabs = new Set(options.knownTabs ?? [42, 5, 7]);
  const tabUrls = options.tabUrls ?? {};

  let messageListener: MessageListener | null = null;
  const updatedListeners: TabsUpdatedListener[] = [];
  const activatedListeners: TabsActivatedListener[] = [];
  const removedListeners: TabsRemovedListener[] = [];

  let streamIdCursor = 0;
  const getMediaStreamId = vi.fn((_opts: any, callback: (id?: string) => void) => {
    const id = streamIds[Math.min(streamIdCursor, streamIds.length - 1)];
    streamIdCursor += 1;
    callback(id);
  });

  const setOptions = vi.fn(async () => {});

  const infoLogs: any[][] = [];
  const consoleProxy = {
    ...console,
    info: (...args: any[]) => {
      infoLogs.push(args);
    },
    debug: () => {},
  };

  const chrome = {
    runtime: {
      id: 'test-extension',
      lastError: null as { message: string } | null,
      onInstalled: { addListener: vi.fn() },
      onMessage: {
        addListener: vi.fn((cb: MessageListener) => {
          messageListener = cb;
        }),
      },
      setUninstallURL: vi.fn(),
    },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
      },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => {
        if (!knownTabs.has(tabId)) throw new Error('No tab with id');
        return { id: tabId, url: tabUrls[tabId] ?? 'https://www.youtube.com/watch?v=abc' };
      }),
      onUpdated: { addListener: vi.fn((cb: TabsUpdatedListener) => updatedListeners.push(cb)) },
      onActivated: { addListener: vi.fn((cb: TabsActivatedListener) => activatedListeners.push(cb)) },
      onRemoved: { addListener: vi.fn((cb: TabsRemovedListener) => removedListeners.push(cb)) },
    },
    action: {
      onClicked: { addListener: vi.fn() },
      setPopup: vi.fn(async () => {}),
    },
    sidePanel: {
      open: vi.fn(async () => {}),
      setOptions,
      setPanelBehavior: vi.fn(async () => {}),
    },
    tabCapture: {
      getMediaStreamId,
    },
    declarativeNetRequest: {
      getDynamicRules: vi.fn(async () => []),
      updateDynamicRules: vi.fn(async () => {}),
    },
  };

  const context = vm.createContext({
    URL,
    URLSearchParams,
    console: consoleProxy,
    chrome,
    setTimeout,
    clearTimeout,
    Promise,
  });

  vm.runInContext(fs.readFileSync(scriptPath, 'utf8'), context);

  return {
    sendMessage(message: any, sender: any = {}) {
      if (!messageListener) throw new Error('Background onMessage listener was not installed');
      return new Promise((resolve) => {
        messageListener!(message, sender, resolve);
      });
    },
    async fireTabUpdated(tabId: number, changeInfo: any, tab: any) {
      for (const listener of updatedListeners) {
        await listener(tabId, changeInfo, tab);
      }
    },
    async fireTabActivated(tabId: number) {
      for (const listener of activatedListeners) {
        await listener({ tabId });
      }
    },
    fireTabRemoved(tabId: number) {
      for (const listener of removedListeners) {
        listener(tabId);
      }
    },
    getMediaStreamId,
    setOptions,
    infoLogs,
  };
}

describe('background tab capture streamId lifecycle', () => {
  it('requests a fresh streamId on every START_TAB_CAPTURE because tabCapture streamIds are single-use', async () => {
    // WHY: chrome.tabCapture.getMediaStreamId returns a one-shot id consumed by
    // the frontend getUserMedia call. Returning a cached id on a repeat START
    // hands back an already-spent id, so getUserMedia fails and tab audio never
    // starts. Each START must mint a new id.
    const bg = installBackground({ streamIds: ['stream-A', 'stream-B'] });

    const first = await bg.sendMessage({ type: 'START_TAB_CAPTURE', tabId: 42 });
    const second = await bg.sendMessage({ type: 'START_TAB_CAPTURE', tabId: 42 });

    expect(first).toMatchObject({ success: true, streamId: 'stream-A' });
    expect(second).toMatchObject({ success: true, streamId: 'stream-B' });
    expect(bg.getMediaStreamId).toHaveBeenCalledTimes(2);
  });

  it('clears the cached capture for a tab when that tab navigates so no stale entry lingers', async () => {
    // WHY: a tabCapture streamId is invalidated when the captured tab navigates.
    // If background keeps the old active entry after navigation, later teardown
    // logic believes a capture is still live for a tab that has none. Navigating
    // the same tab must drop its activeTabCaptures entry.
    const bg = installBackground({ knownTabs: [5] });

    await bg.sendMessage({ type: 'START_TAB_CAPTURE', tabId: 5 });
    bg.infoLogs.length = 0;

    await bg.fireTabUpdated(
      5,
      { url: 'https://www.youtube.com/watch?v=next' },
      { url: 'https://www.youtube.com/watch?v=next' },
    );

    // After navigation the capture entry should be gone, so STOP finds nothing
    // to delete and does not emit the "Tab capture stopped" bookkeeping log.
    await bg.sendMessage({ type: 'STOP_TAB_CAPTURE', tabId: 5 });

    const stoppedLog = bg.infoLogs.find((args) =>
      typeof args[0] === 'string' && args[0].includes('Tab capture stopped for tab'),
    );
    expect(stoppedLog).toBeUndefined();
  });

  it('drops the capture entry when the captured tab is closed so no orphan capture record survives', async () => {
    // WHY: if the side panel never sends STOP (crash/close), background must
    // still not keep an active capture entry for a tab that no longer exists.
    // onRemoved is the background-side safety net guaranteeing the Map reflects
    // reality even when the frontend teardown path is skipped.
    const bg = installBackground({ knownTabs: [7] });

    await bg.sendMessage({ type: 'START_TAB_CAPTURE', tabId: 7 });
    bg.fireTabRemoved(7);
    bg.infoLogs.length = 0;

    await bg.sendMessage({ type: 'STOP_TAB_CAPTURE', tabId: 7 });

    const stoppedLog = bg.infoLogs.find((args) =>
      typeof args[0] === 'string' && args[0].includes('Tab capture stopped for tab'),
    );
    expect(stoppedLog).toBeUndefined();
  });
});

describe('background side panel visibility on tab switch', () => {
  it('disables the side panel per-tab (not the global default) when switching to an unsupported site', async () => {
    // WHY: a global setOptions({ enabled: false }) with no tabId mutates the
    // default for every tab that has no explicit per-tab option. That races
    // with the per-tab enabled:true written for supported tabs, so fast tab
    // switching can blank out a panel that should be showing. Scoping the
    // disable to the activated tabId avoids clobbering other tabs.
    const bg = installBackground({
      knownTabs: [11],
      tabUrls: { 11: 'https://example.com/page' },
    });

    bg.setOptions.mockClear();
    await bg.fireTabActivated(11);

    expect(bg.setOptions).toHaveBeenCalled();
    for (const call of bg.setOptions.mock.calls) {
      const arg = call[0];
      expect(arg).toMatchObject({ tabId: 11, enabled: false });
    }
  });
});
