export interface DecodedOggOpusAudio {
  channelData: Float32Array[];
  samplesDecoded?: number;
  sampleRate?: number;
}

export interface StreamingOggOpusDecoder {
  ready?: Promise<void>;
  decode: (data: Uint8Array) => DecodedOggOpusAudio | Promise<DecodedOggOpusAudio>;
  flush: () => DecodedOggOpusAudio | Promise<DecodedOggOpusAudio>;
  reset?: () => void | Promise<void>;
  free?: () => void | Promise<void>;
}

export type StreamingDecoderFactory = () => StreamingOggOpusDecoder | Promise<StreamingOggOpusDecoder>;

export interface StreamingTTSEmitMeta {
  sourceBytes: number;
  decodeStartedAt: number;
  decodeCompletedAt: number;
  samplesDecoded?: number;
  sampleRate?: number;
}

export function decodedOggOpusToInt16(decoded: DecodedOggOpusAudio): Int16Array {
  const float32 = decoded.channelData[0];
  if (!float32 || float32.length === 0) return new Int16Array(0);

  const int16Array = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return int16Array;
}

export class VolcengineAST2StreamingTTSDecoder {
  private decoderPromise: Promise<StreamingOggOpusDecoder> | null = null;
  private operationQueue: Promise<unknown> = Promise.resolve();
  private available = true;
  private emittedAudio = false;

  constructor(
    private readonly createDecoder: StreamingDecoderFactory,
    private readonly emitAudio: (audio: Int16Array, meta: StreamingTTSEmitMeta) => void
  ) {}

  isAvailable(): boolean {
    return this.available;
  }

  hasEmittedAudio(): boolean {
    return this.emittedAudio;
  }

  async startSentence(): Promise<void> {
    // Chain the reset onto the existing operationQueue instead of discarding it,
    // so the previous sentence's decode/flush against the shared decoder fully
    // completes before this sentence resets that same decoder. Resetting the
    // availability flags inside the serial chain keeps them ordered relative to
    // the previous sentence's last emit, avoiding a state race on the shared
    // WASM decoder that would clip the previous sentence's tail audio.
    await this.enqueue(async () => {
      this.available = true;
      this.emittedAudio = false;
      const decoder = await this.getDecoder();
      await decoder.reset?.();
    });
  }

  async decodeChunk(chunk: Uint8Array): Promise<boolean> {
    return this.enqueue(async () => {
      if (!this.available) return false;
      const decodeStartedAt = Date.now();
      try {
        const decoder = await this.getDecoder();
        const decoded = await decoder.decode(chunk);
        return this.emitDecoded(decoded, {
          sourceBytes: chunk.length,
          decodeStartedAt,
          decodeCompletedAt: Date.now(),
        });
      } catch (error) {
        console.warn('[VolcengineAST2Client] Streaming TTS decode failed, falling back to whole-sentence decode:', error);
        this.available = false;
        return false;
      }
    });
  }

  async finishSentence(): Promise<boolean> {
    return this.enqueue(async () => {
      if (!this.available) return false;
      const decodeStartedAt = Date.now();
      try {
        const decoder = await this.getDecoder();
        const decoded = await decoder.flush();
        return this.emitDecoded(decoded, {
          sourceBytes: 0,
          decodeStartedAt,
          decodeCompletedAt: Date.now(),
        });
      } catch (error) {
        console.warn('[VolcengineAST2Client] Streaming TTS flush failed, falling back to whole-sentence decode:', error);
        this.available = false;
        return false;
      }
    });
  }

  async dispose(): Promise<void> {
    const decoder = this.decoderPromise ? await this.decoderPromise.catch(() => null) : null;
    await decoder?.free?.();
    this.decoderPromise = null;
    this.operationQueue = Promise.resolve();
    this.available = true;
    this.emittedAudio = false;
  }

  private async getDecoder(): Promise<StreamingOggOpusDecoder> {
    if (!this.decoderPromise) {
      this.decoderPromise = Promise.resolve(this.createDecoder()).then(async (decoder) => {
        await decoder.ready;
        return decoder;
      });
    }
    return this.decoderPromise;
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationQueue.then(operation, operation);
    this.operationQueue = next.catch(() => {});
    return next;
  }

  private emitDecoded(decoded: DecodedOggOpusAudio, meta: StreamingTTSEmitMeta): boolean {
    const audio = decodedOggOpusToInt16(decoded);
    if (audio.length === 0) return false;
    this.emittedAudio = true;
    this.emitAudio(audio, {
      ...meta,
      samplesDecoded: decoded.samplesDecoded,
      sampleRate: decoded.sampleRate,
    });
    return true;
  }
}
