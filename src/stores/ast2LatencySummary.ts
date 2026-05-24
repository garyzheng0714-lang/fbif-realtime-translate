import type { ClientId, LogEntry } from './logStore';

export type Ast2LatencyBottleneck =
  | 'insufficient_data'
  | 'server_pipeline'
  | 'local_decode';

export interface Ast2LatencySummary {
  hasData: boolean;
  latestDubReadyMs: number | null;
  latestTranslationReadyMs: number | null;
  latestFirstTtsChunkMs: number | null;
  latestDecodeMs: number | null;
  bottleneck: Ast2LatencyBottleneck;
}

const emptySummary: Ast2LatencySummary = {
  hasData: false,
  latestDubReadyMs: null,
  latestTranslationReadyMs: null,
  latestFirstTtsChunkMs: null,
  latestDecodeMs: null,
  bottleneck: 'insufficient_data',
};

function latestNumber(current: number | null, value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : current;
}

export function summarizeAst2Latency(
  logs: LogEntry[],
  clientId: ClientId = 'participant'
): Ast2LatencySummary {
  const summary: Ast2LatencySummary = { ...emptySummary };
  let hasStreamingDubReady = false;

  for (const log of logs) {
    if (log.clientId !== clientId || !log.events) continue;

    for (const event of log.events) {
      const latency = event.data?.latency;
      if (!latency || typeof latency !== 'object') continue;

      summary.hasData = true;

      if (event.type === 'TranslationSubtitleResponse' || event.type === 'TranslationSubtitleEnd') {
        summary.latestTranslationReadyMs = latestNumber(summary.latestTranslationReadyMs, latency.sinceLastInputAudioMs);
      } else if (event.type === 'TTSResponse') {
        summary.latestFirstTtsChunkMs = latestNumber(summary.latestFirstTtsChunkMs, latency.sinceTtsSentenceStartMs);
      } else if (event.type === 'tts.streaming.decode.completed') {
        hasStreamingDubReady = true;
        summary.latestDubReadyMs = latestNumber(summary.latestDubReadyMs, latency.sinceLastInputAudioMs);
        summary.latestDecodeMs = latestNumber(summary.latestDecodeMs, latency.decodeDurationMs);
      } else if (event.type === 'tts.decode.completed' && !hasStreamingDubReady) {
        summary.latestDubReadyMs = latestNumber(summary.latestDubReadyMs, latency.sinceLastInputAudioMs);
        summary.latestDecodeMs = latestNumber(summary.latestDecodeMs, latency.decodeDurationMs);
      }
    }
  }

  if (!summary.hasData) return summary;
  summary.bottleneck = summary.latestDecodeMs !== null && summary.latestDecodeMs >= 500
    ? 'local_decode'
    : 'server_pipeline';
  return summary;
}
