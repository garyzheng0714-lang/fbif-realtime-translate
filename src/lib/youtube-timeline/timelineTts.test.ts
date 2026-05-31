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

function resolveAllInits(): void {
  for (const engine of ttsEngineMock.instances) {
    engine.initDeferred.resolve();
  }
}

describe('TimelineTts', () => {
  beforeEach(() => {
    ttsEngineMock.instances.length = 0;
  });

  // WHY: a single edge-tts engine has a physical single-flight lock and the old code
  // funnelled every cue through one engine on one serial queue, so synthesis throughput
  // was pinned to one clip at a time and dubbing could never catch up to playback. A pool
  // of independent engines must let several short cues synthesize in parallel.
  it('synthesizes multiple cues in parallel across a pool of engines', async () => {
    const tts = new TimelineTts();

    const first = tts.generateChinese('第一句', vi.fn());
    const second = tts.generateChinese('第二句', vi.fn());
    const third = tts.generateChinese('第三句', vi.fn());
    await flushMicrotasks();
    resolveAllInits();
    await flushMicrotasks();

    // Three distinct engines are each generating one cue at the same time: no clip waits
    // for another to finish before its generateStream starts.
    const generating = ttsEngineMock.instances.filter(
      (engine) => engine.generateStream.mock.calls.length === 1,
    );
    expect(generating.length).toBe(3);
    const texts = generating.map((engine) => engine.generateStream.mock.calls[0][0]).sort();
    expect(texts).toEqual(['第一句', '第三句', '第二句'].sort());

    for (const engine of generating) {
      engine.streamDeferreds[0].resolve({ generationTimeMs: 1 });
    }
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    await expect(third).resolves.toBeUndefined();
  });

  // WHY: the pool is bounded, so when more cues arrive than there are engines the extra
  // cues must queue behind a busy engine rather than be rejected by its single-flight
  // lock. This proves the per-engine serialization that prevents the
  // 'A generation request is already in progress' error.
  it('queues overflow cues on a busy engine instead of hitting the single-flight lock', async () => {
    const tts = new TimelineTts();
    const promises = Array.from({ length: 7 }, (_unused, index) =>
      tts.generateChinese(`句${index}`, vi.fn()));
    await flushMicrotasks();
    resolveAllInits();
    await flushMicrotasks();

    // Pool is capped, so far fewer than 7 engines exist and each runs at most one cue.
    expect(ttsEngineMock.instances.length).toBeLessThan(7);
    expect(ttsEngineMock.instances.length).toBeGreaterThan(1);
    for (const engine of ttsEngineMock.instances) {
      expect(engine.generateStream.mock.calls.length).toBeLessThanOrEqual(1);
    }

    // Drain every queued cue by resolving each engine's stream until all settle.
    for (let round = 0; round < 7; round++) {
      for (const engine of ttsEngineMock.instances) {
        const pending = engine.streamDeferreds[engine.generateStream.mock.calls.length - 1];
        if (pending) pending.resolve({ generationTimeMs: 1 });
      }
      await flushMicrotasks();
    }

    await expect(Promise.all(promises)).resolves.toBeDefined();
  });

  it('converts float samples to int16 for the active cue chunk', async () => {
    const tts = new TimelineTts();
    const onChunk = vi.fn();
    const result = tts.generateChinese('第一句', onChunk);
    await flushMicrotasks();
    resolveAllInits();
    await flushMicrotasks();

    const engine = ttsEngineMock.instances.find(
      (candidate) => candidate.generateStream.mock.calls.length === 1,
    )!;
    const onStreamChunk = engine.generateStream.mock.calls[0][4]!;
    onStreamChunk(new Float32Array([-1, 0, 1]), 24000);

    expect(onChunk).toHaveBeenCalledWith({
      samples: new Int16Array([-32768, 0, 32767]),
      sampleRate: 24000,
    });

    engine.streamDeferreds[0].resolve({ generationTimeMs: 1 });
    await expect(result).resolves.toBeUndefined();
  });

  it('rejects pending initialization on dispose so switching videos cannot leave callers waiting', async () => {
    const tts = new TimelineTts();
    const init = tts.initialize();
    await flushMicrotasks();
    expect(ttsEngineMock.instances.length).toBeGreaterThan(0);

    tts.dispose();

    for (const engine of ttsEngineMock.instances) {
      expect(engine.dispose).toHaveBeenCalledTimes(1);
    }
    await expectRejectedWithoutHanging(init);
  });

  it('rejects in-flight and queued synthesis on dispose so stopping playback cannot hang the prebuffer queue', async () => {
    const tts = new TimelineTts();
    const first = tts.generateChinese('第一句', vi.fn());
    await flushMicrotasks();
    resolveAllInits();
    await flushMicrotasks();
    const busy = ttsEngineMock.instances.find(
      (engine) => engine.generateStream.mock.calls.length === 1,
    )!;

    // Queue a second cue behind the same busy engine so it is still waiting at dispose.
    const overflow = Array.from({ length: 6 }, (_unused, index) =>
      tts.generateChinese(`溢出${index}`, vi.fn()));
    tts.dispose();

    await expectRejectedWithoutHanging(first);
    for (const promise of overflow) {
      await expectRejectedWithoutHanging(promise);
    }
    expect(busy.dispose).toHaveBeenCalledTimes(1);
  });

  // WHY: when seeking/restarting, dispose must close every engine in the pool, not just
  // the idle ones. Closing a busy engine cancels its in-flight edge-tts WebSocket so a
  // no-longer-needed clip stops occupying bandwidth that the next cue needs.
  it('disposes every created engine so in-flight pool requests are cancelled, not abandoned', async () => {
    const tts = new TimelineTts();
    const promises = Array.from({ length: 3 }, (_unused, index) =>
      tts.generateChinese(`句${index}`, vi.fn()));
    await flushMicrotasks();
    resolveAllInits();
    await flushMicrotasks();

    const createdEngines = ttsEngineMock.instances.length;
    expect(createdEngines).toBeGreaterThan(1);

    tts.dispose();

    for (const engine of ttsEngineMock.instances) {
      expect(engine.dispose).toHaveBeenCalledTimes(1);
    }
    for (const promise of promises) {
      await expectRejectedWithoutHanging(promise);
    }
  });
});
