import { TtsEngine } from '../local-inference/engine/TtsEngine';
// Reuse the shared PCM quantizer instead of a byte-identical private copy so the
// timeline dub and every other TTS output (LocalInferenceClient / gtcrn) stay in
// lockstep if the quantization strategy ever changes (finding 9).
import { float32ToInt16 } from '../../utils/audio-conversion';

export interface TimelineTtsChunk {
  samples: Int16Array;
  sampleRate: number;
}

// Each TtsEngine holds one edge-tts WebSocket with a physical single-flight lock, so
// throughput per engine is one clip at a time. A small pool of independent engines lets
// several short cues synthesize in parallel, which is what keeps dubbing prebuffer from
// falling behind playback. Two to four engines balances parallelism against socket cost.
const TTS_POOL_SIZE = 3;

interface TtsSlot {
  engine: TtsEngine | null;
  initPromise: Promise<void> | null;
  // Serial queue inside a single engine so two cues never trip the engine's
  // single-flight lock; the pool provides cross-slot parallelism.
  queue: Promise<void>;
  // Number of cues queued or running on this slot, used to pick the least-busy slot.
  pending: number;
}

export class TimelineTts {
  private slots: TtsSlot[] = Array.from({ length: TTS_POOL_SIZE }, () => ({
    engine: null,
    initPromise: null,
    queue: Promise.resolve(),
    pending: 0,
  }));
  private generation = 0;
  private disposeRejectors = new Set<(error: Error) => void>();

  initialize(): Promise<void> {
    return this.initializeSlotForGeneration(this.slots[0], this.generation);
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

  private initializeSlotForGeneration(slot: TtsSlot, generation: number): Promise<void> {
    if (generation !== this.generation) {
      return Promise.reject(this.createDisposedError());
    }

    if (slot.initPromise) {
      return this.withDisposeGuard(slot.initPromise, generation);
    }

    const engine = new TtsEngine();
    slot.engine = engine;
    slot.initPromise = engine.init('edge-tts')
      .then(() => {
        if (slot.engine !== engine || generation !== this.generation) {
          throw this.createDisposedError();
        }
      })
      .catch((error) => {
        if (slot.engine === engine && generation === this.generation) {
          slot.engine = null;
          slot.initPromise = null;
        }
        throw error;
      });

    return this.withDisposeGuard(slot.initPromise, generation);
  }

  generateChinese(
    text: string,
    onChunk: (chunk: TimelineTtsChunk) => void,
  ): Promise<void> {
    const generation = this.generation;
    // Dispatch to the least-busy slot so dense windows fan out across the pool while a
    // single engine still serializes its own cues.
    const slot = this.slots.reduce((least, candidate) => (
      candidate.pending < least.pending ? candidate : least
    ), this.slots[0]);

    slot.pending += 1;
    const run = () => this.generateChineseForGeneration(slot, text, onChunk, generation);
    const result = slot.queue.then(run, run);
    slot.queue = result.catch(() => undefined);
    return result.finally(() => {
      slot.pending -= 1;
    });
  }

  private async generateChineseForGeneration(
    slot: TtsSlot,
    text: string,
    onChunk: (chunk: TimelineTtsChunk) => void,
    generation: number,
  ): Promise<void> {
    if (generation !== this.generation) {
      throw this.createDisposedError();
    }

    await this.initializeSlotForGeneration(slot, generation);
    if (!slot.engine) {
      throw new Error('Timeline TTS engine not initialized');
    }

    const engine = slot.engine;
    await this.withDisposeGuard(
      engine.generateStream(
        text,
        0,
        1.0,
        'zh-CN',
        (samples, sampleRate) => {
          if (generation !== this.generation) return;
          onChunk({
            samples: float32ToInt16(samples),
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

    for (const slot of this.slots) {
      if (slot.engine) {
        slot.engine.dispose();
        slot.engine = null;
      }
      slot.initPromise = null;
      slot.queue = Promise.resolve();
      slot.pending = 0;
    }
  }
}
