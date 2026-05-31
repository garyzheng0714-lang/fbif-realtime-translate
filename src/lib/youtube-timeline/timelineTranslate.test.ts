import { describe, expect, it, vi } from 'vitest';
import {
  getTimelineCuesToTranslate,
  mergeShortCues,
  translateTimelineCueBatch,
  translateTimelineCues,
  TranslationEngineTimelineTranslator,
} from './timelineTranslate';
import type { TimelineCue } from './types';

const cues: TimelineCue[] = [
  {
    id: 'a',
    startMs: 0,
    endMs: 700,
    sourceText: 'Hello',
  },
  {
    id: 'b',
    startMs: 700,
    endMs: 1500,
    sourceText: 'world',
  },
  {
    id: 'c',
    startMs: 2400,
    endMs: 5200,
    sourceText: 'Long enough',
  },
];

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function expectRejectedWithoutHanging(promise: Promise<unknown>): Promise<void> {
  await expect(Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve('still pending'), 0)),
  ])).rejects.toThrow(/translation disposed/i);
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 10; i++) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error('condition was not met');
}

describe('timelineTranslate', () => {
  it('merges short adjacent cues so TTS receives less fragmented timeline text', () => {
    const merged = mergeShortCues(cues, 1800);

    expect(merged).toEqual([
      {
        id: 'a+b',
        startMs: 0,
        endMs: 1500,
        sourceText: 'Hello world',
      },
      cues[2],
    ]);
  });

  it('does not merge near-threshold cues into a much longer cue', () => {
    const nearThresholdCues: TimelineCue[] = [
      {
        id: 'a',
        startMs: 0,
        endMs: 1700,
        sourceText: 'First near-threshold cue',
      },
      {
        id: 'b',
        startMs: 1700,
        endMs: 3400,
        sourceText: 'Second near-threshold cue',
      },
    ];

    expect(mergeShortCues(nearThresholdCues, 1800)).toEqual(nearThresholdCues);
  });

  // WHY: mergeShortCues fuses adjacent cues into a synthetic 'a+b' id, but MainPanel
  // keys translated text back by the ORIGINAL cue id. If translateTimelineCues returned
  // the merged cue, every original cue ('a','b') would miss the lookup and silently fall
  // back to the English source. Fanning the merged translation back onto each original
  // cue keeps the id contract consistent so the translation actually reaches the cue.
  it('maps a merged translation back onto every original cue id', async () => {
    const translator = {
      translateBatch: vi.fn(async (texts: string[]) => texts.map((text) => `中文:${text}`)),
    };

    const translated = await translateTimelineCues(cues, translator, 'zh');

    expect(translator.translateBatch).toHaveBeenCalledWith(['Hello world', 'Long enough'], 'zh');
    expect(translated.map((cue) => cue.id)).toEqual(['a', 'b', 'c']);
    expect(translated.map((cue) => cue.translatedText)).toEqual([
      '中文:Hello world',
      '中文:Hello world',
      '中文:Long enough',
    ]);
  });

  // WHY: mergeShortCues assumes ascending input order to decide adjacency. parseYouTubeJson3
  // now sorts, but the merge helper must not silently group time-disjoint cues if it is
  // ever handed an unsorted array, so it sorts defensively at the entry point.
  it('sorts unsorted input before merging adjacent cues', () => {
    const unsorted: TimelineCue[] = [cues[2], cues[0], cues[1]];

    const merged = mergeShortCues(unsorted, 1800);

    expect(merged).toEqual([
      {
        id: 'a+b',
        startMs: 0,
        endMs: 1500,
        sourceText: 'Hello world',
      },
      cues[2],
    ]);
  });

  it('maps incremental batch translations without changing cue timing or ids', async () => {
    const translator = {
      translateBatch: vi.fn(async (texts: string[]) => texts.map((text) => `中文:${text}`)),
    };

    const translated = await translateTimelineCueBatch(cues.slice(0, 2), translator, 'zh');

    expect(translator.translateBatch).toHaveBeenCalledWith(['Hello', 'world'], 'zh');
    expect(translated).toEqual([
      {
        ...cues[0],
        translatedText: '中文:Hello',
      },
      {
        ...cues[1],
        translatedText: '中文:world',
      },
    ]);
  });

  it('selects only untranslated cues that are not already translating or queued', () => {
    expect(
      getTimelineCuesToTranslate(
        [
          cues[0],
          { ...cues[1], translatedText: '已翻译' },
          cues[2],
        ],
        new Set(['c']),
        new Set(['c']),
      ),
    ).toEqual([cues[0]]);
  });

  it('does not treat an empty translatedText as still waiting for translation', () => {
    expect(
      getTimelineCuesToTranslate(
        [{ ...cues[0], translatedText: '' }],
        new Set(),
        new Set(),
      ),
    ).toEqual([]);
  });

  it('fails loud when the translator returns fewer results than requested', async () => {
    const translator = {
      translateBatch: vi.fn(async () => ['只有一句']),
    };

    await expect(translateTimelineCues(cues, translator, 'zh')).rejects.toThrow(
      /翻译结果数量不匹配/,
    );
  });

  // WHY: Bing translation occasionally returns an empty string for a single cue as
  // normal jitter. Throwing on it used to bubble up through translateCueWindow ->
  // failTimeline and stop the entire video session on the first blank result, which on
  // long videos is almost guaranteed. Degrade per-cue: leave translatedText undefined so
  // getTimelineCuesToTranslate re-selects it on the next window instead of killing the run.
  it('skips an empty translation per-cue instead of failing the whole session', async () => {
    const translator = {
      translateBatch: vi.fn(async () => ['   ', '中文:world']),
    };

    const translated = await translateTimelineCueBatch(cues.slice(0, 2), translator, 'zh');

    expect(translated[0].translatedText).toBeUndefined();
    expect(translated[1].translatedText).toBe('中文:world');
  });

  // WHY: the worker pool writes `result.translatedText` into the result slot, and a
  // jittery Bing reply can have translatedText === undefined (field missing), so the
  // array handed to translateTimelineCueBatch is effectively `(string | undefined)[]`.
  // Calling .trim() on undefined threw a TypeError that bubbled through
  // translateCueWindow -> failTimeline and killed the whole session — the exact
  // failure mode finding 9 set out to remove. An undefined reply must degrade to the
  // same per-cue skip as a blank string, not crash the batch.
  it('treats an undefined translation like a blank one (degrades, does not throw)', async () => {
    const translator = {
      // The runtime array is sparse/undefined-bearing even though the type says string[].
      translateBatch: vi.fn(async () => [undefined, '中文:world'] as unknown as string[]),
    };

    const translated = await translateTimelineCueBatch(cues.slice(0, 2), translator, 'zh');

    expect(translated[0].translatedText).toBeUndefined();
    expect(translated[1].translatedText).toBe('中文:world');
  });

  it('uses the injected translation engine in order without starting a real worker', async () => {
    const engine = {
      init: vi.fn(async () => ({ loadTimeMs: 1, device: 'mock' })),
      translate: vi.fn(async (text: string) => ({
        sourceText: text,
        translatedText: `译文:${text}`,
        inferenceTimeMs: 1,
      })),
      dispose: vi.fn(),
    };
    const translator = new TranslationEngineTimelineTranslator({
      sourceLanguage: 'en',
      createEngine: () => engine,
    });

    await expect(translator.translateBatch(['First', 'Second'], 'zh')).resolves.toEqual([
      '译文:First',
      '译文:Second',
    ]);

    expect(engine.init).toHaveBeenCalledWith('en', 'zh', 'bing-translator');
    expect(engine.translate).toHaveBeenNthCalledWith(1, 'First', expect.any(String), true);
    expect(engine.translate).toHaveBeenNthCalledWith(2, 'Second', expect.any(String), true);

    translator.dispose();
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  // WHY: tick passes the whole [now, now+prebuffer] window as one batch every 350ms.
  // Awaiting each Bing round-trip serially makes a dense N-cue window take N x RTT, so
  // recently-entered captions wait behind older ones and subtitles fall behind playback.
  // The worker is request/response and pairs replies by id, so multiple translate calls
  // can be in flight at once. This asserts the batch fires concurrently rather than
  // strictly one-at-a-time.
  it('translates a batch concurrently instead of one round-trip at a time', async () => {
    const inflight: string[] = [];
    const deferreds = new Map<string, ReturnType<typeof createDeferred<{
      sourceText: string;
      translatedText: string;
      inferenceTimeMs: number;
    }>>>();
    const engine = {
      init: vi.fn(async () => ({ loadTimeMs: 1, device: 'mock' })),
      translate: vi.fn((text: string) => {
        inflight.push(text);
        const deferred = createDeferred<{
          sourceText: string;
          translatedText: string;
          inferenceTimeMs: number;
        }>();
        deferreds.set(text, deferred);
        return deferred.promise;
      }),
      dispose: vi.fn(),
    };
    const translator = new TranslationEngineTimelineTranslator({
      createEngine: () => engine,
    });

    const batch = translator.translateBatch(['First', 'Second', 'Third'], 'zh');
    await waitForCondition(() => inflight.length === 3);

    // All three are in flight before any of them has resolved: proves concurrency.
    expect(inflight).toEqual(['First', 'Second', 'Third']);

    for (const text of ['First', 'Second', 'Third']) {
      deferreds.get(text)!.resolve({
        sourceText: text,
        translatedText: `译文:${text}`,
        inferenceTimeMs: 1,
      });
    }

    await expect(batch).resolves.toEqual(['译文:First', '译文:Second', '译文:Third']);
  });

  // WHY: a single blank result from the engine must not abort the batch. Returning an
  // empty placeholder (rather than throwing) lets translateTimelineCueBatch drop just
  // that cue and keep the session alive.
  it('does not throw when the engine returns a blank translation for one cue', async () => {
    const engine = {
      init: vi.fn(async () => ({ loadTimeMs: 1, device: 'mock' })),
      translate: vi.fn(async (text: string) => ({
        sourceText: text,
        translatedText: text === 'Blank' ? '   ' : `译文:${text}`,
        inferenceTimeMs: 1,
      })),
      dispose: vi.fn(),
    };
    const translator = new TranslationEngineTimelineTranslator({
      createEngine: () => engine,
    });

    const result = await translator.translateBatch(['First', 'Blank'], 'zh');

    expect(result[0]).toBe('译文:First');
    expect(result[1].trim()).toBe('');
  });

  // WHY: latency fix must not let an unbounded fan-out hammer Bing into rate-limiting.
  // A large window should respect a concurrency ceiling rather than firing every cue at
  // once, while still being far more parallel than strict serial execution.
  it('caps how many translations run at once for a large window', async () => {
    let active = 0;
    let maxActive = 0;
    const engine = {
      init: vi.fn(async () => ({ loadTimeMs: 1, device: 'mock' })),
      translate: vi.fn(async (text: string) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        await Promise.resolve();
        active -= 1;
        return { sourceText: text, translatedText: `译文:${text}`, inferenceTimeMs: 1 };
      }),
      dispose: vi.fn(),
    };
    const translator = new TranslationEngineTimelineTranslator({
      createEngine: () => engine,
    });

    const texts = Array.from({ length: 12 }, (_unused, index) => `cue-${index}`);
    const result = await translator.translateBatch(texts, 'zh');

    expect(result).toHaveLength(12);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(5);
  });

  it('rejects pending engine initialization on dispose so restart cannot leave translation hanging', async () => {
    const initDeferred = createDeferred<{ loadTimeMs: number; device: string }>();
    const engine = {
      init: vi.fn(async () => initDeferred.promise),
      translate: vi.fn(),
      dispose: vi.fn(),
    };
    const translator = new TranslationEngineTimelineTranslator({
      createEngine: () => engine,
    });

    const batch = translator.translateBatch(['First'], 'zh');
    await Promise.resolve();

    translator.dispose();

    expect(engine.dispose).toHaveBeenCalledTimes(1);
    await expectRejectedWithoutHanging(batch);
  });

  it('rejects queued batches that have not started when disposed', async () => {
    const translateDeferred = createDeferred<{
      sourceText: string;
      translatedText: string;
      inferenceTimeMs: number;
    }>();
    const calls: string[] = [];
    const engine = {
      init: vi.fn(async () => {
        calls.push('init');
        return { loadTimeMs: 1, device: 'mock' };
      }),
      translate: vi.fn(async (text: string) => {
        calls.push(`translate:${text}`);
        return translateDeferred.promise;
      }),
      dispose: vi.fn(() => {
        calls.push('dispose');
      }),
    };
    const translator = new TranslationEngineTimelineTranslator({
      createEngine: () => engine,
    });

    const first = translator.translateBatch(['a'], 'zh');
    await waitForCondition(() => calls.includes('translate:a'));

    const second = translator.translateBatch(['b'], 'zh');
    translator.dispose();
    translateDeferred.resolve({
      sourceText: 'a',
      translatedText: 'A',
      inferenceTimeMs: 1,
    });

    await expect(first).rejects.toThrow(/translation disposed/i);
    await expect(second).rejects.toThrow(/translation disposed/i);
    expect(calls).toEqual(['init', 'translate:a', 'dispose']);
    expect(engine.init).toHaveBeenCalledTimes(1);
    expect(engine.translate).toHaveBeenCalledTimes(1);
  });
});
