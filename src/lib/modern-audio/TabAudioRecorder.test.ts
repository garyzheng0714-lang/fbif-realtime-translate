import { describe, expect, it } from 'vitest';
import { TabAudioRecorder } from './TabAudioRecorder';
import { ParticipantAudioOptions } from './IParticipantAudioRecorder';

class TestableTabAudioRecorder extends TabAudioRecorder {
  public shouldPassthroughToSpeakers(): boolean {
    return this.shouldConnectToDestination();
  }

  public async configure(options?: ParticipantAudioOptions): Promise<void> {
    await this.onAudioContextCreated(options);
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
});
