import { describe, it, expect, vi } from 'vitest';

// Mock i18n (the client module imports it transitively via some paths).
vi.mock('../../locales', () => ({
  default: { t: (key: string) => key }
}));

// Dynamic import after mocks
const {
  buildCorpusFromConfig,
  buildVolcengineAST2LatencySnapshot,
  buildVolcengineAST2AuthHeaders,
} = await import('./VolcengineAST2Client');

const {
  decodedOggOpusToInt16,
  VolcengineAST2StreamingTTSDecoder,
} = await import('./VolcengineAST2StreamingTTSDecoder');

const baseConfig = {
  provider: 'volcengine_ast2' as const,
  model: 'ast-v2-s2s',
  sourceLanguage: 'zh',
  targetLanguage: 'en',
  turnDetectionMode: 'Auto' as const,
};

describe('buildCorpusFromConfig', () => {
  it('returns undefined when all three IDs are absent', () => {
    expect(buildCorpusFromConfig({ ...baseConfig })).toBeUndefined();
  });

  it('returns undefined when all three IDs are empty strings', () => {
    expect(buildCorpusFromConfig({
      ...baseConfig,
      hotWordTableId: '',
      replacementTableId: '',
      glossaryTableId: '',
    })).toBeUndefined();
  });

  it('returns undefined when all three IDs are whitespace only', () => {
    expect(buildCorpusFromConfig({
      ...baseConfig,
      hotWordTableId: '   ',
      replacementTableId: '\t',
      glossaryTableId: '\n',
    })).toBeUndefined();
  });

  it('emits only the set fields and uses correct proto names', () => {
    expect(buildCorpusFromConfig({
      ...baseConfig,
      hotWordTableId: 'hot-1',
      replacementTableId: '',
      glossaryTableId: 'gloss-3',
    })).toEqual({
      boostingTableId: 'hot-1',
      glossaryTableId: 'gloss-3',
    });
  });

  it('emits all three when all are set', () => {
    expect(buildCorpusFromConfig({
      ...baseConfig,
      hotWordTableId: 'hot-1',
      replacementTableId: 'rep-2',
      glossaryTableId: 'gloss-3',
    })).toEqual({
      boostingTableId: 'hot-1',
      regexCorrectTableId: 'rep-2',
      glossaryTableId: 'gloss-3',
    });
  });

  it('trims whitespace from IDs', () => {
    expect(buildCorpusFromConfig({
      ...baseConfig,
      hotWordTableId: '  hot-1  ',
      replacementTableId: '\trep-2\t',
      glossaryTableId: ' gloss-3 ',
    })).toEqual({
      boostingTableId: 'hot-1',
      regexCorrectTableId: 'rep-2',
      glossaryTableId: 'gloss-3',
    });
  });
});

describe('buildVolcengineAST2AuthHeaders', () => {
  it('uses the new single API key header when no legacy access token is configured', () => {
    expect(buildVolcengineAST2AuthHeaders(
      '  api-key-1  ',
      '',
      'volc.service_type.10053',
      'connect-1'
    )).toEqual({
      'X-Api-Key': 'api-key-1',
      'X-Api-Resource-Id': 'volc.service_type.10053',
      'X-Api-Connect-Id': 'connect-1',
    });
  });

  it('keeps the legacy APP ID and access token headers when a legacy token is configured', () => {
    expect(buildVolcengineAST2AuthHeaders(
      ' app-id-1 ',
      ' access-token-1 ',
      'volc.service_type.10053',
      'connect-2'
    )).toEqual({
      'X-Api-App-Key': 'app-id-1',
      'X-Api-Access-Key': 'access-token-1',
      'X-Api-Resource-Id': 'volc.service_type.10053',
      'X-Api-Connect-Id': 'connect-2',
    });
  });
});

describe('buildVolcengineAST2LatencySnapshot', () => {
  it('summarizes client-side timing so delayed dubbing can be attributed by stage', () => {
    expect(buildVolcengineAST2LatencySnapshot(
      {
        sessionStartedAt: 1000,
        lastInputAudioSentAt: 2500,
        ttsSentenceStartedAt: 3200,
        firstTtsChunkReceivedAt: 3600,
      },
      4000,
      { startTime: 1200, endTime: 2800 }
    )).toEqual({
      receivedAt: 4000,
      sinceSessionStartMs: 3000,
      sinceLastInputAudioMs: 1500,
      sinceTtsSentenceStartMs: 800,
      sinceFirstTtsChunkMs: 400,
      serverStartTime: 1200,
      serverEndTime: 2800,
    });
  });

  it('omits unavailable fields instead of inventing latency data', () => {
    expect(buildVolcengineAST2LatencySnapshot({}, 4000, {})).toEqual({
      receivedAt: 4000,
    });
  });
});

describe('decodedOggOpusToInt16', () => {
  it('converts decoded PCM samples into the Int16 format used by the audio pipeline', () => {
    expect(Array.from(decodedOggOpusToInt16({
      channelData: [new Float32Array([-1.5, -1, -0.5, 0, 0.5, 1, 1.5])],
      samplesDecoded: 7,
    }))).toEqual([-32768, -32768, -16384, 0, 16383, 32767, 32767]);
  });

  it('returns an empty audio delta when the streaming decoder has not produced PCM yet', () => {
    expect(decodedOggOpusToInt16({ channelData: [], samplesDecoded: 0 })).toHaveLength(0);
  });
});

describe('VolcengineAST2StreamingTTSDecoder', () => {
  it('emits playable audio immediately when a streaming Ogg Opus chunk decodes before sentence end', async () => {
    const emitted: Int16Array[] = [];
    const decoder = new VolcengineAST2StreamingTTSDecoder(async () => ({
      ready: Promise.resolve(),
      decode: async () => ({
        channelData: [new Float32Array([0, 0.5])],
        samplesDecoded: 2,
      }),
      flush: async () => ({ channelData: [], samplesDecoded: 0 }),
      reset: async () => {},
      free: () => {},
    }), (audio) => emitted.push(audio));

    await decoder.startSentence();
    const chunkDecoded = await decoder.decodeChunk(new Uint8Array([1, 2, 3]));

    expect(chunkDecoded).toBe(true);
    expect(emitted.map((audio) => Array.from(audio))).toEqual([[0, 16383]]);
    expect(decoder.hasEmittedAudio()).toBe(true);
  });

  it('disables streaming for the sentence when decode fails so the caller can use whole-sentence fallback', async () => {
    const emitted: Int16Array[] = [];
    const decoder = new VolcengineAST2StreamingTTSDecoder(async () => ({
      ready: Promise.resolve(),
      decode: async () => {
        throw new Error('bad ogg page');
      },
      flush: async () => ({ channelData: [], samplesDecoded: 0 }),
      reset: async () => {},
      free: () => {},
    }), (audio) => emitted.push(audio));

    await decoder.startSentence();
    const chunkDecoded = await decoder.decodeChunk(new Uint8Array([1, 2, 3]));

    expect(chunkDecoded).toBe(false);
    expect(emitted).toEqual([]);
    expect(decoder.isAvailable()).toBe(false);
    expect(decoder.hasEmittedAudio()).toBe(false);
  });
});
