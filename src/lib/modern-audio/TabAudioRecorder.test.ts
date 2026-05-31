import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabAudioRecorder } from './TabAudioRecorder';
import { ParticipantAudioOptions } from './IParticipantAudioRecorder';

class TestableTabAudioRecorder extends TabAudioRecorder {
  public shouldPassthroughToSpeakers(): boolean {
    return this.shouldConnectToDestination();
  }

  public async configure(options?: ParticipantAudioOptions): Promise<void> {
    await this.onAudioContextCreated(options);
  }

  public acquireStreamForTest(options?: ParticipantAudioOptions): Promise<MediaStream> {
    return this.acquireStream(options);
  }
}

describe('TabAudioRecorder passthrough', () => {
  it('keeps captured tab audio audible by default for upstream compatibility', async () => {
    const recorder = new TestableTabAudioRecorder();

    await recorder.configure();

    expect(recorder.shouldPassthroughToSpeakers()).toBe(true);
  });

  it('can capture tab audio without playing the English original back to speakers', async () => {
    const recorder = new TestableTabAudioRecorder();

    await recorder.configure({ passthrough: false });

    expect(recorder.shouldPassthroughToSpeakers()).toBe(false);
  });

  it('warns instead of silently dropping the output device when passthrough is off', async () => {
    // WHY: in path A passthrough is always false, so onAudioContextCreated
    // returns before setSinkId runs. The caller still passes the selected
    // participant output device, which the recorder cannot honor here (the
    // translated audio is routed by ModernAudioPlayer, not this recorder).
    // Silently ignoring it makes "I changed the device but nothing happened"
    // undebuggable, so surface a warning naming the ignored device.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recorder = new TestableTabAudioRecorder();

    await recorder.configure({ passthrough: false, outputDeviceId: 'participant-speaker-1' });

    const warnedAboutDevice = warnSpy.mock.calls.some((args) =>
      args.some((arg) => typeof arg === 'string' && arg.includes('participant-speaker-1')),
    );
    expect(warnedAboutDevice).toBe(true);

    warnSpy.mockRestore();
  });

  it('does not warn about an ignored output device when none was provided', async () => {
    // WHY: the warning must only fire when the caller actually selected a
    // device that gets dropped, not on the common default-device path.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recorder = new TestableTabAudioRecorder();

    await recorder.configure({ passthrough: false });

    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});

describe('TabAudioRecorder stream acquisition failure cleanup', () => {
  const sentMessages: any[] = [];
  const originalNavigator = (globalThis as any).navigator;

  beforeEach(() => {
    sentMessages.length = 0;
    (globalThis as any).chrome = {
      runtime: {
        lastError: null,
        sendMessage: vi.fn((message: any, callback: (response: any) => void) => {
          sentMessages.push(message);
          // START_TAB_CAPTURE succeeds and hands back a streamId; everything
          // else (STOP_TAB_CAPTURE) just acknowledges.
          if (message.type === 'START_TAB_CAPTURE') {
            callback({ success: true, streamId: 'stream-xyz' });
          } else {
            callback({ success: true });
          }
        }),
      },
    };
  });

  afterEach(() => {
    delete (globalThis as any).chrome;
    // Restore navigator so the patched mediaDevices does not leak into other
    // tests sharing this worker's global scope.
    if (originalNavigator === undefined) {
      delete (globalThis as any).navigator;
    } else {
      (globalThis as any).navigator = originalNavigator;
    }
    vi.restoreAllMocks();
  });

  it('tells background to stop the capture when getUserMedia rejects so no stale active entry remains', async () => {
    // WHY: background optimistically records active:true as soon as it mints a
    // streamId. If the frontend getUserMedia then fails, begin() runs the base
    // cleanup (track.stop only) and never calls onCleanup, so STOP_TAB_CAPTURE
    // is never sent and background keeps a dead active entry. A later session
    // would then be wedged. acquireStream must send STOP itself on failure.
    const getUserMedia = vi.fn(async () => {
      throw new Error('Could not start audio source');
    });
    (globalThis as any).navigator = { mediaDevices: { getUserMedia } };

    const recorder = new TestableTabAudioRecorder();

    await expect(recorder.acquireStreamForTest({ tabId: 99 })).rejects.toThrow(
      'Could not start audio source',
    );

    const stopMessages = sentMessages.filter((m) => m.type === 'STOP_TAB_CAPTURE');
    expect(stopMessages).toHaveLength(1);
    expect(stopMessages[0]).toMatchObject({ type: 'STOP_TAB_CAPTURE', tabId: 99 });
  });

  it('does not send a spurious STOP_TAB_CAPTURE when getUserMedia succeeds', async () => {
    // WHY: the failure-path STOP must not fire on the happy path, otherwise it
    // would tear down the capture that was just established.
    const fakeStream = {} as MediaStream;
    const getUserMedia = vi.fn(async () => fakeStream);
    (globalThis as any).navigator = { mediaDevices: { getUserMedia } };

    const recorder = new TestableTabAudioRecorder();

    await expect(recorder.acquireStreamForTest({ tabId: 99 })).resolves.toBe(fakeStream);

    const stopMessages = sentMessages.filter((m) => m.type === 'STOP_TAB_CAPTURE');
    expect(stopMessages).toHaveLength(0);
  });
});
