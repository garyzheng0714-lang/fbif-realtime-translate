/**
 * Volcengine AST 2.0 Client - Speech-to-Speech (s2s) Translation
 *
 * Uses protobuf binary over WebSocket with simple HTTP header auth.
 * Endpoint: wss://openspeech.bytedance.com/api/v4/ast/v2/translate
 *
 * Platform-specific header injection strategies:
 *   - Electron: session.webRequest.onBeforeSendHeaders injects auth headers into
 *     the WebSocket upgrade request. Renderer registers headers via IPC, then opens
 *     a standard browser WebSocket.
 *   - Extension: declarativeNetRequest — background service worker injects auth headers into
 *     the WebSocket upgrade request, then the side panel opens a plain browser WebSocket.
 *   - Web: fallback — plain WebSocket without auth headers (not expected to work).
 *
 * All platforms use a direct browser WebSocket in the renderer — no IPC frame relay.
 *
 * Protocol flow:
 *   1. Connect WebSocket with auth headers
 *   2. Send StartSession (event=100) with audio config and language pair
 *   3. Wait for SessionStarted (event=150)
 *   4. Send TaskRequest (event=200) with audio binary_data chunks
 *   5. Receive events: SourceSubtitle (650-652), TranslationSubtitle (653-655), TTSResponse (352)
 *   6. Send FinishSession (event=102)
 */

import { v4 as uuidv4 } from 'uuid';
import {
  IClient,
  ConversationItem,
  SessionConfig,
  VolcengineAST2SessionConfig,
  isVolcengineAST2SessionConfig,
  ClientEventHandlers,
  ResponseConfig,
  ApiKeyValidationResult,
  FilteredModel,
} from '../interfaces/IClient';
import { Provider, ProviderType } from '../../types/Provider';
import { isElectron, isExtension } from '../../utils/environment';
import {
  decodedOggOpusToInt16,
  type StreamingOggOpusDecoder,
  type StreamingDecoderFactory,
  VolcengineAST2StreamingTTSDecoder,
} from './VolcengineAST2StreamingTTSDecoder';
// @ts-ignore - generated proto file
import { data } from './volcengine-ast2/ast2-proto.js';

const TranslateRequest = data.speech.ast.TranslateRequest;
const TranslateResponse = data.speech.ast.TranslateResponse;
const EventType = data.speech.event.Type;

const WS_ENDPOINT = 'wss://openspeech.bytedance.com/api/v4/ast/v2/translate';

// Audio sample rates
const INPUT_SAMPLE_RATE = 16000;  // Server expects 16kHz input PCM
const OUTPUT_SAMPLE_RATE = 24000;
const DOWNSAMPLE_RATIO = 24000 / INPUT_SAMPLE_RATE; // 1.5 (pipeline sends 24kHz)

/**
 * Build the `Corpus` payload attached to `ReqParams.corpus` in the
 * StartSession request. Returns `undefined` when the user has not set
 * any library IDs, so the caller can omit the `corpus` key entirely.
 *
 * Volcengine self-learning platform → AST 2.0 API field mapping
 * (per https://www.volcengine.com/docs/6561/1756902):
 *   Hot Words   → boosting_table_id       (wire) / boostingTableId     (JS)
 *   Replacement → regex_correct_table_id         / regexCorrectTableId
 *   Glossary    → glossary_table_id              / glossaryTableId
 *
 * We emit the **camelCase** JS property names because protobuf.js encodes
 * from the generated binding's property names (see ast2-proto.d.ts); the
 * snake_case names in the API doc are only the on-wire JSON form.
 */
export function buildCorpusFromConfig(
  config: VolcengineAST2SessionConfig
): Record<string, string> | undefined {
  const corpus: Record<string, string> = {};
  const hotId = config.hotWordTableId?.trim();
  const replaceId = config.replacementTableId?.trim();
  const glossaryId = config.glossaryTableId?.trim();
  if (hotId) corpus.boostingTableId = hotId;
  if (replaceId) corpus.regexCorrectTableId = replaceId;
  if (glossaryId) corpus.glossaryTableId = glossaryId;
  return Object.keys(corpus).length > 0 ? corpus : undefined;
}

export function buildVolcengineAST2AuthHeaders(
  appIdOrApiKey: string,
  accessToken: string,
  resourceId: string,
  connectId: string
): Record<string, string> {
  const key = String(appIdOrApiKey ?? '').trim();
  const legacyToken = String(accessToken ?? '').trim();
  const baseHeaders = {
    'X-Api-Resource-Id': resourceId,
    'X-Api-Connect-Id': connectId,
  };

  if (legacyToken) {
    return {
      'X-Api-App-Key': key,
      'X-Api-Access-Key': legacyToken,
      ...baseHeaders,
    };
  }

  return {
    'X-Api-Key': key,
    ...baseHeaders,
  };
}

/**
 * Decide how to finalize a TTS sentence, given the streaming decoder's state.
 *
 * This exists to prevent the same sentence audio from being played twice. The
 * streaming decoder emits PCM chunk-by-chunk as it decodes; if a later chunk
 * fails it flips to unavailable, but the chunks it already emitted have ALREADY
 * been played. Blindly falling back to whole-sentence decode then replays the
 * already-played prefix (audible echo / stutter). It must also be idempotent
 * per sentence, because both TTSSentenceEnd and TTSEnded can fire for the same
 * sentence and must not finalize it twice.
 *
 *  - 'skip'             : already finalized this sentence → do nothing.
 *  - 'flush'            : streaming is live → flush the decoder's tail; the
 *                         whole-sentence fallback is only needed if the flush
 *                         yields no audio at all.
 *  - 'whole-sentence'   : streaming never produced any audio for this sentence →
 *                         decode the accumulated chunks as one blob.
 */
export type TTSFinishAction = 'skip' | 'flush' | 'whole-sentence';

export function decideTTSFinishAction(state: {
  alreadyFinalized: boolean;
  streamingAvailable: boolean;
  hasEmittedAudio: boolean;
}): TTSFinishAction {
  if (state.alreadyFinalized) return 'skip';
  if (state.streamingAvailable) return 'flush';
  // Decoder is unavailable (mid-sentence failure). If it already emitted audio,
  // those chunks played — replaying the whole sentence would double them, so
  // do NOT fall back. Only fall back when nothing streamed out at all.
  if (state.hasEmittedAudio) return 'skip';
  return 'whole-sentence';
}

/**
 * Build the `requestMeta` for an outgoing TaskRequest (real audio frame or
 * keepalive silence frame). Keeping a single builder ensures every audio frame
 * carries the same metadata as StartSession (Endpoint + ResourceID), instead of
 * the previous drift where StartSession had Endpoint/ResourceID but TaskRequests
 * (real + silence) omitted them — a latent risk that frames get dropped if the
 * server tightens requestMeta validation.
 */
