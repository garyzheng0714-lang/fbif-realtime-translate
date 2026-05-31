import { TranslationEngine, type TranslationResult } from '../local-inference/engine/TranslationEngine';
import { buildDefaultLocalPrompt } from '../local-inference/prompts';
import type { TimelineCue } from './types';

export interface TimelineTranslator {
  translateBatch(texts: string[], targetLanguage: string): Promise<string[]>;
}

interface TranslationEngineLike {
  init(sourceLang: string, targetLang: string, modelId?: string): Promise<unknown>;
  translate(text: string, systemPrompt: string, wrapTranscript: boolean): Promise<Pick<TranslationResult, 'translatedText'>>;
  dispose(): void;
}

interface TranslationEngineTimelineTranslatorOptions {
  sourceLanguage?: string;
  modelId?: string;
  createEngine?: () => TranslationEngineLike;
}

const ADJACENT_GAP_TOLERANCE_MS = 250;
const DEFAULT_TIMELINE_TRANSLATION_MODEL_ID = 'bing-translator';
// Bing is a request/response worker that pairs replies by id, so several translate
// calls can be in flight at once. Cap the fan-out so a dense caption window does not
// hammer Bing into rate-limiting while still translating far faster than serial.
const MAX_CONCURRENT_TRANSLATIONS = 5;

function normalizeLanguage(language: string): string {
  return language.trim().toLowerCase().split('-')[0] || 'en';
}

function cueDuration(cue: TimelineCue): number {
  return cue.endMs - cue.startMs;
}

function mergeCueGroup(cues: TimelineCue[]): TimelineCue {
  if (cues.length === 1) return cues[0];
  return {
    id: cues.map((cue) => cue.id).join('+'),
    startMs: cues[0].startMs,
    endMs: cues[cues.length - 1].endMs,
    sourceText: cues.map((cue) => cue.sourceText).join(' ').replace(/\s+/g, ' ').trim(),
  };
}

function isAdjacent(previous: TimelineCue, next: TimelineCue): boolean {
  return next.startMs - previous.endMs <= ADJACENT_GAP_TOLERANCE_MS;
}

interface MergedCueGroup {
  merged: TimelineCue;
  sources: TimelineCue[];
}

function mergeShortCueGroups(cues: TimelineCue[], minDurationMs: number): MergedCueGroup[] {
  // Sort defensively: adjacency is decided from neighbouring start/end times, so an
  // unsorted input would otherwise group time-disjoint cues. parseYouTubeJson3 already
  // sorts, but this helper must not depend on its callers staying ordered.
  const ordered = [...cues].sort((a, b) => a.startMs - b.startMs);
  const groups: MergedCueGroup[] = [];
  let index = 0;

  while (index < ordered.length) {
    const group = [ordered[index]];
    let groupEndMs = ordered[index].endMs;
    let nextIndex = index + 1;

    while (
      groupEndMs - group[0].startMs < minDurationMs &&
      nextIndex < ordered.length &&
      isAdjacent(group[group.length - 1], ordered[nextIndex]) &&
      cueDuration(ordered[nextIndex]) < minDurationMs &&
      ordered[nextIndex].endMs - group[0].startMs <= minDurationMs
    ) {
      group.push(ordered[nextIndex]);
      groupEndMs = ordered[nextIndex].endMs;
      nextIndex += 1;
    }

    groups.push({ merged: mergeCueGroup(group), sources: group });
    index += group.length;
  }

  return groups;
}

export function mergeShortCues(cues: TimelineCue[], minDurationMs = 1800): TimelineCue[] {
  return mergeShortCueGroups(cues, minDurationMs).map((group) => group.merged);
}

export async function translateTimelineCueBatch(
  cues: TimelineCue[],
  translator: TimelineTranslator,
  targetLanguage = 'zh',
): Promise<TimelineCue[]> {
  const texts = cues.map((cue) => cue.sourceText);
  const translatedTexts = await translator.translateBatch(texts, targetLanguage);

  if (translatedTexts.length !== texts.length) {
    throw new Error(`翻译结果数量不匹配：请求 ${texts.length} 条，返回 ${translatedTexts.length} 条`);
  }

  // Degrade per-cue on a blank result instead of throwing: a single empty Bing reply
  // is normal jitter, and throwing would bubble through translateCueWindow ->
  // failTimeline and stop the whole session. Leaving translatedText untouched (undefined)
  // makes getTimelineCuesToTranslate re-select the cue on a later window for a retry.
  // A jittery worker reply can also be `undefined` (missing translatedText field), so
  // the array is effectively (string | undefined)[]; treat undefined exactly like a
  // blank string rather than calling .trim() on it and throwing a TypeError.
  return cues.map((cue, index) => {
    const translatedText = translatedTexts[index];
    if (translatedText === undefined || translatedText.trim() === '') {
      return cue;
    }
    return { ...cue, translatedText };
  });
}

