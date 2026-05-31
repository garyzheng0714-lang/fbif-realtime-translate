import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// Mock i18n (the client module imports it transitively via some paths).
vi.mock('../../locales', () => ({
  default: { t: (key: string) => key }
}));

// Dynamic import after mocks
const {
  buildCorpusFromConfig,
  buildVolcengineAST2LatencySnapshot,
  buildVolcengineAST2AuthHeaders,
  buildTaskRequestMeta,
  decideTTSFinishAction,
  isHighFrequencyAST2Event,
  VolcengineAST2Client,
} = await import('./VolcengineAST2Client');

const {
  decodedOggOpusToInt16,
  VolcengineAST2StreamingTTSDecoder,
} = await import('./VolcengineAST2StreamingTTSDecoder');

// @ts-ignore - generated proto file
const { data: protoData } = await import('./volcengine-ast2/ast2-proto.js');
const TranslateRequest = protoData.speech.ast.TranslateRequest;
const TranslateResponse = protoData.speech.ast.TranslateResponse;
const EventType = protoData.speech.event.Type;

/**
 * Controllable WebSocket stand-in so connect()/reconnect flows can be driven
 * deterministically without a real server. Each instance registers itself in
 * `mockSockets` so a test can grab the latest one and pump lifecycle events.
 */
const READY = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 } as const;
let mockSockets: MockWebSocket[] = [];

class MockWebSocket {
  static readonly CONNECTING = READY.CONNECTING;
  static readonly OPEN = READY.OPEN;
  static readonly CLOSING = READY.CLOSING;
  static readonly CLOSED = READY.CLOSED;

  url: string;
  binaryType = 'arraybuffer';
  readyState: number = READY.CONNECTING;
  sent: Uint8Array[] = [];
  closed = false;
  closeCode?: number;

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onclose: ((event: any) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    mockSockets.push(this);
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closed = true;
    this.closeCode = code;
    this.readyState = READY.CLOSED;
  }

  // ─── Test drivers ───
  open(): void {
    this.readyState = READY.OPEN;
    this.onopen?.();
  }

  emitServerEvent(event: number, extra: Record<string, unknown> = {}): void {
    const buf = TranslateResponse.encode({
      event,
      responseMeta: { StatusCode: 20000000, ...((extra as any).responseMeta || {}) },
      ...extra,
    }).finish();
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    this.onmessage?.({ data: ab });
  }

  serverClose(code = 1006, reason = 'abnormal'): void {
    this.readyState = READY.CLOSED;
    this.onclose?.({ code, reason });
  }

  serverError(): void {
    this.onerror?.({ target: this });
  }

  /** Decode the event types this socket has sent, for assertions. */
  sentEventTypes(): number[] {
    return this.sent.map((bytes) => TranslateRequest.decode(bytes).event as number);
  }
}

function lastSocket(): MockWebSocket {
  return mockSockets[mockSockets.length - 1];
}

const ast2Config = {
  provider: 'volcengine_ast2' as const,
  model: 'ast-v2-s2s',
  sourceLanguage: 'zh',
  targetLanguage: 'en',
  turnDetectionMode: 'Auto' as const,
};

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