export function buildTaskRequestMeta(args: {
  resourceId: string;
  connectionId: string;
  sessionId: string;
  sequence: number;
  appKey?: string;
}): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    Endpoint: 'volc.service_type.10053',
    ResourceID: args.resourceId,
    ConnectionID: args.connectionId,
    SessionID: args.sessionId,
    Sequence: args.sequence,
  };
  if (args.appKey) meta.AppKey = args.appKey;
  return meta;
}

/**
 * High-frequency downlink event types: TTS audio chunks and per-character
 * subtitle deltas. During one spoken sentence these can arrive dozens to
 * hundreds of times. Building a fresh latency snapshot object for each one (and
 * dispatching it) adds steady GC pressure over a multi-hour live session and
 * competes with audio decode/playback for the main thread. Low-frequency
 * lifecycle events (SessionStarted, sentence start/end) keep their full
 * snapshot because they are the ones worth diagnosing.
 */
export function isHighFrequencyAST2Event(
  eventType: number,
  eventTypes: { TTSResponse: number; SourceSubtitleResponse: number; TranslationSubtitleResponse: number }
): boolean {
  return (
    eventType === eventTypes.TTSResponse ||
    eventType === eventTypes.SourceSubtitleResponse ||
    eventType === eventTypes.TranslationSubtitleResponse
  );
}

export interface VolcengineAST2LatencyState {
  sessionStartedAt?: number;
  lastInputAudioSentAt?: number;
  ttsSentenceStartedAt?: number;
  firstTtsChunkReceivedAt?: number;
}

export function buildVolcengineAST2LatencySnapshot(
  state: VolcengineAST2LatencyState,
  receivedAt: number,
  response: { startTime?: number; endTime?: number } = {}
): Record<string, number> {
  const latency: Record<string, number> = { receivedAt };
  if (state.sessionStartedAt) latency.sinceSessionStartMs = receivedAt - state.sessionStartedAt;
  if (state.lastInputAudioSentAt) latency.sinceLastInputAudioMs = receivedAt - state.lastInputAudioSentAt;
  if (state.ttsSentenceStartedAt) latency.sinceTtsSentenceStartMs = receivedAt - state.ttsSentenceStartedAt;
  if (state.firstTtsChunkReceivedAt) latency.sinceFirstTtsChunkMs = receivedAt - state.firstTtsChunkReceivedAt;
  if (typeof response.startTime === 'number') latency.serverStartTime = response.startTime;
  if (typeof response.endTime === 'number') latency.serverEndTime = response.endTime;
  return latency;
}

export class VolcengineAST2Client implements IClient {
  private appId: string;
  private accessToken: string;
  private resourceId: string;
  private isConnectedState = false;
  private websocket: WebSocket | null = null;
  private eventHandlers: ClientEventHandlers = {};
  private conversationItems: ConversationItem[] = [];
  private currentConfig: VolcengineAST2SessionConfig | null = null;
  private sessionId: string = '';
  private connectionId: string = '';
  private sequence: number = 0;
  private itemCounter: number = 0;
  private sessionStartedResolve: (() => void) | null = null;
  private sessionStartedReject: ((error: Error) => void) | null = null;

  // Track current subtitle items for incremental updates
  private currentSourceItemId: string | null = null;
  private currentTranslationItemId: string | null = null;
  private lastCompletedTranslationItemId: string | null = null;

  // TTS audio accumulation — server sends Ogg Opus chunks that must be
  // concatenated per sentence before decoding
  private ttsChunks: Uint8Array[] = [];
  private decodeContext: AudioContext | null = null;
  private streamingTTSDecoder: VolcengineAST2StreamingTTSDecoder | null = null;

  // Message matching reliability — track server-side Sequence and lock TTS to correct translation item
  private lastResponseSequence: number = -1;
  private ttsSentenceTargetItemId: string | null = null;

  // Explicit per-sentence finalize flag so TTSSentenceEnd and TTSEnded can't
  // each finalize (and re-play) the same sentence. Reset on TTSSentenceStart.
  private ttsSentenceFinalized = false;

  // Keepalive: send silent audio frames when mic is muted to prevent server timeout
  private keepaliveInterval: ReturnType<typeof setInterval> | null = null;
  private lastAudioSentTime: number = 0;

  // Reconnection: Volcengine AST2 hard-limits a connection (2h cap, 30min
  // silence, 45000081 push timeout). Long videos/live streams hit these
  // routinely, so we transparently rebuild the socket + StartSession instead of
  // tearing the user's session down.
  private isDisconnecting = false;        // true while a user-initiated disconnect is in flight
  private sessionEverStarted = false;     // true once the current socket reached SessionStarted
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private preReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isReconnecting = false;
  private static readonly MAX_RECONNECT_ATTEMPTS = 6;
  private static readonly RECONNECT_BASE_DELAY_MS = 1000;
  private static readonly RECONNECT_MAX_DELAY_MS = 15000;
  // Pre-reconnect well before the 2h hard cap so a fresh connection is live
  // before the server force-closes the old one (avoids a downlink gap).
  private static readonly PRE_RECONNECT_AFTER_MS = 110 * 60 * 1000;

  // Latency diagnostics: only timestamps, never audio payloads
  private sessionStartedAt: number = 0;
  private lastInputAudioSentAt: number = 0;
  private ttsSentenceStartedAt: number = 0;
  private firstTtsChunkReceivedAt: number = 0;

  // Whether we registered WebSocket headers that need cleanup (Electron/Extension)
  private headersRegistered = false;

  // Optional override for the low-level Ogg Opus decoder factory. Production
  // leaves this undefined and lazily imports `ogg-opus-decoder`; tests inject a
  // controllable fake to exercise streaming-failure / fallback paths without a
  // real WASM decoder. Kept optional so existing call sites stay unchanged.
  private streamingDecoderFactoryOverride?: StreamingDecoderFactory;

  constructor(
    appId: string,
    accessToken: string,
    resourceId: string = 'volc.service_type.10053',
    streamingDecoderFactoryOverride?: StreamingDecoderFactory
  ) {
    this.appId = appId;
    this.accessToken = accessToken;
    this.resourceId = resourceId;
    this.streamingDecoderFactoryOverride = streamingDecoderFactoryOverride;
  }

  private isLegacyAuth(): boolean {
    return this.accessToken.trim().length > 0;
  }

  private buildAuthHeaders(connectId: string): Record<string, string> {
    return buildVolcengineAST2AuthHeaders(
      this.appId,
      this.accessToken,
      this.resourceId,
      connectId
    );
  }

  private generateItemId(prefix: string): string {
    return `volcengine_ast2_${prefix}_${++this.itemCounter}`;
  }

  /** requestMeta for an outgoing TaskRequest, aligned with StartSession. */
  private taskRequestMeta(): Record<string, unknown> {
    return buildTaskRequestMeta({
      resourceId: this.resourceId,
      connectionId: this.connectionId,
      sessionId: this.sessionId,
      sequence: this.sequence++,
      appKey: this.isLegacyAuth() ? this.appId : undefined,
    });
  }

