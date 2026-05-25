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

  it('maps batch translations back onto merged cues', async () => {
    const translator = {
      translateBatch: vi.fn(async (texts: string[]) => texts.map((text) => `中文:${text}`)),
    };

    const translated = await translateTimelineCues(cues, translator, 'zh');

    expect(translator.translateBatch).toHaveBeenCalledWith(['Hello world', 'Long enough'], 'zh');
    expect(translated.map((cue) => cue.translatedText)).toEqual([
      '中文:Hello world',
      '中文:Long enough',
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

  it('fails loud when the translator returns an empty translation', async () => {
    const translator = {
      translateBatch: vi.fn(async () => ['   ']),
    };

    await expect(translateTimelineCueBatch([cues[0]], translator, 'zh')).rejects.toThrow(
      /翻译结果为空/,
    );
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
