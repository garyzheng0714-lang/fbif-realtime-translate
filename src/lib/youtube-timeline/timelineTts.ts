import { TtsEngine } from '../local-inference/engine/TtsEngine';

export interface TimelineTtsChunk {
  samples: Int16Array;
  sampleRate: number;
}

function floatToInt16(samples: Float32Array): Int16Array {
  const output = new Int16Array(samples.length);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    output[i] = clamped < 0
      ? clamped * 0x8000
      : clamped * 0x7fff;
  }

  return output;
}

export class TimelineTts {
  private engine: TtsEngine | null = null;
  private initPromise: Promise<void> | null = null;

  initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;

    const engine = new TtsEngine();
    this.engine = engine;
    this.initPromise = engine.init('edge-tts')
      .then(() => undefined)
      .catch((error) => {
        if (this.engine === engine) {
          this.engine = null;
          this.initPromise = null;
        }
        throw error;
      });

    return this.initPromise;
  }

  async generateChinese(
    text: string,
    onChunk: (chunk: TimelineTtsChunk) => void,
  ): Promise<void> {
    await this.initialize();
    if (!this.engine) {
      throw new Error('Timeline TTS engine not initialized');
    }

    await this.engine.generateStream(
      text,
      0,
      1.0,
      'zh-CN',
      (samples, sampleRate) => {
        onChunk({
          samples: floatToInt16(samples),
          sampleRate,
        });
      },
      'zh-CN-XiaoxiaoNeural',
    );
  }

  dispose(): void {
    if (this.engine) {
      this.engine.dispose();
      this.engine = null;
    }
    this.initPromise = null;
  }
}
