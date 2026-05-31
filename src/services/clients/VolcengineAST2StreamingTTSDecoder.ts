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
  // Monotonic per-sentence sequence. startSentence() bumps it synchronously; every
  // decode/flush captures the sequence it was issued under and only emits audio /
  // touches the flags while still current. This makes the flags belong to exactly
  // one sentence regardless of how decode operations interleave on the shared queue.
  private sentenceSeq = 0;

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
    // Reset the availability flags SYNCHRONOUSLY: the client calls this
    // fire-and-forget on TTSSentenceStart and then reads isAvailable() /
    // hasEmittedAudio() synchronously on TTSSentenceEnd to classify the
    // sentence. Queuing the flag reset behind a still-pending previous-sentence
    // operation would make those reads see the previous sentence's stale state
    // (e.g. available=false after a decode failure, emittedAudio=true), so the
    // new sentence gets misclassified as an already-played failed sentence and
    // its dubbing is dropped.
    this.sentenceSeq += 1;
    this.available = true;
    this.emittedAudio = false;
    // The decoder.reset() itself stays on the serial operationQueue so the
    // previous sentence's decode/flush against the shared WASM decoder fully
    // completes before this sentence resets that same decoder — otherwise the
    // reset could wipe state mid-flush and clip the previous sentence's tail.
    const seq = this.sentenceSeq;
    await this.enqueue(async () => {
      // If an even newer sentence started while this reset was queued, let that
      // newest sentence own the reset.
      if (seq !== this.sentenceSeq) return;
      const decoder = await this.getDecoder();
      await decoder.reset?.();
    });
  }

  async decodeChunk(chunk: Uint8Array): Promise<boolean> {
    const seq = this.sentenceSeq;
    return this.enqueue(async () => {
      if (!this.available) return false;
      const decodeStartedAt = Date.now();
      try {
        // Still feed the chunk to the shared decoder even if a newer sentence has
        // started (keeps the WASM decoder's byte stream consistent until the
        // queued reset wipes it); just don't EMIT it under, or flip the flags of,
        // a sentence that has already moved on.
        const decoder = await this.getDecoder();
        const decoded = await decoder.decode(chunk);
        if (seq !== this.sentenceSeq) return false;
        return this.emitDecoded(decoded, {
          sourceBytes: chunk.length,
          decodeStartedAt,
          decodeCompletedAt: Date.now(),
        });
      } catch (error) {
        console.warn('[VolcengineAST2Client] Streaming TTS decode failed, falling back to whole-sentence decode:', error);
        // Only mark the CURRENT sentence unavailable; a stale failure must not
        // poison a sentence that already moved on.
        if (seq === this.sentenceSeq) this.available = false;
        return false;
      }
    });
  }

  async finishSentence(): Promise<boolean> {
    const seq = this.sentenceSeq;
    return this.enqueue(async () => {
      if (!this.available) return false;
      const decodeStartedAt = Date.now();
      try {
        const decoder = await this.getDecoder();
        const decoded = await decoder.flush();
        // Drain the tail into the decoder, but only emit it if this sentence is
        // still current (a newer startSentence supersedes a late flush).
        if (seq !== this.sentenceSeq) return false;
        return this.emitDecoded(decoded, {
          sourceBytes: 0,
          decodeStartedAt,
          decodeCompletedAt: Date.now(),
        });
      } catch (error) {
        console.warn('[VolcengineAST2Client] Streaming TTS flush failed, falling back to whole-sentence decode:', error);
        if (seq === this.sentenceSeq) this.available = false;
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
