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
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;
  private disposeRejectors = new Set<(error: Error) => void>();

  initialize(): Promise<void> {
    return this.initializeForGeneration(this.generation);
  }

  private createDisposedError(): Error {
    return new Error('Timeline TTS disposed');
  }

  private withDisposeGuard<T>(promise: Promise<T>, generation: number): Promise<T> {
    if (generation !== this.generation) {
      return Promise.reject(this.createDisposedError());
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const rejectOnDispose = (error: Error) => {
        if (settled) return;
        settled = true;
        this.disposeRejectors.delete(rejectOnDispose);
        reject(error);
      };

      this.disposeRejectors.add(rejectOnDispose);

      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          this.disposeRejectors.delete(rejectOnDispose);
          if (generation !== this.generation) {
            reject(this.createDisposedError());
            return;
          }
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          this.disposeRejectors.delete(rejectOnDispose);
          reject(error);
        },
      );
    });
  }

  private initializeForGeneration(generation: number): Promise<void> {
    if (generation !== this.generation) {
      return Promise.reject(this.createDisposedError());
    }

    if (this.initPromise) {
      return this.withDisposeGuard(this.initPromise, generation);
    }

    const engine = new TtsEngine();
    this.engine = engine;
    this.initPromise = engine.init('edge-tts')
      .then(() => {
        if (this.engine !== engine || generation !== this.generation) {
          throw this.createDisposedError();
        }
      })
      .catch((error) => {
        if (this.engine === engine && generation === this.generation) {
          this.engine = null;
          this.initPromise = null;
        }
        throw error;
      });

    return this.withDisposeGuard(this.initPromise, generation);
  }

  generateChinese(
    text: string,
    onChunk: (chunk: TimelineTtsChunk) => void,
  ): Promise<void> {
    const generation = this.generation;
    const run = () => this.generateChineseForGeneration(text, onChunk, generation);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async generateChineseForGeneration(
    text: string,
    onChunk: (chunk: TimelineTtsChunk) => void,
    generation: number,
  ): Promise<void> {
    if (generation !== this.generation) {
      throw this.createDisposedError();
    }

    await this.initializeForGeneration(generation);
    if (!this.engine) {
      throw new Error('Timeline TTS engine not initialized');
    }

    const engine = this.engine;
    await this.withDisposeGuard(
      engine.generateStream(
        text,
        0,
        1.0,
        'zh-CN',
        (samples, sampleRate) => {
          if (generation !== this.generation) return;
          onChunk({
            samples: floatToInt16(samples),
            sampleRate,
          });
        },
        'zh-CN-XiaoxiaoNeural',
      ),
      generation,
    );
  }

  dispose(): void {
    this.generation += 1;
    const disposeError = this.createDisposedError();
    for (const reject of this.disposeRejectors) {
      reject(disposeError);
    }
    this.disposeRejectors.clear();

    if (this.engine) {
      this.engine.dispose();
      this.engine = null;
    }
    this.initPromise = null;
    this.queue = Promise.resolve();
  }
}
