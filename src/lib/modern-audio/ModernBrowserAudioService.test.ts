import { describe, expect, it, vi } from 'vitest';
import { ModernBrowserAudioService } from './ModernBrowserAudioService';

/**
 * Builds a ModernBrowserAudioService instance WITHOUT running the constructor,
 * so the tab-audio teardown paths can be exercised in jsdom without pulling in
 * AudioContext-dependent components (ModernAudioRecorder/Player). We only need
 * the tab-audio private fields wired up.
 */
function makeServiceWithActiveTabRecording() {
  const service = Object.create(ModernBrowserAudioService.prototype) as ModernBrowserAudioService;

  // A fake TabAudioRecorder that records which teardown methods were invoked.
  const recorder = {
    requestStopCaptureSync: vi.fn(),
    end: vi.fn(async () => {}),
  };
  const callback = vi.fn();

  const fields = service as unknown as {
    tabAudioRecorder: typeof recorder | null;
    tabAudioCallback: typeof callback | null;
    tabAudioRecordingActive: boolean;
  };
  fields.tabAudioRecorder = recorder;
  fields.tabAudioCallback = callback;
  fields.tabAudioRecordingActive = true;

  return { service, recorder, callback, fields };
}

describe('ModernBrowserAudioService sync tab-audio teardown', () => {
  // WHY: on side-panel pagehide we stop the capture synchronously. The async
  // stopTabAudioRecording() gates its recorder.end() on `tabAudioRecorder` being
  // non-null, NOT on `tabAudioRecordingActive`. If the sync path flips the
  // active flag but leaves the recorder reference dangling, a later teardown
  // (e.g. React unmount after a bfcache restore routing through
  // disconnectConversation -> stopTabAudioRecording) finds the recorder still
  // set and double-stops it: a second recorder.end() + a redundant
  // STOP_TAB_CAPTURE against an already-stopped capture. The sync path must
  // clear the recorder reference so its state is symmetric with the async stop.
  it('clears the recorder reference so a subsequent async stop does not double-stop', async () => {
    const { service, recorder, fields } = makeServiceWithActiveTabRecording();

    service.stopTabAudioRecordingSync();

    // Sync path must drop the recorder reference (symmetric with async stop).
    expect(fields.tabAudioRecorder).toBeNull();
    // The sync path stops the local capture exactly once.
    expect(recorder.end).toHaveBeenCalledTimes(1);

    // A later async teardown must NOT re-end the already torn-down recorder;
    // because the reference was nulled, end() stays at a single call.
    await service.stopTabAudioRecording();
    expect(recorder.end).toHaveBeenCalledTimes(1);
  });

  // WHY: isTabAudioRecordingActive() returns tabAudioRecordingActive, which the
  // sync path sets to false. Callers use that to decide whether cleanup is still
  // needed. If the sync path reports "inactive" while the live capture/track is
  // still around (recorder reference + callback left dangling), it masks a
  // surviving recorder. State must be fully torn down, matching the async path.
  it('drops the callback and reports inactive so it does not mask a surviving recorder', () => {
    const { service, fields } = makeServiceWithActiveTabRecording();

    service.stopTabAudioRecordingSync();

    expect(fields.tabAudioCallback).toBeNull();
    expect(service.isTabAudioRecordingActive()).toBe(false);
  });

  // WHY: the sync path must still tell the background to stop the Chrome
  // tabCapture (the actual source of original-audio suppression), and must also
  // stop the local capture so no track keeps running if the page survives in
  // bfcache. Both are driven through the recorder, captured before the field is
  // nulled so the async stop cannot also touch it.
  it('tells the recorder to stop the background capture on the sync path', () => {
    const { service, recorder } = makeServiceWithActiveTabRecording();

    service.stopTabAudioRecordingSync();

    expect(recorder.requestStopCaptureSync).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when no tab recording is active', () => {
    const service = Object.create(ModernBrowserAudioService.prototype) as ModernBrowserAudioService;
    const fields = service as unknown as {
      tabAudioRecorder: unknown;
      tabAudioRecordingActive: boolean;
    };
    fields.tabAudioRecorder = null;
    fields.tabAudioRecordingActive = false;

    // Must not throw and must leave everything inactive.
    expect(() => service.stopTabAudioRecordingSync()).not.toThrow();
    expect(service.isTabAudioRecordingActive()).toBe(false);
  });
});
