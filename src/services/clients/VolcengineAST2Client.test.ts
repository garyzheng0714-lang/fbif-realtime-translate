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
