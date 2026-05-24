import { describe, expect, it } from 'vitest';
import { summarizeAst2Latency } from './ast2LatencySummary';
import type { LogEntry } from './logStore';

describe('summarizeAst2Latency', () => {
  it('summarizes participant AST2 latency into the latest user-facing dubbing metrics', () => {
    const logs: LogEntry[] = [
      {
        timestamp: '10:00:01',
        message: 'server: TranslationSubtitleEnd',
        source: 'server',
        eventType: 'TranslationSubtitleEnd',
        clientId: 'participant',
        events: [
          { type: 'TranslationSubtitleEnd' as any, data: { latency: { sinceLastInputAudioMs: 820 } } },
        ],
      },
      {
        timestamp: '10:00:02',
        message: 'client: tts.decode.completed',
        source: 'client',
        eventType: 'tts.decode.completed',
        clientId: 'participant',
        events: [
          { type: 'tts.decode.completed' as any, data: { latency: { sinceLastInputAudioMs: 1850, decodeDurationMs: 24 } } },
        ],
      },
    ];

    expect(summarizeAst2Latency(logs, 'participant')).toEqual({
      hasData: true,
      latestDubReadyMs: 1850,
      latestTranslationReadyMs: 820,
      latestFirstTtsChunkMs: null,
      latestDecodeMs: 24,
      bottleneck: 'server_pipeline',
    });
  });

  it('detects local decoding as the bottleneck when decode time is large', () => {
    const logs: LogEntry[] = [
      {
        timestamp: '10:00:02',
        message: 'client: tts.decode.completed',
        source: 'client',
        eventType: 'tts.decode.completed',
        clientId: 'participant',
        events: [
          { type: 'tts.decode.completed' as any, data: { latency: { sinceLastInputAudioMs: 1200, decodeDurationMs: 760 } } },
        ],
      },
    ];

    expect(summarizeAst2Latency(logs, 'participant').bottleneck).toBe('local_decode');
  });

  it('uses streaming TTS decode events as the earliest user-facing dubbing readiness signal', () => {
    const logs: LogEntry[] = [
      {
        timestamp: '10:00:02',
        message: 'client: tts.streaming.decode.completed',
        source: 'client',
        eventType: 'tts.streaming.decode.completed',
        clientId: 'participant',
        events: [
          { type: 'tts.streaming.decode.completed' as any, data: { latency: { sinceLastInputAudioMs: 980, decodeDurationMs: 12 } } },
        ],
      },
      {
        timestamp: '10:00:04',
        message: 'client: tts.decode.completed',
        source: 'client',
        eventType: 'tts.decode.completed',
        clientId: 'participant',
        events: [
          { type: 'tts.decode.completed' as any, data: { latency: { sinceLastInputAudioMs: 2100, decodeDurationMs: 26 } } },
        ],
      },
    ];

    expect(summarizeAst2Latency(logs, 'participant').latestDubReadyMs).toBe(980);
  });

  it('returns no data when only the speaker client has latency logs', () => {
    const logs: LogEntry[] = [
      {
        timestamp: '10:00:02',
        message: 'client: tts.decode.completed',
        source: 'client',
        eventType: 'tts.decode.completed',
        clientId: 'speaker',
        events: [
          { type: 'tts.decode.completed' as any, data: { latency: { sinceLastInputAudioMs: 1200, decodeDurationMs: 20 } } },
        ],
      },
    ];

    expect(summarizeAst2Latency(logs, 'participant')).toEqual({
      hasData: false,
      latestDubReadyMs: null,
      latestTranslationReadyMs: null,
      latestFirstTtsChunkMs: null,
      latestDecodeMs: null,
      bottleneck: 'insufficient_data',
    });
  });
});