export function getTimelineCuesToTranslate(
  cues: TimelineCue[],
  translatingCueIds: ReadonlySet<string>,
  queuedCueIds: ReadonlySet<string>,
): TimelineCue[] {
  return cues.filter((cue) => (
    cue.translatedText === undefined &&
    !translatingCueIds.has(cue.id) &&
    !queuedCueIds.has(cue.id)
  ));
}

export async function translateTimelineCues(
  cues: TimelineCue[],
  translator: TimelineTranslator,
  targetLanguage = 'zh',
): Promise<TimelineCue[]> {
  const groups = mergeShortCueGroups(cues, 1800);
  const translatedMerged = await translateTimelineCueBatch(
    groups.map((group) => group.merged),
    translator,
    targetLanguage,
  );

  // Fan the merged translation back onto each original cue so the result keeps the
  // ORIGINAL cue ids. MainPanel keys translated text by original id, so returning the
  // synthetic 'a+b' merged id would lose the translation for every source cue.
  return groups.flatMap((group, index) => {
    const { translatedText } = translatedMerged[index];
    return group.sources.map((cue) => (
      translatedText === undefined ? cue : { ...cue, translatedText }
    ));
  });
}

export class TranslationEngineTimelineTranslator implements TimelineTranslator {
  private engine: TranslationEngineLike | null = null;
  private initializedTargetLanguage: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;
  private disposeRejectors = new Set<(error: Error) => void>();
  private readonly sourceLanguage: string;
  private readonly modelId?: string;
  private readonly createEngine: () => TranslationEngineLike;

  constructor(options: TranslationEngineTimelineTranslatorOptions = {}) {
    this.sourceLanguage = normalizeLanguage(options.sourceLanguage ?? 'en');
    this.modelId = options.modelId ?? DEFAULT_TIMELINE_TRANSLATION_MODEL_ID;
    this.createEngine = options.createEngine ?? (() => new TranslationEngine());
  }

  async translateBatch(texts: string[], targetLanguage: string): Promise<string[]> {
    const generation = this.generation;
    const run = () => this.translateBatchNow(texts, targetLanguage, generation);
    const result = this.queue.then(run, run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async translateBatchNow(texts: string[], targetLanguage: string, generation: number): Promise<string[]> {
    if (generation !== this.generation) {
      throw this.createDisposedError();
    }
    if (texts.length === 0) return [];

    const normalizedTargetLanguage = normalizeLanguage(targetLanguage);
    const engine = await this.ensureEngine(normalizedTargetLanguage, generation);
    const prompt = buildDefaultLocalPrompt(this.sourceLanguage, normalizedTargetLanguage);
    const translatedTexts = new Array<string>(texts.length);

    try {
      // Translate concurrently with a bounded worker pool. A serial for-await made a
      // dense window cost N x RTT and pushed recent captions behind older ones; the
      // pool keeps up to MAX_CONCURRENT_TRANSLATIONS round-trips in flight while
      // preserving input order in the result array. Blank replies are kept as-is here
      // and dropped per-cue by translateTimelineCueBatch rather than failing the batch.
      let nextIndex = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= texts.length) return;
          const result = await this.withDisposeGuard(
            engine.translate(texts[index], prompt, true),
            generation,
          );
          translatedTexts[index] = result.translatedText;
        }
      };

      const poolSize = Math.min(MAX_CONCURRENT_TRANSLATIONS, texts.length);
      await Promise.all(Array.from({ length: poolSize }, () => worker()));
    } catch (error) {
      if (this.isDisposedError(error)) throw error;
      throw this.createUnavailableError(error);
    }

    return translatedTexts;
  }

  dispose(): void {
    this.generation += 1;
    const disposeError = this.createDisposedError();
    for (const reject of this.disposeRejectors) {
      reject(disposeError);
    }
    this.disposeRejectors.clear();
    this.closeEngine();
    this.queue = Promise.resolve();
  }

  private async ensureEngine(targetLanguage: string, generation: number): Promise<TranslationEngineLike> {
    if (generation !== this.generation) {
      throw this.createDisposedError();
    }

    if (this.engine && this.initializedTargetLanguage === targetLanguage) {
      return this.engine;
    }

    this.closeEngine();
    const engine = this.createEngine();
    this.engine = engine;

    try {
      await this.withDisposeGuard(
        engine.init(this.sourceLanguage, targetLanguage, this.modelId),
        generation,
      );
      this.initializedTargetLanguage = targetLanguage;
      return engine;
    } catch (error) {
      this.closeEngine();
      if (this.isDisposedError(error)) throw error;
      throw this.createUnavailableError(error);
    }
  }

  private closeEngine(): void {
    this.engine?.dispose();
    this.engine = null;
    this.initializedTargetLanguage = null;
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

  private createDisposedError(): Error {
    return new Error('Timeline translation disposed');
  }

  private isDisposedError(error: unknown): boolean {
    return error instanceof Error && error.message === 'Timeline translation disposed';
  }

  private createUnavailableError(error: unknown): Error {
    const detail = error instanceof Error ? error.message : String(error);
    return new Error(`视频同步模式需要先配置可用的文本翻译服务：${detail}`);
  }
}
