import { ParticipantRecorder } from './ParticipantRecorder';
import { ParticipantAudioOptions } from './IParticipantAudioRecorder';

/* global chrome */

/**
 * Tab Audio Recorder for browser extension
 * Captures audio from the current tab using Chrome's tabCapture API
 * Used for translating other meeting participants' voices in video conferencing
 */
export class TabAudioRecorder extends ParticipantRecorder {
  private tabId: number | null = null;
  private streamId: string | null = null;
  private outputDeviceId: string | null = null;
  private passthrough: boolean = true;

  protected getLogPrefix(): string {
    return '[TabAudioRecorder]';
  }

  protected shouldConnectToDestination(): boolean {
    return this.passthrough;
  }

  /**
   * Configure AudioContext output device for tab audio passthrough.
   * Chrome tabCapture stops original tab audio, so we must manually route it to the output device.
   */
  protected async onAudioContextCreated(options?: ParticipantAudioOptions): Promise<void> {
    this.outputDeviceId = options?.outputDeviceId || null;
    this.passthrough = options?.passthrough ?? true;

    if (!this.passthrough) {
      console.info(`${this.getLogPrefix()} Tab audio passthrough disabled`);
      // With passthrough off (path A), setSinkId below never runs, so an
      // output device passed here is dropped. The translated audio is routed
      // by ModernAudioPlayer instead. Warn loudly rather than silently ignore
      // the device, so a mismatched device selection is debuggable.
      if (this.outputDeviceId) {
        console.warn(
          `${this.getLogPrefix()} Output device ignored while passthrough is off (routed by player instead):`,
          this.outputDeviceId
        );
      }
      return;
    }

    // Set output device if specified (Chrome 110+ supports setSinkId)
    // Required for tab capture: Chrome stops original audio when tab is captured
    if (this.outputDeviceId && this.audioContext && 'setSinkId' in this.audioContext) {
      try {
        // @ts-expect-error setSinkId is not in TypeScript types yet
        await this.audioContext.setSinkId(this.outputDeviceId);
        console.info(`${this.getLogPrefix()} Set audio output device:`, this.outputDeviceId);
      } catch (sinkError) {
        console.warn(`${this.getLogPrefix()} Failed to set output device, using default:`, sinkError);
      }
    }
  }

  protected async acquireStream(options?: ParticipantAudioOptions): Promise<MediaStream> {
    // Get tab ID
    this.tabId = options?.tabId ?? await this.getTabIdFromContext();
    if (!this.tabId) {
      throw new Error('Could not determine tab ID for audio capture');
    }

    console.info(`${this.getLogPrefix()} Starting capture for tab:`, this.tabId);

    // Request stream ID from background script
    const response = await this.sendMessageToBackground({
      type: 'START_TAB_CAPTURE',
      tabId: this.tabId
    });

    if (!response.success) {
      throw new Error(response.error || 'Failed to start tab capture');
    }

    this.streamId = response.streamId || null;
    console.info(`${this.getLogPrefix()} Received streamId:`, this.streamId);

    // Get media stream using Chrome tab capture.
    // If getUserMedia fails (e.g. the single-use streamId is already spent),
    // begin()'s catch path runs the base cleanup only and never reaches
    // onCleanup, so STOP_TAB_CAPTURE would never be sent and background would
    // keep a dead active entry that wedges the next session. Send STOP here.
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          // @ts-expect-error Chrome-specific constraints
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: this.streamId
          }
        },
        video: false
      });
    } catch (error) {
      await this.sendMessageToBackground({ type: 'STOP_TAB_CAPTURE', tabId: this.tabId });
      throw error;
    }
  }

  protected async onCleanup(): Promise<void> {
    // Notify background script to stop capture
    if (this.tabId) {
      await this.sendMessageToBackground({ type: 'STOP_TAB_CAPTURE', tabId: this.tabId });
    }
    this.tabId = null;
    this.streamId = null;
  }

  private async getTabIdFromContext(): Promise<number | null> {
    const urlParams = new URLSearchParams(window.location.search);
    const tabIdParam = urlParams.get('tabId');
    if (tabIdParam) return parseInt(tabIdParam, 10);

    if (typeof chrome !== 'undefined' && chrome.tabs) {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length > 0 && tabs[0].id) return tabs[0].id;
      } catch (error) {
        console.error(`${this.getLogPrefix()} Error querying tabs:`, error);
      }
    }
    return null;
  }

  private sendMessageToBackground(message: object): Promise<{ success: boolean; streamId?: string; error?: string }> {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.runtime) {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(response || { success: false, error: 'No response' });
          }
        });
      } else {
        resolve({ success: false, error: 'Chrome runtime not available' });
      }
    });
  }
}