  private sendData(data: Uint8Array): void {
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      this.websocket.send(data);
    }
  }

  async connect(config: SessionConfig): Promise<void> {
    if (!isVolcengineAST2SessionConfig(config)) {
      throw new Error('[VolcengineAST2Client] Invalid session config');
    }

    this.currentConfig = config;
    this.sessionId = uuidv4();
    this.connectionId = uuidv4();
    this.sequence = 0;
    this.itemCounter = 0;
    this.currentSourceItemId = null;
    this.currentTranslationItemId = null;
    this.lastCompletedTranslationItemId = null;
    this.lastResponseSequence = -1;
    this.ttsSentenceTargetItemId = null;
    this.sessionStartedAt = 0;
    this.lastInputAudioSentAt = 0;
    this.ttsSentenceStartedAt = 0;
    this.firstTtsChunkReceivedAt = 0;
    this.isDisconnecting = false;
    this.sessionEverStarted = false;
    this.reconnectAttempts = 0;
    this.clearReconnectTimers();

    return this.openTransport();
  }

  /**
   * Open the WebSocket transport for the current platform, injecting auth
   * headers as needed. Shared by the initial connect() and by reconnection,
   * so a reconnect rebuilds the socket through the exact same path (including
   * header injection) without re-running connect()'s state reset.
   */
  private openTransport(): Promise<void> {
    if (isElectron() && window.electron?.invoke) {
      return this.connectViaElectronHeaderInjection();
    }
    if (isExtension()) {
      return this.connectViaExtensionDNR();
    }
    return this.connectViaBrowserWebSocket();
  }

  // ─── Electron path: session.webRequest injects headers ──────────────
  private async connectViaElectronHeaderInjection(): Promise<void> {
    // Register auth headers with the main process. The main process will
    // inject them into the WebSocket upgrade request via onBeforeSendHeaders.
    // Headers are one-shot (consumed by the handler after injection), but we
    // still clear on failure in case the upgrade request never fired.
    const host = new URL(WS_ENDPOINT).host;
    const result = await window.electron.invoke('ws-headers-set', {
      host,
      headers: this.buildAuthHeaders(this.connectionId),
    });

    if (!result?.success) {
      throw new Error(`Failed to register WS headers: ${result?.error}`);
    }

    this.headersRegistered = true;

    try {
      // Open a plain browser WebSocket — webRequest will inject the auth headers
      await this.connectViaBrowserWebSocket();
    } catch (error) {
      // Clean up headers if the connection failed before the upgrade consumed them
      this.clearElectronHeaders();
      throw error;
    }
  }

  private clearElectronHeaders(): void {
    if (!this.headersRegistered) return;
    this.headersRegistered = false;
    const host = new URL(WS_ENDPOINT).host;
    window.electron.invoke('ws-headers-clear', { host }).catch(() => {});
  }

  // ─── Extension path: declarativeNetRequest injects headers ─────────
  private async connectViaExtensionDNR(): Promise<void> {
    // Ask background service worker to register DNR rules that inject
    // auth headers into the WebSocket upgrade request
    const dnrResult = await new Promise<{ success: boolean; error?: string }>((resolve) => {
      chrome!.runtime.sendMessage(
        {
          type: 'VOLCENGINE_AST2_SET_HEADERS',
          credentials: {
            apiKey: this.appId,
            appKey: this.isLegacyAuth() ? this.appId : undefined,
            accessKey: this.isLegacyAuth() ? this.accessToken : undefined,
            resourceId: this.resourceId,
            connectId: this.connectionId,
          },
        },
        (response: { success: boolean; error?: string }) => {
          if (chrome!.runtime.lastError) {
            resolve({ success: false, error: chrome!.runtime.lastError.message });
          } else {
            resolve(response || { success: false, error: 'No response from background' });
          }
        }
      );
    });

    if (!dnrResult.success) {
      throw new Error(`Failed to set DNR headers: ${dnrResult.error}`);
    }

    this.headersRegistered = true;

    try {
      // Open a plain browser WebSocket — DNR rules will inject the auth headers
      await this.connectViaBrowserWebSocket();
    } catch (error) {
      // Clean up DNR rules if the connection failed
      this.clearExtensionDNR();
      throw error;
    }
  }

  private clearExtensionDNR(): void {
    if (!this.headersRegistered) return;
    this.headersRegistered = false;
    try {
      chrome!.runtime.sendMessage({ type: 'VOLCENGINE_AST2_CLEAR_HEADERS' });
    } catch {
      // Ignore cleanup errors
    }
  }

  // ─── Browser WebSocket (headers injected by platform layer above) ───
  private connectViaBrowserWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.websocket = new WebSocket(WS_ENDPOINT);
        this.websocket.binaryType = 'arraybuffer';

        this.websocket.onopen = () => {
          console.log('[VolcengineAST2Client] WebSocket connected');
          this.isConnectedState = true;

          this.eventHandlers.onRealtimeEvent?.({
            source: 'client',
            event: {
              type: 'session.created',
              data: { status: 'connected', provider: 'volcengine_ast2', timestamp: Date.now() }
            }
          });

          // Send StartSession
          this.sendStartSession();
        };

        this.websocket.onmessage = (event) => {
          this.handleMessage(event.data as ArrayBuffer);
        };

        this.websocket.onerror = (event) => {
          clearTimeout(connectionTimer);
          const url = (event.target as WebSocket)?.url || WS_ENDPOINT;
          const error = new Error(`WebSocket connection to ${url} failed`);
          console.error('[VolcengineAST2Client] WebSocket error:', error.message);
          this.eventHandlers.onError?.(error);
          reject(error);
        };

        this.websocket.onclose = (event) => {
          clearTimeout(connectionTimer);
          console.log('[VolcengineAST2Client] WebSocket closed:', event.code, event.reason);
          this.isConnectedState = false;
          this.stopKeepalive();

          const closedBeforeSessionStarted = this.sessionStartedReject != null;

          // If the socket closes before SessionStarted, the pending connect (or
          // reconnect) promise is still waiting. Reject it now instead of letting
          // it hang until the 30s connection timeout — browser auth/rate-limit/
          // capacity rejections after the upgrade arrive as onclose (not
          // onerror), so without this the user is stuck on "initializing" 30s.
          if (this.sessionStartedReject) {
            const reject = this.sessionStartedReject;
            this.sessionStartedResolve = null;
            this.sessionStartedReject = null;
            reject(new Error(`WS closed before session started: ${event.code} ${event.reason}`));
          }

          this.eventHandlers.onRealtimeEvent?.({
            source: 'client',
            event: {
              type: 'session.closed',
              data: {
                status: 'disconnected',
                provider: 'volcengine_ast2',
                timestamp: Date.now(),
                code: event.code,
                reason: event.reason,
              }
            }
          });

          // A close while a reconnect handshake is in flight is handled by the
          // reconnect loop's rejected promise — don't tear the session down.
          if (this.isReconnecting) {
            return;
          }

          // An established session that closed unexpectedly (server hard cap,
          // silence timeout, push timeout, network blip) should be transparently
          // reconnected rather than torn down. Suppress onClose so MainPanel
          // keeps the session alive while we rebuild the connection.
          if (!this.isDisconnecting && this.sessionEverStarted && !closedBeforeSessionStarted) {
            this.scheduleReconnect();
            return;
          }

          this.eventHandlers.onClose?.(event);
        };

        const CONNECTION_TIMEOUT = 30000;
        const connectionTimer = setTimeout(() => {
          this.sessionStartedResolve = null;
          this.sessionStartedReject = null;
          if (this.websocket) {
            this.websocket.close();
            this.websocket = null;
          }
          this.isConnectedState = false;
          reject(new Error('Volcengine AST2 connection timeout'));
        }, CONNECTION_TIMEOUT);

        // Wait for SessionStarted before resolving
        this.sessionStartedResolve = () => {
          clearTimeout(connectionTimer);
          this.eventHandlers.onOpen?.();
          resolve();
        };
        this.sessionStartedReject = (error: Error) => {
          clearTimeout(connectionTimer);
          reject(error);
        };

      } catch (error) {
        console.error('[VolcengineAST2Client] Connection error:', error);
        reject(error);
      }
    });
  }

  private sendStartSession(): void {
    if (!this.currentConfig) return;
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) return;

    const isTextOnly = this.currentConfig.textOnly || false;

    const requestPayload: any = {
      requestMeta: {
        Endpoint: 'volc.service_type.10053',
        ...(this.isLegacyAuth() ? { AppKey: this.appId } : {}),
        ResourceID: this.resourceId,
        ConnectionID: this.connectionId,
        SessionID: this.sessionId,
        Sequence: this.sequence++,
      },
      event: EventType.StartSession,
      user: {
        uid: 'sokuji-user',
        platform: 'web',
      },
      sourceAudio: {
        format: 'pcm',
        rate: INPUT_SAMPLE_RATE,
        bits: 16,
        channel: 1,
      },
      request: {
        mode: isTextOnly ? 's2t' : 's2s',
        sourceLanguage: this.currentConfig.sourceLanguage,
        targetLanguage: this.currentConfig.targetLanguage,
      },
    };

    // Attach custom-vocabulary library IDs when the user has set any.
    const corpus = buildCorpusFromConfig(this.currentConfig);
    if (corpus) {
      requestPayload.request.corpus = corpus;
    }

    // Only include targetAudio in s2s mode
    if (!isTextOnly) {
      requestPayload.targetAudio = {
        format: 'ogg_opus',
        rate: OUTPUT_SAMPLE_RATE,
      };
    }

    const request = TranslateRequest.encode(requestPayload).finish();

    this.sendData(request);

    this.eventHandlers.onRealtimeEvent?.({
      source: 'client',
      event: {
        type: 'start_session.sent',
        data: {
          sessionId: this.sessionId,
          sourceLanguage: this.currentConfig.sourceLanguage,
          targetLanguage: this.currentConfig.targetLanguage,
          mode: isTextOnly ? 's2t' : 's2s',
          corpus: corpus ?? null,
        }
      }
    });
  }

  private handleMessage(data: ArrayBuffer): void {
    try {
      const response = TranslateResponse.decode(new Uint8Array(data));
      const eventType: number = response.event;
      const receivedAt = Date.now();

      if (eventType === EventType.TTSSentenceStart && !this.currentConfig?.textOnly) {
        this.ttsSentenceStartedAt = receivedAt;
        this.firstTtsChunkReceivedAt = 0;
      }
      if (eventType === EventType.TTSResponse && !this.currentConfig?.textOnly && response.data?.length && !this.firstTtsChunkReceivedAt) {
        this.firstTtsChunkReceivedAt = receivedAt;
      }

      // Only build the (allocating) latency snapshot for low-frequency events.
      // High-frequency TTS/subtitle deltas skip it to avoid per-message GC churn
      // over long live sessions.
      const includeLatency = !isHighFrequencyAST2Event(eventType, EventType);
      this.eventHandlers.onRealtimeEvent?.({
        source: 'server',
        event: {
          type: EventType[eventType] || `message.${eventType}`,
          data: {
            event: eventType,
            eventName: EventType[eventType] || `unknown(${eventType})`,
            text: response.text || undefined,
            hasAudioData: !!(response.data && response.data.length > 0),
            audioDataLength: response.data?.length || 0,
            sessionId: response.responseMeta?.SessionID,
            statusCode: response.responseMeta?.StatusCode,
            ...(includeLatency
              ? {
                  latency: buildVolcengineAST2LatencySnapshot(
                    {
                      sessionStartedAt: this.sessionStartedAt,
                      lastInputAudioSentAt: this.lastInputAudioSentAt,
                      ttsSentenceStartedAt: this.ttsSentenceStartedAt,
                      firstTtsChunkReceivedAt: this.firstTtsChunkReceivedAt,
                    },
                    receivedAt,
                    { startTime: response.startTime, endTime: response.endTime }
                  ),
                }
              : {}),
          }
        }
      });

      // Check for error status — Volcengine uses 20000000 as the success code (like HTTP 200)
      const statusCode = response.responseMeta?.StatusCode;
      if (statusCode && statusCode !== 0 && statusCode !== 20000000) {
        const errorMsg = response.responseMeta?.Message || `Status code: ${response.responseMeta?.StatusCode}`;
        console.error('[VolcengineAST2Client] Server error:', errorMsg);

        if (this.sessionStartedReject) {
          this.sessionStartedReject(new Error(errorMsg));
          this.sessionStartedResolve = null;
          this.sessionStartedReject = null;
        }

        const errorItem: ConversationItem = {
          id: this.generateItemId('error'),
          role: 'system',
          type: 'error',
          status: 'completed',
          formatted: { text: `[Error] ${errorMsg}` },
          content: [{ type: 'text', text: errorMsg }]
        };
        this.conversationItems.push(errorItem);
        this.eventHandlers.onConversationUpdated?.({ item: errorItem });
        return;
      }

      // Validate SessionID matches current session
      const responseSessionId = response.responseMeta?.SessionID;
      if (responseSessionId && responseSessionId !== this.sessionId) {
        console.warn('[VolcengineAST2Client] SessionID mismatch - expected:', this.sessionId, 'got:', responseSessionId);
        return;
      }

      // Check Sequence for regression (Sequence is per-utterance — all events within one
      // speech segment share the same value, so only warn on actual decrease)
      const responseSeq = response.responseMeta?.Sequence;
      if (responseSeq != null && responseSeq > 0) {
        if (responseSeq < this.lastResponseSequence) {
          console.warn('[VolcengineAST2Client] Out-of-order response - last:', this.lastResponseSequence, 'got:', responseSeq, 'event:', EventType[eventType]);
        }
        this.lastResponseSequence = responseSeq;
      }

      switch (eventType) {
        case EventType.SessionStarted:
          this.handleSessionStarted();
          break;

        case EventType.SessionFinished:
          console.log('[VolcengineAST2Client] Session finished');
          break;

        case EventType.SessionFailed:
          console.error('[VolcengineAST2Client] Session failed:', response.responseMeta?.Message);
          if (this.sessionStartedReject) {
            this.sessionStartedReject(new Error(response.responseMeta?.Message || 'Session failed'));
            this.sessionStartedResolve = null;
            this.sessionStartedReject = null;
          }
          break;

        // Source (original) language subtitle events
        case EventType.SourceSubtitleStart:
          this.handleSourceSubtitle(response, 'start');
          break;
        case EventType.SourceSubtitleResponse:
          this.handleSourceSubtitle(response, 'response');
          break;
        case EventType.SourceSubtitleEnd:
          this.handleSourceSubtitle(response, 'end');
          break;

        // Translation subtitle events
        case EventType.TranslationSubtitleStart:
          this.handleTranslationSubtitle(response, 'start');
          break;
        case EventType.TranslationSubtitleResponse:
          this.handleTranslationSubtitle(response, 'response');
          break;
        case EventType.TranslationSubtitleEnd:
          this.handleTranslationSubtitle(response, 'end');
          break;

        // TTS audio response
        case EventType.TTSResponse:
          if (!this.currentConfig?.textOnly) this.handleTTSResponse(response);
          break;

        // TTS lifecycle
        case EventType.TTSSentenceStart:
          if (!this.currentConfig?.textOnly) {
            this.ttsChunks = [];
            this.ttsSentenceFinalized = false;
            // Lock the current translation item — TTS audio should associate with the
            // translation active when TTS starts, not when it ends
            this.ttsSentenceTargetItemId = this.currentTranslationItemId || this.lastCompletedTranslationItemId;
            this.startStreamingTTSSentence();
          }
          break;
        case EventType.TTSSentenceEnd:
          if (!this.currentConfig?.textOnly) this.finishStreamingOrDecodeTTSAndPlay();
          break;
        case EventType.TTSEnded:
          // Finalize the sentence if TTSSentenceEnd hasn't already. Gate on the
          // explicit finalize flag rather than ttsChunks length so an in-flight
          // (async) TTSSentenceEnd can't be double-finalized by TTSEnded.
          if (!this.currentConfig?.textOnly && !this.ttsSentenceFinalized) {
            this.finishStreamingOrDecodeTTSAndPlay();
          }
          break;

        // Informational events — no action needed
        case EventType.UsageResponse:  // billing/usage data
        case EventType.AudioMuted:     // mic silence detected by server
          break;

        default:
          // Log unknown events for debugging
          if (eventType !== EventType.None) {
            console.log(`[VolcengineAST2Client] Unhandled event: ${EventType[eventType] || eventType}`);
          }
          break;
      }
    } catch (error) {
      console.error('[VolcengineAST2Client] Error parsing message:', error);
    }
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    const KEEPALIVE_INTERVAL_MS = 100;  // How often to check for a silence gap
    // Only treat the input as genuinely silent after a gap well beyond the real
    // audio frame cadence (~170ms per 4096-sample frame). The old 60ms threshold
    // fired BETWEEN consecutive real frames, splicing silence into live speech
    // and corrupting the server's VAD sentence boundaries (fragmented subtitles,
    // stuttering dubbing). Keepalive is a fallback for true silence only, so the
    // threshold must sit clearly above any real-frame interval.
    const SILENCE_TIMEOUT_MS = 300;
    // 1280 samples = 80ms of 16kHz silence — matches Volcengine recommended packet size ("建议80ms 一包")
    const SILENCE_FRAME = new Uint8Array(2560); // 1280 Int16 samples = 2560 bytes of zeros

    this.keepaliveInterval = setInterval(() => {
      if (!this.isConnectedState) return;
      if (Date.now() - this.lastAudioSentTime > SILENCE_TIMEOUT_MS) {
        const request = TranslateRequest.encode({
          requestMeta: this.taskRequestMeta(),
          event: EventType.TaskRequest,
          sourceAudio: {
            binaryData: SILENCE_FRAME,
          },
        }).finish();
        this.sendData(request);
        this.lastAudioSentTime = Date.now();
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
  }

  private handleSessionStarted(): void {
    console.log('[VolcengineAST2Client] Session started successfully');
    this.sessionStartedAt = Date.now();
    this.sessionEverStarted = true;
    this.reconnectAttempts = 0;
    this.startKeepalive();
    this.schedulePreReconnect();

    if (this.sessionStartedResolve) {
      this.sessionStartedResolve();
      this.sessionStartedResolve = null;
      this.sessionStartedReject = null;
    }
  }

  // ─── Reconnection ──────────────────────────────────────────────────
  private clearReconnectTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.preReconnectTimer) {
      clearTimeout(this.preReconnectTimer);
      this.preReconnectTimer = null;
    }
  }

  /**
   * Arm a timer that proactively rebuilds the connection before Volcengine's
   * 2h hard cap force-closes it, so the downlink never gaps on the limit.
   */
  private schedulePreReconnect(): void {
    if (this.preReconnectTimer) clearTimeout(this.preReconnectTimer);
    this.preReconnectTimer = setTimeout(() => {
      this.preReconnectTimer = null;
      if (this.isDisconnecting || this.isReconnecting) return;
      console.log('[VolcengineAST2Client] Pre-reconnecting before 2h hard cap');
      this.reconnectAttempts = 0;
      this.reconnect();
    }, VolcengineAST2Client.PRE_RECONNECT_AFTER_MS);
  }

  /** Schedule a reconnect attempt with exponential backoff. */
  private scheduleReconnect(): void {
    if (this.isDisconnecting || this.isReconnecting) return;
    this.clearReconnectTimers();

    if (this.reconnectAttempts >= VolcengineAST2Client.MAX_RECONNECT_ATTEMPTS) {
      console.error('[VolcengineAST2Client] Reconnect attempts exhausted, giving up');
      this.eventHandlers.onClose?.({ code: 1006, reason: 'reconnect_failed' });
      return;
    }

    const delay = Math.min(
      VolcengineAST2Client.RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts,
      VolcengineAST2Client.RECONNECT_MAX_DELAY_MS
    );
    // Signal "reconnecting" once on entry (not on every backoff retry) so the
    // UI shows a single reconnecting state for the whole recovery window.
    if (this.reconnectAttempts === 0) {
      this.eventHandlers.onReconnecting?.();
    }
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnect();
    }, delay);
  }

  /**
   * Rebuild the WebSocket + StartSession and wait for SessionStarted. Uses a
   * fresh ConnectionID/SessionID (Volcengine rejects reused connection IDs and
   * validates SessionID on every downlink message). On success, conversation
   * state and accumulated audio are preserved; on failure, falls back to
   * exponential-backoff retries.
   */
  private async reconnect(): Promise<void> {
    if (this.isDisconnecting) return;
    this.isReconnecting = true;
    this.clearReconnectTimers();

    // Tear down any lingering socket from the dead connection.
    if (this.websocket) {
      try { this.websocket.close(); } catch { /* ignore */ }
      this.websocket = null;
    }

    // Fresh identifiers for the new connection.
    this.connectionId = uuidv4();
    this.sessionId = uuidv4();
    this.sequence = 0;
    this.sessionEverStarted = false;

    try {
      await this.openTransport();
      // Reached SessionStarted — connection is live again.
      this.isReconnecting = false;
      this.reconnectAttempts = 0;
      this.eventHandlers.onReconnected?.();
    } catch (error) {
      console.warn('[VolcengineAST2Client] Reconnect attempt failed:', error);
      this.isReconnecting = false;
      this.scheduleReconnect();
    }
  }

  private handleSourceSubtitle(response: any, phase: 'start' | 'response' | 'end'): void {
    const text = response.text || '';
    const isDefinite = phase === 'end';

    if (phase === 'start') {
      // New source subtitle segment - create new item
      this.currentSourceItemId = this.generateItemId('source');
    }

    // Discard empty segments (server-side VAD false positives: Start+End with no text)
    if (isDefinite && !text.trim()) {
      console.log('[VolcengineAST2Client] Discarding empty source subtitle segment:', this.currentSourceItemId);
      this.currentSourceItemId = null;
      return;
    }

    const itemId = this.currentSourceItemId || this.generateItemId('source');

    const item: ConversationItem = {
      id: itemId,
      role: 'user',
      type: 'message',
      status: isDefinite ? 'completed' : 'in_progress',
      createdAt: Date.now(),
      formatted: { text, transcript: text },
      content: [{ type: 'text', text }]
    };

    if (isDefinite) {
      this.conversationItems.push(item);
      this.currentSourceItemId = null;
    }

    this.eventHandlers.onConversationUpdated?.({
      item,
      delta: {
        text,
        definite: isDefinite,
        language: this.currentConfig?.sourceLanguage,
        startTime: response.startTime,
        endTime: response.endTime,
      }
    });
  }

  private handleTranslationSubtitle(response: any, phase: 'start' | 'response' | 'end'): void {
    const text = response.text || '';
    const isDefinite = phase === 'end';

    if (phase === 'start') {
      // New translation subtitle segment - create new item
      this.currentTranslationItemId = this.generateItemId('translation');
    }

    // Discard empty segments (server-side VAD false positives: Start+End with no text)
    if (isDefinite && !text.trim()) {
      console.log('[VolcengineAST2Client] Discarding empty translation subtitle segment:', this.currentTranslationItemId);
      this.currentTranslationItemId = null;
      return;
    }

    const itemId = this.currentTranslationItemId || this.generateItemId('translation');

    const item: ConversationItem = {
      id: itemId,
      role: 'assistant',
      type: 'message',
      status: isDefinite ? 'completed' : 'in_progress',
      createdAt: Date.now(),
      formatted: { text, transcript: text },
      content: [{ type: 'text', text }]
    };

    if (isDefinite) {
      this.conversationItems.push(item);
      this.lastCompletedTranslationItemId = this.currentTranslationItemId;
      this.currentTranslationItemId = null;
    }

    this.eventHandlers.onConversationUpdated?.({
      item,
      delta: {
        text,
        definite: isDefinite,
        language: this.currentConfig?.targetLanguage,
        startTime: response.startTime,
        endTime: response.endTime,
      }
    });
  }

  private handleTTSResponse(response: any): void {
    if (!response.data || response.data.length === 0) return;

    // response.data is a Uint8Array VIEW into the shared protobuf decode
    // buffer — copy it before the buffer is reused on the next message.
    const chunk = new Uint8Array(response.data.length);
    chunk.set(response.data);
    this.ttsChunks.push(chunk);
    this.streamingTTSDecoder?.decodeChunk(chunk).catch(() => {});
  }

  /**
   * Concatenate accumulated Ogg Opus chunks, decode to PCM via Web Audio API,
   * and emit the resulting Int16Array through the normal audio pipeline.
   */
  private async decodeTTSAndPlay(): Promise<void> {
    if (this.ttsChunks.length === 0) return;
    const decodeStartedAt = Date.now();

    // Concatenate all chunks into a single Ogg Opus blob
    const totalLength = this.ttsChunks.reduce((sum, c) => sum + c.length, 0);
    const opusData = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of this.ttsChunks) {
      opusData.set(chunk, offset);
      offset += chunk.length;
    }
    this.ttsChunks = [];

    try {
      // Lazily create a reusable AudioContext for decoding
      if (!this.decodeContext || this.decodeContext.state === 'closed') {
        this.decodeContext = new AudioContext({ sampleRate: 24000 });
      }

      const audioBuffer = await this.decodeContext.decodeAudioData(opusData.buffer);
      const int16Array = decodedOggOpusToInt16({
        channelData: [audioBuffer.getChannelData(0)],
        samplesDecoded: audioBuffer.length,
        sampleRate: audioBuffer.sampleRate,
      });

      const decodeCompletedAt = Date.now();
      this.emitDecodedTTSAudio({
        audio: int16Array,
        eventType: 'tts.decode.completed',
        opusBytes: totalLength,
        decodeStartedAt,
        decodeCompletedAt,
        consumeTargetItem: true,
      });
    } catch (error) {
      console.error('[VolcengineAST2Client] Failed to decode TTS Opus audio:', error);
    }
  }

  private startStreamingTTSSentence(): void {
    this.getStreamingTTSDecoder().startSentence().catch(() => {});
  }

  private async finishStreamingOrDecodeTTSAndPlay(): Promise<void> {
    const streamingDecoder = this.streamingTTSDecoder;
    const action = decideTTSFinishAction({
      alreadyFinalized: this.ttsSentenceFinalized,
      streamingAvailable: !!streamingDecoder?.isAvailable(),
      hasEmittedAudio: !!streamingDecoder?.hasEmittedAudio(),
    });

    if (action === 'skip') {
      // Either already finalized (dedup), or streaming already played part of
      // this sentence and then failed — replaying the whole sentence would
      // double the audio, so drop the buffered chunks instead.
      this.ttsSentenceFinalized = true;
      this.ttsChunks = [];
      this.ttsSentenceTargetItemId = null;
      return;
    }

    // From here on this sentence is being finalized exactly once.
    this.ttsSentenceFinalized = true;

    if (action === 'flush' && streamingDecoder) {
      await streamingDecoder.finishSentence();
      if (streamingDecoder.hasEmittedAudio()) {
        this.ttsChunks = [];
        this.ttsSentenceTargetItemId = null;
        return;
      }
    }
    // 'whole-sentence', or a flush that produced nothing → decode the blob.
    await this.decodeTTSAndPlay();
  }

  private getStreamingTTSDecoder(): VolcengineAST2StreamingTTSDecoder {
    if (!this.streamingTTSDecoder) {
      const factory: StreamingDecoderFactory = this.streamingDecoderFactoryOverride ?? (async () => {
        const { OggOpusDecoder } = await import('ogg-opus-decoder');
        return new OggOpusDecoder({
          sampleRate: OUTPUT_SAMPLE_RATE,
          speechQualityEnhancement: 'none',
        } as any) as StreamingOggOpusDecoder;
      });
      this.streamingTTSDecoder = new VolcengineAST2StreamingTTSDecoder(
        factory,
        (audio, meta) => {
          this.emitDecodedTTSAudio({
            audio,
            eventType: 'tts.streaming.decode.completed',
            opusBytes: meta.sourceBytes,
            decodeStartedAt: meta.decodeStartedAt,
            decodeCompletedAt: meta.decodeCompletedAt,
            consumeTargetItem: false,
          });
        }
      );
    }
    return this.streamingTTSDecoder;
  }

  private emitDecodedTTSAudio({
    audio,
    eventType,
    opusBytes,
    decodeStartedAt,
    decodeCompletedAt,
    consumeTargetItem,
  }: {
    audio: Int16Array;
    eventType: 'tts.decode.completed' | 'tts.streaming.decode.completed';
    opusBytes: number;
    decodeStartedAt: number;
    decodeCompletedAt: number;
    consumeTargetItem: boolean;
  }): void {
    const targetItemId = this.ttsSentenceTargetItemId || this.currentTranslationItemId || this.lastCompletedTranslationItemId;
    if (consumeTargetItem) this.ttsSentenceTargetItemId = null;
    const existingItem = targetItemId
      ? this.conversationItems.find(i => i.id === targetItemId)
      : null;

    this.eventHandlers.onRealtimeEvent?.({
      source: 'client',
      event: {
        type: eventType,
        data: {
          opusBytes,
          audioSamples: audio.length,
          latency: {
            ...buildVolcengineAST2LatencySnapshot(
              {
                sessionStartedAt: this.sessionStartedAt,
                lastInputAudioSentAt: this.lastInputAudioSentAt,
                ttsSentenceStartedAt: this.ttsSentenceStartedAt,
                firstTtsChunkReceivedAt: this.firstTtsChunkReceivedAt,
              },
              decodeCompletedAt
            ),
            decodeDurationMs: decodeCompletedAt - decodeStartedAt,
          },
        },
      },
    });

    if (existingItem) {
      if (existingItem.formatted?.audio && existingItem.formatted.audio instanceof Int16Array) {
        const prev = existingItem.formatted.audio;
        const combined = new Int16Array(prev.length + audio.length);
        combined.set(prev);
        combined.set(audio, prev.length);
        existingItem.formatted.audio = combined;
      } else {
        if (!existingItem.formatted) existingItem.formatted = {};
        existingItem.formatted.audio = audio;
      }

      this.eventHandlers.onConversationUpdated?.({
        item: existingItem,
        delta: { audio }
      });

      this.eventHandlers.onConversationUpdated?.({
        item: existingItem,
      });
      return;
    }

    const item: ConversationItem = {
      id: this.generateItemId('tts_audio'),
      role: 'assistant',
      type: 'message',
      status: 'completed',
      createdAt: Date.now(),
      formatted: { audio },
      content: [{ type: 'audio' }]
    };
    this.conversationItems.push(item);

    this.eventHandlers.onConversationUpdated?.({
      item,
      delta: { audio }
    });
  }

  async disconnect(): Promise<void> {
    // Mark intent FIRST so the socket's onclose treats this as a user-initiated
    // stop and does not kick off a reconnect.
    this.isDisconnecting = true;
    this.clearReconnectTimers();
    this.stopKeepalive();
    // Send FinishSession before closing
    try {
      const request = TranslateRequest.encode({
        requestMeta: {
          SessionID: this.sessionId,
          ConnectionID: this.connectionId,
          Sequence: this.sequence++,
        },
        event: EventType.FinishSession,
      }).finish();

      this.sendData(request);
    } catch (e) {
      // Ignore send errors during disconnect
    }

    if (this.websocket) {
      this.websocket.close();
      this.websocket = null;
    }

    // Clean up any remaining header injection rules (normally already
    // consumed one-shot by the handler, but clear as a safety net)
    if (isElectron() && window.electron?.invoke) {
      this.clearElectronHeaders();
    } else if (isExtension()) {
      this.clearExtensionDNR();
    }

    this.isConnectedState = false;
    this.ttsChunks = [];

    // Close the decode AudioContext
    if (this.decodeContext) {
      try { this.decodeContext.close(); } catch (e) { /* ignore */ }
      this.decodeContext = null;
    }
    this.streamingTTSDecoder?.dispose().catch(() => {});
    this.streamingTTSDecoder = null;

    this.eventHandlers.onRealtimeEvent?.({
      source: 'client',
      event: {
        type: 'session.closed',
        data: {
          status: 'disconnected',
          provider: 'volcengine_ast2',
          timestamp: Date.now(),
          reason: 'client_disconnect'
        }
      }
    });

    this.eventHandlers.onClose?.({});
  }

  isConnected(): boolean {
    return this.isConnectedState && this.websocket?.readyState === WebSocket.OPEN;
  }

  updateSession(config: Partial<SessionConfig>): void {
    console.warn('[VolcengineAST2Client] Session updates are not supported. Reconnect to change configuration.');
  }

  reset(): void {
    this.stopKeepalive();
    this.clearReconnectTimers();
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this.sessionEverStarted = false;
    this.conversationItems = [];
    this.sequence = 0;
    this.currentSourceItemId = null;
    this.currentTranslationItemId = null;
    this.lastCompletedTranslationItemId = null;
    this.lastResponseSequence = -1;
    this.ttsSentenceTargetItemId = null;
    this.sessionStartedAt = 0;
    this.lastInputAudioSentAt = 0;
    this.ttsSentenceStartedAt = 0;
    this.firstTtsChunkReceivedAt = 0;
    this.streamingTTSDecoder?.dispose().catch(() => {});
    this.streamingTTSDecoder = null;
  }

  appendInputAudio(audioData: Int16Array): void {
    if (!this.isConnectedState) {
      return;
    }

    // Downsample 24kHz → 16kHz to match server expectation (linear interpolation)
    const downsampled = this.downsample24kTo16k(audioData);

    // Convert Int16Array to raw bytes for protobuf binary_data field
    const rawBytes = new Uint8Array(downsampled.buffer, downsampled.byteOffset, downsampled.byteLength);

    const request = TranslateRequest.encode({
      requestMeta: this.taskRequestMeta(),
      event: EventType.TaskRequest,
      sourceAudio: {
        binaryData: rawBytes,
      },
    }).finish();

    this.sendData(request);
    const sentAt = Date.now();
    this.lastAudioSentTime = sentAt;
    this.lastInputAudioSentAt = sentAt;
  }

  /**
   * Downsample 24kHz Int16 PCM to 16kHz using linear interpolation.
   * Ratio is 3:2 so every 3 input samples produce 2 output samples.
   */
  private downsample24kTo16k(input: Int16Array): Int16Array {
    const outputLength = Math.floor(input.length / DOWNSAMPLE_RATIO);
    const output = new Int16Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i * DOWNSAMPLE_RATIO;
      const lower = Math.floor(srcIndex);
      const upper = Math.min(lower + 1, input.length - 1);
      const frac = srcIndex - lower;
      output[i] = Math.round(input[lower] * (1 - frac) + input[upper] * frac);
    }
    return output;
  }

  appendInputText(text: string): void {
    console.warn('[VolcengineAST2Client] Text input is not supported for speech translation');
  }

  createResponse(config?: ResponseConfig): void {
    // Volcengine automatically generates responses when audio is received
  }

  cancelResponse(trackId?: string, offset?: number): void {
    console.warn('[VolcengineAST2Client] Cancel response is not supported');
  }

  getConversationItems(): ConversationItem[] {
    return [...this.conversationItems];
  }

  clearConversationItems(): void {
    this.conversationItems = [];
  }

  setEventHandlers(handlers: ClientEventHandlers): void {
    this.eventHandlers = { ...handlers };
  }

  getProvider(): ProviderType {
    return Provider.VOLCENGINE_AST2;
  }

  /**
   * Validate API credentials
   * In Electron: performs a real WebSocket connect-disconnect to verify credentials with the server.
   * In browser: format-only check (browser WebSocket API can't send custom headers).
   */
  static async validateApiKeyAndFetchModels(
    appId: string,
    accessToken: string
  ): Promise<{
    validation: ApiKeyValidationResult;
    models: FilteredModel[];
  }> {
    // Simple format validation — coerce to string since numeric IDs from storage may arrive as numbers
    const appIdStr = String(appId ?? '');
    const accessTokenStr = String(accessToken ?? '');
    if (!appIdStr || appIdStr.trim().length === 0) {
      return {
        validation: { valid: false, message: 'APP ID is required', validating: false },
        models: []
      };
    }
    const models: FilteredModel[] = [{
      id: 'ast-v2-s2s',
      type: 'realtime',
      created: Date.now() / 1000
    }];

    // Electron / Extension: real validation via header injection + WebSocket connect-disconnect
    if ((isElectron() && window.electron?.invoke) || isExtension()) {
      try {
        const connectionId = uuidv4();
        const host = new URL(WS_ENDPOINT).host;
        const platform = isElectron() ? 'electron' : 'extension';

        // Register headers for the validation WebSocket
        if (isElectron()) {
          const result = await window.electron.invoke('ws-headers-set', {
            host,
            headers: buildVolcengineAST2AuthHeaders(
              appIdStr,
              accessTokenStr,
              'volc.service_type.10053',
              connectionId
            ),
          });
          if (!result?.success) {
            return {
              validation: { valid: false, message: `Header setup failed: ${result?.error}`, validating: false },
              models: [],
            };
          }
        } else {
          // Extension: use DNR
          const dnrResult = await new Promise<{ success: boolean; error?: string }>((resolve) => {
            chrome!.runtime.sendMessage(
              {
                type: 'VOLCENGINE_AST2_SET_HEADERS',
                credentials: {
                  apiKey: appIdStr.trim(),
                  appKey: accessTokenStr.trim() ? appIdStr.trim() : undefined,
                  accessKey: accessTokenStr.trim() || undefined,
                  resourceId: 'volc.service_type.10053',
                  connectId: connectionId,
                },
              },
              (response: { success: boolean; error?: string }) => {
                if (chrome!.runtime.lastError) {
                  resolve({ success: false, error: chrome!.runtime.lastError.message });
                } else {
                  resolve(response || { success: false, error: 'No response' });
                }
              }
            );
          });

          if (!dnrResult.success) {
            return {
              validation: { valid: false, message: `DNR setup failed: ${dnrResult.error}`, validating: false },
              models: [],
            };
          }
        }

        // Try to connect a WebSocket — headers will be injected by the platform layer
        const validationResult = await new Promise<{ valid: boolean; message: string }>((resolve) => {
          const timeout = setTimeout(() => {
            ws.close();
            resolve({ valid: false, message: 'Connection timeout' });
          }, 8000);

          const ws = new WebSocket(WS_ENDPOINT);
          ws.binaryType = 'arraybuffer';

          ws.onopen = () => {
            // Connection accepted — server recognized the auth headers
            clearTimeout(timeout);

            // Send a minimal StartSession to fully verify credentials
            const sessionId = uuidv4();
            const startReq = TranslateRequest.encode({
              requestMeta: {
                Endpoint: 'volc.service_type.10053',
                ...(accessTokenStr.trim() ? { AppKey: appIdStr.trim() } : {}),
                ResourceID: 'volc.service_type.10053',
                ConnectionID: connectionId,
                SessionID: sessionId,
                Sequence: 0,
              },
              event: EventType.StartSession,
              user: { uid: 'validation', platform },
              sourceAudio: { format: 'pcm', rate: INPUT_SAMPLE_RATE, bits: 16, channel: 1 },
              targetAudio: { format: 'ogg_opus', rate: OUTPUT_SAMPLE_RATE, bits: 16, channel: 1 },
              request: { mode: 's2s', sourceLanguage: 'zh', targetLanguage: 'en' },
            }).finish();
            ws.send(startReq);
          };

          ws.onmessage = (evt) => {
            try {
              const response = TranslateResponse.decode(new Uint8Array(evt.data as ArrayBuffer));
              const statusCode = response.responseMeta?.StatusCode;

              if (statusCode && statusCode !== 0 && statusCode !== 20000000) {
                clearTimeout(timeout);
                ws.close();
                resolve({ valid: false, message: response.responseMeta?.Message || `Error: ${statusCode}` });
              } else if (response.event === EventType.SessionStarted) {
                clearTimeout(timeout);
                // Send FinishSession then close
                const finishReq = TranslateRequest.encode({
                  requestMeta: { ConnectionID: connectionId, Sequence: 1 },
                  event: EventType.FinishSession,
                }).finish();
                ws.send(finishReq);
                setTimeout(() => ws.close(), 300);
                resolve({ valid: true, message: 'API credentials verified' });
              }
            } catch (e) {
              // Continue waiting for more messages
            }
          };

          ws.onerror = () => {
            clearTimeout(timeout);
            resolve({ valid: false, message: 'Connection failed — credentials may be invalid' });
          };
        });

        // Clean up header rules after validation
        if (isElectron()) {
          window.electron.invoke('ws-headers-clear', { host }).catch(() => {});
        } else {
          chrome!.runtime.sendMessage({ type: 'VOLCENGINE_AST2_CLEAR_HEADERS' });
        }

        return {
          validation: { ...validationResult, validating: false },
          models: validationResult.valid ? models : [],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Credential verification failed';
        return {
          validation: { valid: false, message, validating: false },
          models: [],
        };
      }
    }

    // Web fallback: format-only check (WebSocket API can't send custom headers)
    return {
      validation: {
        valid: true,
        message: 'Credentials format valid (will be verified on connection)',
        validating: false,
      },
      models,
    };
  }
}
