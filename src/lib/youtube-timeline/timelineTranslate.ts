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

export function mergeShortCues(cues: TimelineCue[], minDurationMs = 1800): TimelineCue[] {
  const merged: TimelineCue[] = [];
  let index = 0;

  while (index < cues.length) {
    const group = [cues[index]];
    let groupEndMs = cues[index].endMs;
    let nextIndex = index + 1;

    while (
      groupEndMs - group[0].startMs < minDurationMs &&
      nextIndex < cues.length &&
      isAdjacent(group[group.length - 1], cues[nextIndex]) &&
      cueDuration(cues[nextIndex]) < minDurationMs &&
      cues[nextIndex].endMs - group[0].startMs <= minDurationMs
    ) {
      group.push(cues[nextIndex]);
      groupEndMs = cues[nextIndex].endMs;
      nextIndex += 1;
    }

    merged.push(mergeCueGroup(group));
    index += group.length;
  }

  return merged;
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

  return cues.map((cue, index) => ({
    ...cue,
    translatedText: validateTranslatedText(translatedTexts[index], index),
  }));
}

function validateTranslatedText(text: string, index: number): string {
  if (text.trim() === '') {
    throw new Error(`翻译结果为空：第 ${index + 1} 条字幕没有可朗读的中文译文`);
  }
  return text;
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
  const merged = mergeShortCues(cues);
  return translateTimelineCueBatch(merged, translator, targetLanguage);
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
    this.modelId = options.modelId;
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
    const translatedTexts: string[] = [];

    try {
      for (const text of texts) {
        const result = await this.withDisposeGuard(
          engine.translate(text, prompt, true),
          generation,
        );
        translatedTexts.push(validateTranslatedText(result.translatedText, translatedTexts.length));
      }
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