describe('VolcengineAST2Client connect lifecycle', () => {
  let originalWebSocket: any;

  beforeEach(() => {
    mockSockets = [];
    originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = MockWebSocket as any;
  });

  afterEach(() => {
    (globalThis as any).WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  it('rejects connect immediately when the server closes before SessionStarted instead of stalling for 30s', async () => {
    // WHY: auth failures / rate limits / capacity rejections in the browser
    // surface as onclose (not onerror) AFTER the upgrade succeeds but BEFORE
    // SessionStarted. If onclose does not reject the pending connect promise,
    // the user stares at an "initializing" UI for the full 30s connection
    // timeout before seeing the failure. The promise must settle the instant
    // the socket closes pre-session.
    const client = new VolcengineAST2Client('app-id', '', 'volc.service_type.10053');
    const connectPromise = client.connect(ast2Config);

    // Let the WebSocket get created and wired up.
    await Promise.resolve();
    const ws = lastSocket();
    ws.open(); // upgrade succeeds → StartSession is sent
    await Promise.resolve();

    // Server rejects before ever sending SessionStarted.
    ws.serverClose(4001, 'auth failed');

    await expect(connectPromise).rejects.toThrow(/closed before session started/i);
  });

  it('resolves connect once SessionStarted arrives', async () => {
    // WHY: the happy path must still settle the promise so the session can run.
    const client = new VolcengineAST2Client('app-id', '', 'volc.service_type.10053');
    const connectPromise = client.connect(ast2Config);

    await Promise.resolve();
    const ws = lastSocket();
    ws.open();
    await Promise.resolve();
    ws.emitServerEvent(EventType.SessionStarted, { responseMeta: { SessionID: undefined, StatusCode: 20000000 } });

    await expect(connectPromise).resolves.toBeUndefined();
    expect(client.isConnected()).toBe(true);
  });
});

/**
 * Helper: bring a client to a live, post-SessionStarted state.
 */
async function connectAndStart(client: any): Promise<MockWebSocket> {
  const connectPromise = client.connect(ast2Config);
  await Promise.resolve();
  const ws = lastSocket();
  ws.open();
  await Promise.resolve();
  ws.emitServerEvent(EventType.SessionStarted, { responseMeta: { StatusCode: 20000000 } });
  await connectPromise;
  return ws;
}

describe('VolcengineAST2Client reconnection', () => {
  let originalWebSocket: any;

  beforeEach(() => {
    mockSockets = [];
    originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = MockWebSocket as any;
  });

  afterEach(() => {
    (globalThis as any).WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  it('auto-reconnects after an unexpected server close instead of tearing the session down', async () => {
    // WHY: Volcengine AST2 hard-limits a single connection (2h cap, 30min
    // silence, 45000081 push timeout). For long videos/live streams these are
    // hit routinely. Without reconnection the user sees "translation just
    // stopped, no more subtitles or dubbing". The client must rebuild the
    // socket + StartSession transparently and NOT call onClose (which would
    // make MainPanel tear the whole session down).
    vi.useFakeTimers();
    const events: string[] = [];
    const client = new VolcengineAST2Client('app-id', '', 'volc.service_type.10053');
    client.setEventHandlers({
      onReconnecting: () => events.push('reconnecting'),
      onReconnected: () => events.push('reconnected'),
      onClose: () => events.push('close'),
    });

    const ws1 = await connectAndStart(client);
    expect(client.isConnected()).toBe(true);

    // Server abnormally closes the live session.
    ws1.serverClose(1006, 'abnormal');

    // A reconnect must be scheduled; onClose must NOT fire (session preserved).
    expect(events).toContain('reconnecting');
    expect(events).not.toContain('close');

    // Advance past the first backoff delay so the reconnect socket is created.
    await vi.advanceTimersByTimeAsync(5000);
    const ws2 = lastSocket();
    expect(ws2).not.toBe(ws1);

    // New socket completes its handshake.
    ws2.open();
    await Promise.resolve();
    // StartSession must be re-sent on the new socket.
    expect(ws2.sentEventTypes()).toContain(EventType.StartSession as number);
    ws2.emitServerEvent(EventType.SessionStarted, { responseMeta: { StatusCode: 20000000 } });
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toContain('reconnected');
    expect(client.isConnected()).toBe(true);
  });

  it('does not reconnect when the user initiated the disconnect', async () => {
    // WHY: a user pressing Stop must end the session for good. Reconnecting
    // after an intentional disconnect would resurrect a session the user just
    // killed and keep streaming audio.
    vi.useFakeTimers();
    const events: string[] = [];
    const client = new VolcengineAST2Client('app-id', '', 'volc.service_type.10053');
    client.setEventHandlers({
      onReconnecting: () => events.push('reconnecting'),
      onClose: () => events.push('close'),
    });

    const ws1 = await connectAndStart(client);
    await client.disconnect();
    // disconnect() closes the socket; simulate the socket's onclose firing.
    ws1.serverClose(1000, 'normal');

    await vi.advanceTimersByTimeAsync(60000);
    expect(events).not.toContain('reconnecting');
    expect(mockSockets.length).toBe(1); // no new socket was ever created
  });

  it('proactively pre-reconnects before the 2h hard cap to avoid a downlink gap', async () => {
    // WHY: Volcengine force-closes any connection at 2h. Waiting for that hard
    // close means a visible gap with no subtitles/audio. The client should open
    // a fresh connection slightly before the cap and switch to it, so playback
    // never stalls on the hard limit.
    vi.useFakeTimers();
    const client = new VolcengineAST2Client('app-id', '', 'volc.service_type.10053');
    client.setEventHandlers({});

    await connectAndStart(client);
    const socketsAfterConnect = mockSockets.length;

    // Advance to just past the pre-reconnect threshold (under 2h).
    await vi.advanceTimersByTimeAsync(110 * 60 * 1000);

    expect(mockSockets.length).toBeGreaterThan(socketsAfterConnect);
  });
});

describe('VolcengineAST2Client keepalive', () => {
  let originalWebSocket: any;

  beforeEach(() => {
    mockSockets = [];
    originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = MockWebSocket as any;
  });

  afterEach(() => {
    (globalThis as any).WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  // A TaskRequest whose audio payload is all zeros is a keepalive silence frame.
  const isSilenceFrame = (bytes: Uint8Array): boolean => {
    const req = TranslateRequest.decode(bytes);
    if (req.event !== EventType.TaskRequest) return false;
    const audio = req.sourceAudio?.binaryData as Uint8Array | null | undefined;
    if (!audio || audio.length === 0) return false;
    return audio.every((b: number) => b === 0);
  };

  it('does not inject silence frames between real audio frames arriving at the real frame cadence', async () => {
    // WHY: real tab audio frames arrive roughly every ~170ms. The old 60ms
    // silence threshold fired between every pair of real frames, splicing
    // "speech → silence → speech" into the stream and corrupting the server's
    // VAD sentence boundaries — the hidden cause of fragmented subtitles and
    // stuttering dubbing. While real audio is actively flowing, keepalive must
    // stay quiet; it is only a fallback for genuine silence.
    vi.useFakeTimers();
    const client = new VolcengineAST2Client('app-id', '', 'volc.service_type.10053');
    client.setEventHandlers({});

    const ws = await connectAndStart(client);
    const sentBefore = ws.sent.length;

    // 24kHz, 4096 samples ≈ 170ms — non-silent (ramp) so it is clearly a real frame.
    const realFrame = new Int16Array(4096);
    for (let i = 0; i < realFrame.length; i++) realFrame[i] = (i % 1000) + 1;

    // Stream real frames at ~170ms cadence for ~2s.
    for (let t = 0; t < 12; t++) {
      client.appendInputAudio(realFrame);
      await vi.advanceTimersByTimeAsync(170);
    }

    const silenceFrames = ws.sent.slice(sentBefore).filter(isSilenceFrame);
    expect(silenceFrames.length).toBe(0);
  });

  it('still injects silence frames when real audio genuinely stops, to keep the session alive', async () => {
    // WHY: when the mic is muted / video paused, no real frames flow. The
    // server times out a silent connection, so the keepalive fallback MUST
    // resume sending silence once the gap exceeds the (now higher) threshold.
    vi.useFakeTimers();
    const client = new VolcengineAST2Client('app-id', '', 'volc.service_type.10053');
    client.setEventHandlers({});

    const ws = await connectAndStart(client);
    const sentBefore = ws.sent.length;

    // No real audio at all for 1s — well past any real-frame cadence.
    await vi.advanceTimersByTimeAsync(1000);

    const silenceFrames = ws.sent.slice(sentBefore).filter(isSilenceFrame);
    expect(silenceFrames.length).toBeGreaterThan(0);
  });

  it('tags keepalive silence frames with the same Endpoint/ResourceID metadata as StartSession', async () => {
    // WHY (finding 12): StartSession carries Endpoint + ResourceID but the
    // keepalive (and real) audio frames historically omitted them. If the
    // server tightens requestMeta validation, those frames get silently
    // dropped — the connection looks alive but no audio is processed. Every
    // TaskRequest must carry the same identifying metadata.
    vi.useFakeTimers();
    const client = new VolcengineAST2Client('app-id', '', 'volc.service_type.10053');
    client.setEventHandlers({});

    const ws = await connectAndStart(client);
    const sentBefore = ws.sent.length;

    await vi.advanceTimersByTimeAsync(1000);

    const silence = ws.sent.slice(sentBefore).find(isSilenceFrame);
    expect(silence).toBeDefined();
    const meta = TranslateRequest.decode(silence!).requestMeta!;
    expect(meta.Endpoint).toBe('volc.service_type.10053');
    expect(meta.ResourceID).toBe('volc.service_type.10053');
  });
});

describe('buildTaskRequestMeta', () => {
  it('mirrors StartSession metadata so audio frames are never dropped by stricter server validation', () => {
    expect(buildTaskRequestMeta({
      resourceId: 'volc.service_type.10053',
      connectionId: 'conn-1',
      sessionId: 'sess-1',
      sequence: 7,
    })).toEqual({
      Endpoint: 'volc.service_type.10053',
      ResourceID: 'volc.service_type.10053',
      ConnectionID: 'conn-1',
      SessionID: 'sess-1',
      Sequence: 7,
    });
  });

  it('includes the legacy AppKey only when one is supplied', () => {
    expect(buildTaskRequestMeta({
      resourceId: 'volc.service_type.10053',
      connectionId: 'conn-1',
      sessionId: 'sess-1',
      sequence: 0,
      appKey: 'legacy-app',
    }).AppKey).toBe('legacy-app');
  });
});

describe('isHighFrequencyAST2Event', () => {
  const types = {
    TTSResponse: EventType.TTSResponse,
    SourceSubtitleResponse: EventType.SourceSubtitleResponse,
    TranslationSubtitleResponse: EventType.TranslationSubtitleResponse,
  };

  it('classifies TTS audio chunks and subtitle deltas as high-frequency', () => {
    // WHY: these fire many times per sentence; tagging them lets the client skip
    // the per-message latency snapshot allocation that drives GC pressure.
    expect(isHighFrequencyAST2Event(EventType.TTSResponse, types)).toBe(true);
    expect(isHighFrequencyAST2Event(EventType.SourceSubtitleResponse, types)).toBe(true);
    expect(isHighFrequencyAST2Event(EventType.TranslationSubtitleResponse, types)).toBe(true);
  });

  it('keeps low-frequency lifecycle events out of the high-frequency bucket', () => {
    // WHY: SessionStarted / sentence start / sentence end are rare and worth the
    // full diagnostic snapshot.
    expect(isHighFrequencyAST2Event(EventType.SessionStarted, types)).toBe(false);
    expect(isHighFrequencyAST2Event(EventType.TTSSentenceStart, types)).toBe(false);
    expect(isHighFrequencyAST2Event(EventType.TTSSentenceEnd, types)).toBe(false);
  });
});

describe('VolcengineAST2Client diagnostic snapshot sampling', () => {
  let originalWebSocket: any;

  beforeEach(() => {
    mockSockets = [];
    originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = MockWebSocket as any;
  });

  afterEach(() => {
    (globalThis as any).WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  it('omits the latency snapshot on high-frequency TTS frames but keeps it on lifecycle events', async () => {
    // WHY (finding 8/9): a full latency snapshot was built and dispatched for
    // EVERY downlink message, including the dozens-to-hundreds of TTS audio
    // chunks per sentence — steady GC pressure on long sessions. High-frequency
    // frames must skip the snapshot while diagnosable lifecycle events keep it.
    const realtimeEvents: Array<{ event: { type: string; data: any } }> = [];
    const client = new VolcengineAST2Client('app-id', '', 'volc.service_type.10053');
    client.setEventHandlers({ onRealtimeEvent: (e: any) => realtimeEvents.push(e) });

    const ws = await connectAndStart(client);

    ws.emitServerEvent(EventType.TTSResponse, { data: new Uint8Array([1, 2, 3]) });
    await Promise.resolve();

    const ttsEvent = realtimeEvents.find((e) => e.event.data?.event === EventType.TTSResponse);
    const sessionStartedEvent = realtimeEvents.find((e) => e.event.data?.event === EventType.SessionStarted);

    expect(ttsEvent).toBeDefined();
    expect(ttsEvent!.event.data.latency).toBeUndefined();

    expect(sessionStartedEvent).toBeDefined();
    expect(sessionStartedEvent!.event.data.latency).toBeDefined();
  });
});

describe('decideTTSFinishAction', () => {
  it('skips finalizing a sentence that was already finalized so TTSEnded cannot double-play it', () => {
    // WHY: both TTSSentenceEnd and TTSEnded can fire for one sentence. The
    // second must be a no-op, or the sentence audio plays twice.
    expect(decideTTSFinishAction({
      alreadyFinalized: true,
      streamingAvailable: true,
      hasEmittedAudio: true,
    })).toBe('skip');
  });

  it('flushes the streaming tail while streaming is still live', () => {
    expect(decideTTSFinishAction({
      alreadyFinalized: false,
      streamingAvailable: true,
      hasEmittedAudio: true,
    })).toBe('flush');
  });

  it('does NOT fall back to whole-sentence decode once streaming already played part of the sentence', () => {
    // WHY: if streaming emitted PCM and then a later chunk failed, that audio is
    // already playing. Re-decoding the whole sentence replays the prefix —
    // audible echo/stutter. The only safe move is to drop the rest.
    expect(decideTTSFinishAction({
      alreadyFinalized: false,
      streamingAvailable: false,
      hasEmittedAudio: true,
    })).toBe('skip');
  });

  it('falls back to whole-sentence decode only when streaming produced no audio at all', () => {
    // WHY: if the very first chunk failed, nothing has played yet, so the
    // accumulated chunks can be safely decoded as one blob.
    expect(decideTTSFinishAction({
      alreadyFinalized: false,
      streamingAvailable: false,
      hasEmittedAudio: false,
    })).toBe('whole-sentence');
  });
});

describe('VolcengineAST2Client TTS finalize', () => {
  let originalWebSocket: any;
  let originalAudioContext: any;

  beforeEach(() => {
    mockSockets = [];
    originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = MockWebSocket as any;
    // Minimal AudioContext so the whole-sentence fallback path (if wrongly
    // taken) actually decodes and emits — letting the test SEE the duplicate.
    originalAudioContext = (globalThis as any).AudioContext;
    (globalThis as any).AudioContext = class {
      sampleRate = 24000;
      state = 'running';
      async decodeAudioData() {
        return {
          length: 4,
          sampleRate: 24000,
          getChannelData: () => new Float32Array([0.5, 0.5, 0.5, 0.5]),
        };
      }
      close() {}
    } as any;
  });

  afterEach(() => {
    (globalThis as any).WebSocket = originalWebSocket;
    (globalThis as any).AudioContext = originalAudioContext;
    vi.useRealTimers();
  });

  function countAudioDeltas(handler: { calls: Array<{ delta?: any }> }): number {
    return handler.calls.filter((c) => c.delta && c.delta.audio).length;
  }

  it('does not replay the already-streamed prefix when a later chunk fails mid-sentence', async () => {
    // WHY (finding 6): streaming emits chunk 1 (plays), chunk 2 fails →
    // decoder unavailable. The old code then whole-sentence-decoded ALL chunks
    // and played them again — the listener hears the sentence's start twice.
    let chunkCount = 0;
    let chunk2Failed = false;
    const decoderFactory = async () => ({
      ready: Promise.resolve(),
      decode: async () => {
        chunkCount++;
        if (chunkCount >= 2) {
          chunk2Failed = true;
          throw new Error('bad ogg page');
        }
        return { channelData: [new Float32Array([0.3, 0.3])], samplesDecoded: 2 };
      },
      flush: async () => ({ channelData: [], samplesDecoded: 0 }),
      reset: async () => {},
      free: () => {},
    });

    const updates: Array<{ delta?: any }> = [];
    const client = new VolcengineAST2Client('app-id', '', 'volc.service_type.10053', decoderFactory as any);
    client.setEventHandlers({
      onConversationUpdated: (data) => updates.push(data),
    });

    const ws = await connectAndStart(client);

    const waitFor = async (predicate: () => boolean): Promise<void> => {
      for (let i = 0; i < 100 && !predicate(); i++) await Promise.resolve();
    };

    ws.emitServerEvent(EventType.TTSSentenceStart);
    await Promise.resolve();
    ws.emitServerEvent(EventType.TTSResponse, { data: new Uint8Array([1, 2, 3]) });
    await Promise.resolve();
    ws.emitServerEvent(EventType.TTSResponse, { data: new Uint8Array([4, 5, 6]) });

    // Deterministically wait until chunk 2 has failed AND the decoder has had
    // microtasks to flip itself to unavailable, so the finalize sees the true
    // post-failure state (streamingAvailable=false, hasEmittedAudio=true).
    await waitFor(() => chunk2Failed);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    ws.emitServerEvent(EventType.TTSSentenceEnd);
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // Exactly one audio delta from the single successful streaming chunk;
    // no extra whole-sentence playback that would replay the prefix.
    expect(countAudioDeltas({ calls: updates })).toBe(1);
  });

  it('finalizes a sentence only once even when TTSEnded arrives during the async TTSSentenceEnd flush', async () => {
    // WHY (finding 7): finishSentence is async. If TTSEnded lands while the
    // TTSSentenceEnd-triggered flush is still awaiting, dedup that relies on the
    // ttsChunks buffer being cleared can double-finalize. The explicit finalize
    // flag must guarantee a single finalize/play.
    let flushCalls = 0;
    let releaseFlush: (() => void) | null = null;
    const decoderFactory = async () => ({
      ready: Promise.resolve(),
      decode: async () => ({ channelData: [new Float32Array([0.3, 0.3])], samplesDecoded: 2 }),
      flush: async () => {
        flushCalls++;
        await new Promise<void>((resolve) => { releaseFlush = resolve; });
        return { channelData: [new Float32Array([0.1])], samplesDecoded: 1 };
      },
      reset: async () => {},
      free: () => {},
    });

    const client = new VolcengineAST2Client('app-id', '', 'volc.service_type.10053', decoderFactory as any);
    client.setEventHandlers({});

    const ws = await connectAndStart(client);

    ws.emitServerEvent(EventType.TTSSentenceStart);
    await Promise.resolve();
    ws.emitServerEvent(EventType.TTSResponse, { data: new Uint8Array([1, 2, 3]) });
    await Promise.resolve();
    await Promise.resolve();

    const waitFor = async (predicate: () => boolean): Promise<void> => {
      for (let i = 0; i < 50 && !predicate(); i++) await Promise.resolve();
    };

    // TTSSentenceEnd kicks off finishSentence (flush is now pending).
    ws.emitServerEvent(EventType.TTSSentenceEnd);
    await waitFor(() => flushCalls >= 1);
    expect(flushCalls).toBe(1);

    // TTSEnded arrives WHILE the flush is still in flight.
    ws.emitServerEvent(EventType.TTSEnded);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The flush must not have been triggered a second time.
    expect(flushCalls).toBe(1);

    releaseFlush!();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(flushCalls).toBe(1);
  });
});
