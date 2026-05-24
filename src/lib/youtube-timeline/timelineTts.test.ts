import { beforeEach, describe, expect, it, vi } from 'vitest';

const ttsEngineMock = vi.hoisted(() => {
  interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
  }

  function createDeferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    return { promise, resolve, reject };
  }

  const instances: TtsEngine[] = [];

  class TtsEngine {
    initDeferred = createDeferred<void>();
    streamDeferreds: Array<Deferred<{ generationTimeMs: number }>> = [];
    init = vi.fn((_modelId: string) => this.initDeferred.promise);
    generateStream = vi.fn((
      _text: string,
      _sid: number,
      _speed: number,
      _lang: string,
      _onChunk?: (samples: Float32Array, sampleRate: number) => void,
      _voice?: string,
    ) => {
      const deferred = createDeferred<{ generationTimeMs: number }>();
      this.streamDeferreds.push(deferred);
      return deferred.promise;
    });
    dispose = vi.fn();

    constructor() {
      instances.push(this);
    }
  }

  return { instances, TtsEngine };
});

vi.mock('../local-inference/engine/TtsEngine', () => ({
  TtsEngine: ttsEngineMock.TtsEngine,
}));

const { TimelineTts } = await import('./timelineTts');

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function expectRejectedWithoutHanging(promise: Promise<unknown>): Promise<void> {
  await expect(Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve('still pending'), 0)),
  ])).rejects.toThrow(/disposed/i);
}

describe('TimelineTts', () => {
  beforeEach(() => {
    ttsEngineMock.instances.length = 0;
  });

  it('serializes prebuffered cue synthesis so a second cue is not rejected by the single-flight engine', async () => {
    const tts = new TimelineTts();
    const firstChunk = vi.fn();
    const secondChunk = vi.fn();

    const first = tts.generateChinese('第一句', firstChunk);
    const second = tts.generateChinese('第二句', secondChunk);
    await flushMicrotasks();
    const engine = ttsEngineMock.instances[0];

    engine.initDeferred.resolve();
    await flushMicrotasks();

    expect(engine.generateStream).toHaveBeenCalledTimes(1);
    expect(engine.generateStream.mock.calls[0][0]).toBe('第一句');

    const onFirstChunk = engine.generateStream.mock.calls[0][4]!;
    onFirstChunk(new Float32Array([-1, 0, 1]), 24000);
    expect(firstChunk).toHaveBeenCalledWith({
      samples: new Int16Array([-32768, 0, 32767]),
      sampleRate: 24000,
    });
    expect(secondChunk).not.toHaveBeenCalled();

    engine.streamDeferreds[0].resolve({ generationTimeMs: 1 });
    await expect(first).resolves.toBeUndefined();
    await flushMicrotasks();

    expect(engine.generateStream).toHaveBeenCalledTimes(2);
    expect(engine.generateStream.mock.calls[1][0]).toBe('第二句');

    engine.streamDeferreds[1].resolve({ generationTimeMs: 1 });
    await expect(second).resolves.toBeUndefined();
  });

  it('rejects pending initialization on dispose so switching videos cannot leave callers waiting', async () => {
    const tts = new TimelineTts();
    const init = tts.initialize();
    const engine = ttsEngineMock.instances[0];

    tts.dispose();

    expect(engine.dispose).toHaveBeenCalledTimes(1);
    await expectRejectedWithoutHanging(init);
  });

  it('rejects in-flight and queued synthesis on dispose so stopping playback cannot hang the prebuffer queue', async () => {
    const tts = new TimelineTts();
    const first = tts.generateChinese('第一句', vi.fn());
    await flushMicrotasks();
    const engine = ttsEngineMock.instances[0];

    engine.initDeferred.resolve();
    await flushMicrotasks();
    expect(engine.generateStream).toHaveBeenCalledTimes(1);

    const second = tts.generateChinese('第二句', vi.fn());
    tts.dispose();

    await expectRejectedWithoutHanging(first);
    await expectRejectedWithoutHanging(second);
  });
});
