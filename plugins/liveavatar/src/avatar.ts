// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  DEFAULT_API_CONNECT_OPTIONS,
  Future,
  getJobContext,
  shortuuid,
  stream as streamNs,
  voice,
} from '@livekit/agents';
import { type AudioFrame, AudioResampler, type Room } from '@livekit/rtc-node';
import type { VideoGrant } from 'livekit-server-sdk';
import { AccessToken } from 'livekit-server-sdk';
import { type RawData, WebSocket } from 'ws';
import { LiveAvatarAPI, LiveAvatarException, type VideoQuality } from './api.js';
import { log } from './log.js';

const ATTRIBUTE_PUBLISH_ON_BEHALF = 'lk.publish_on_behalf';
const SAMPLE_RATE = 24000;
const KEEP_ALIVE_INTERVAL_MS = 60_000;
const FIRST_CHUNK_THRESHOLD_MS = 600;
const SUBSEQUENT_CHUNK_THRESHOLD_MS = 1_000;
const AVATAR_AGENT_IDENTITY = 'liveavatar-avatar-agent';
const AVATAR_AGENT_NAME = 'liveavatar-avatar-agent';

/**
 * Options for configuring an AvatarSession.
 *
 * Ref: python livekit-plugins/livekit-plugins-liveavatar/livekit/plugins/liveavatar/avatar.py - 47-58 lines
 */
export interface AvatarSessionOptions {
  /** The LiveAvatar avatar id. Falls back to the `LIVEAVATAR_AVATAR_ID` env var. */
  avatarId?: string;
  /** Override the LiveAvatar API base URL. */
  apiUrl?: string;
  /** LiveAvatar API key. Falls back to the `LIVEAVATAR_API_KEY` env var. */
  apiKey?: string;
  /** When true, use the LiveAvatar sandbox (1 minute connection limit). */
  isSandbox?: boolean;
  /** Avatar video quality. When omitted, the LiveAvatar service decides. */
  videoQuality?: VideoQuality;
  /** Identity for the avatar participant. Defaults to `liveavatar-avatar-agent`. */
  avatarParticipantIdentity?: string;
  /** Display name for the avatar participant. Defaults to `liveavatar-avatar-agent`. */
  avatarParticipantName?: string;
  /** API retry/timeout options. */
  connOptions?: APIConnectOptions;
}

/**
 * Optional LiveKit credentials for {@link AvatarSession.start}; falls back to env vars.
 */
export interface StartOptions {
  livekitUrl?: string;
  livekitApiKey?: string;
  livekitApiSecret?: string;
}

/**
 * A LiveAvatar interactive avatar session.
 *
 * This class manages the connection between a LiveKit agent and a LiveAvatar avatar:
 * it brings up a LiveAvatar streaming session, opens the realtime websocket, captures
 * the agent's audio output, and forwards it (resampled, base64-encoded) to the avatar
 * service. Inbound websocket events drive playback start/finish notifications back into
 * the agent session so the speech handle can complete correctly.
 *
 * @example
 * ```typescript
 * const avatar = new AvatarSession({
 *   avatarId: 'your-avatar-id',
 *   apiKey: process.env.LIVEAVATAR_API_KEY,
 *   videoQuality: 'high',
 * });
 * await avatar.start(agentSession, room);
 * ```
 *
 * Ref: python livekit-plugins/livekit-plugins-liveavatar/livekit/plugins/liveavatar/avatar.py
 */
export class AvatarSession {
  private avatarId: string | null;
  private apiUrl?: string;
  private apiKey: string;
  private isSandbox: boolean;
  private videoQuality: VideoQuality | null;
  private avatarParticipantIdentity: string;
  private avatarParticipantName: string;
  private connOptions: APIConnectOptions;

  private api: LiveAvatarAPI;
  private sessionId: string | null = null;
  private sessionToken: string | null = null;
  private wsUrl: string | null = null;

  private audioBuffer?: voice.QueueAudioOutput;
  private msgChannel?: streamNs.StreamChannel<Record<string, unknown>>;
  private msgChannelClosed = false;
  private mainTaskPromise?: Promise<void>;
  private agentSession?: voice.AgentSession;
  private room?: Room;
  private localParticipantIdentity = '';

  private audioResampler: AudioResampler | null = null;
  private resamplerInputRate: number | null = null;

  private audioPlaying = false;
  private avatarSpeaking = false;
  private avatarInterrupted = false;
  private playbackPosition = 0;
  private sessionConnectedFuture: Future<void> = new Future();
  private chunkInterrupted = false;
  private closing = false;

  #logger = log();

  constructor(options: AvatarSessionOptions = {}) {
    this.avatarId = options.avatarId ?? process.env.LIVEAVATAR_AVATAR_ID ?? null;
    this.apiUrl = options.apiUrl;
    this.apiKey = options.apiKey ?? process.env.LIVEAVATAR_API_KEY ?? '';
    this.isSandbox = options.isSandbox ?? false;
    // Ref: python livekit-plugins/livekit-plugins-liveavatar/livekit/plugins/liveavatar/avatar.py - 75 line
    this.videoQuality = options.videoQuality ?? null;
    this.avatarParticipantIdentity = options.avatarParticipantIdentity || AVATAR_AGENT_IDENTITY;
    this.avatarParticipantName = options.avatarParticipantName || AVATAR_AGENT_NAME;
    this.connOptions = options.connOptions || DEFAULT_API_CONNECT_OPTIONS;

    this.api = new LiveAvatarAPI({
      apiKey: this.apiKey,
      apiUrl: this.apiUrl,
      connOptions: this.connOptions,
    });
  }

  /**
   * Start the avatar session and wire it into the agent session's audio output.
   *
   * Ref: python livekit-plugins/livekit-plugins-liveavatar/livekit/plugins/liveavatar/avatar.py - 89-178 lines
   */
  async start(
    agentSession: voice.AgentSession,
    room: Room,
    options: StartOptions = {},
  ): Promise<void> {
    this.agentSession = agentSession;
    this.room = room;

    const livekitUrl = options.livekitUrl || process.env.LIVEKIT_URL;
    const livekitApiKey = options.livekitApiKey || process.env.LIVEKIT_API_KEY;
    const livekitApiSecret = options.livekitApiSecret || process.env.LIVEKIT_API_SECRET;
    if (!livekitUrl || !livekitApiKey || !livekitApiSecret) {
      throw new LiveAvatarException(
        'livekit_url, livekit_api_key, and livekit_api_secret must be set',
      );
    }

    // Ref: python livekit-plugins/livekit-plugins-liveavatar/livekit/plugins/liveavatar/avatar.py - 109-115 lines
    try {
      const jobCtx = getJobContext();
      this.localParticipantIdentity = jobCtx.agent?.identity || '';
      if (!this.localParticipantIdentity && room.localParticipant) {
        this.localParticipantIdentity = room.localParticipant.identity;
      }
    } catch {
      if (!room.isConnected || !room.localParticipant) {
        throw new LiveAvatarException('failed to get local participant identity');
      }
      this.localParticipantIdentity = room.localParticipant.identity;
    }
    if (!this.localParticipantIdentity) {
      throw new LiveAvatarException('failed to get local participant identity');
    }

    // Ref: python livekit-plugins/livekit-plugins-liveavatar/livekit/plugins/liveavatar/avatar.py - 117-128 lines
    const at = new AccessToken(livekitApiKey, livekitApiSecret, {
      identity: this.avatarParticipantIdentity,
      name: this.avatarParticipantName,
    });
    at.kind = 'agent';
    at.attributes = { [ATTRIBUTE_PUBLISH_ON_BEHALF]: this.localParticipantIdentity };
    at.addGrant({
      roomJoin: true,
      room: room.name,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      canUpdateOwnMetadata: true,
      canSubscribeMetrics: true,
    } as VideoGrant);

    const livekitToken = await at.toJwt();

    if (!this.avatarId) {
      throw new LiveAvatarException('avatar_id must be set');
    }

    // Ref: python livekit-plugins/livekit-plugins-liveavatar/livekit/plugins/liveavatar/avatar.py - 135-145 lines
    const sessionConfig = await this.api.createStreamingSession({
      livekitUrl,
      livekitToken,
      roomName: room.name ?? '',
      avatarId: this.avatarId,
      isSandbox: this.isSandbox,
      videoQuality: this.videoQuality,
    });
    this.sessionId = sessionConfig.data.session_id;
    this.sessionToken = sessionConfig.data.session_token;
    this.#logger.info({ sessionId: this.sessionId }, 'LiveAvatar session created');

    if (!this.sessionId || !this.sessionToken) {
      throw new LiveAvatarException('LiveAvatar session creation returned no session id/token');
    }

    const startData = await this.api.startStreamingSession(this.sessionId, this.sessionToken);
    this.wsUrl = startData.data.ws_url;
    this.#logger.info('LiveAvatar streaming session started');

    // Ref: python livekit-plugins/livekit-plugins-liveavatar/livekit/plugins/liveavatar/avatar.py - 158-164 lines
    this.msgChannel = streamNs.createStreamChannel<Record<string, unknown>>();
    agentSession.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      if (ev.newState === 'idle') {
        this.sendEvent({ type: 'agent.stop_listening', event_id: shortuuid() });
      }
    });
    agentSession.on(voice.AgentSessionEventTypes.Close, () => {
      this.closeMsgChannel();
    });

    // Ref: python livekit-plugins/livekit-plugins-liveavatar/livekit/plugins/liveavatar/avatar.py - 166-173 lines
    this.audioBuffer = new voice.QueueAudioOutput(SAMPLE_RATE);
    this.audioBuffer.on('clear_buffer', (ev: voice.QueueAudioOutputClearEvent) =>
      this.onClearBuffer(ev),
    );
    agentSession.output.audio = this.audioBuffer;

    // Spawn the main task with an attached error handler so a websocket open or
    // protocol failure does not surface as an unhandled rejection. The main task
    // itself handles its own cleanup in finally.
    this.mainTaskPromise = this.mainTask().catch((e) => {
      this.#logger.warn({ error: String(e) }, 'LiveAvatar main task failed');
    });

    // Best-effort cleanup on job shutdown.
    try {
      const jobCtx = getJobContext();
      jobCtx.addShutdownCallback(async () => {
        await this.aclose();
      });
    } catch {
      // No active job context — caller is expected to manage lifecycle.
    }
  }

  /**
   * Stop the avatar session, drain queues, and close the websocket.
   */
  async aclose(): Promise<void> {
    this.closing = true;
    this.closeMsgChannel();
    if (this.audioBuffer) {
      await this.audioBuffer.aclose();
    }
    if (this.mainTaskPromise) {
      try {
        await this.mainTaskPromise;
      } catch {
        // logged in mainTask
      }
    }
  }

  /**
   * Send an event over the websocket message queue.
   *
   * Ref: python livekit-plugins/livekit-plugins-liveavatar/livekit/plugins/liveavatar/avatar.py - 207-209 lines
   */
  sendEvent(msg: Record<string, unknown>): void {
    if (!this.msgChannel || this.msgChannelClosed) return;
    void this.msgChannel.write(msg).catch(() => {
      // channel closed — drop the event
    });
  }

  private closeMsgChannel(): void {
    if (this.msgChannel && !this.msgChannelClosed) {
      this.msgChannelClosed = true;
      void this.msgChannel.close().catch(() => {
        // ignore double-close
      });
    }
  }

  /**
   * Ref: python livekit-plugins/livekit-plugins-liveavatar/livekit/plugins/liveavatar/avatar.py - 180-196 lines
   *
   * Gates everything on the `wasCapturing` flag carried by the `clear_buffer`
   * event (set synchronously inside `QueueAudioOutput.clearBuffer`):
   *
   * 1. `notifyPlaybackFinished` only fires when a segment was actually in
   *    flight, so the base class's segment-count bookkeeping stays balanced
   *    even when an interrupt lands in the window between `super.captureFrame`
   *    incrementing `playbackSegmentsCount` and `forwardAudio` consuming the
   *    frame.
   * 2. `chunkInterrupted` is only flipped when there's an actual segment to
   *    interrupt. If `wasCapturing` is false (e.g. `clearBuffer` is called
   *    after `flush` has already written its `AudioSegmentEnd`), setting
   *    `chunkInterrupted` would otherwise carry over and discard the first
   *    frame of the *next* segment.
   */
  private onClearBuffer(ev: voice.QueueAudioOutputClearEvent): void {
    this.audioPlaying = false;
    if (!ev.wasCapturing) {
      return;
    }
    this.chunkInterrupted = true;
    if (this.audioBuffer) {
      this.audioBuffer.notifyPlaybackFinished(this.playbackPosition, true);
      if (this.avatarSpeaking) {
        this.sendEvent({ type: 'agent.interrupt', event_id: shortuuid() });
      }
      this.playbackPosition = 0;
    }
  }

  /**
   * Resample frame to {@link SAMPLE_RATE} mono. Mirrors the lazy resampler swap
   * in the Python plugin: when the input rate changes we discard the old resampler.
   *
   * Ref: python livekit-plugins/livekit-plugins-liveavatar/livekit/plugins/liveavatar/avatar.py - 198-216 lines
   */
  private *resampleAudio(frame: AudioFrame): IterableIterator<AudioFrame> {
    if (this.audioResampler && this.resamplerInputRate !== frame.sampleRate) {
      this.audioResampler.close();
      this.audioResampler = null;
      this.resamplerInputRate = null;
    }
    if (!this.audioResampler && (frame.sampleRate !== SAMPLE_RATE || frame.channels !== 1)) {
      this.audioResampler = new AudioResampler(frame.sampleRate, SAMPLE_RATE, 1);
      this.resamplerInputRate = frame.sampleRate;
    }
    if (this.audioResampler) {
      yield* this.audioResampler.push(frame);
    } else {
      yield frame;
    }
  }

  /**
   * Main task: opens the websocket and runs forward/send/recv/keep-alive loops.
   *
   * Ref: python livekit-plugins/livekit-plugins-liveavatar/livekit/plugins/liveavatar/avatar.py - 218-308 lines
   */
  private async mainTask(): Promise<void> {
    if (!this.wsUrl) {
      throw new LiveAvatarException('ws_url not set');
    }

    let ws: WebSocket | null = null;
    let resetKeepAlive = () => {};
    const closingResolver = new Future<void>();

    try {
      // Open the websocket inside the guarded section so DNS/TLS/network failures
      // are routed through the same cleanup path as runtime errors.
      const wsRef = new WebSocket(this.wsUrl);
      await new Promise<void>((resolve, reject) => {
        wsRef.once('open', resolve);
        wsRef.once('error', reject);
      });
      ws = wsRef;

      const forwardAudio = async (): Promise<void> => {
        if (!this.audioBuffer) return;
        await this.sessionConnectedFuture.await;

        let chunkBuf: Uint8Array[] = [];
        let chunkDurationMs = 0;
        let isFirstChunk = true;
        // True between an interrupt and the next AudioSegmentEnd: drops any
        // frames that were already queued from the interrupted segment so
        // they don't bleed into the next segment's first chunk.
        let interruptDraining = false;

        const flushChunk = () => {
          if (chunkBuf.length === 0) return;
          const total = chunkBuf.reduce((acc, c) => acc + c.length, 0);
          const merged = new Uint8Array(total);
          let offset = 0;
          for (const c of chunkBuf) {
            merged.set(c, offset);
            offset += c.length;
          }
          const encoded = Buffer.from(merged).toString('base64');
          this.sendEvent({ type: 'agent.speak', event_id: shortuuid(), audio: encoded });
          this.playbackPosition += chunkDurationMs / 1000;
          chunkBuf = [];
          chunkDurationMs = 0;
          isFirstChunk = false;
        };

        const discardChunk = () => {
          chunkBuf = [];
          chunkDurationMs = 0;
          isFirstChunk = true;
        };

        const reader = this.audioBuffer.stream().getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (this.chunkInterrupted) {
              this.chunkInterrupted = false;
              discardChunk();
              interruptDraining = true;
            }

            if (value instanceof voice.AudioSegmentEnd) {
              // The interrupted segment has fully drained; resume normal
              // operation for the next segment.
              interruptDraining = false;
              flushChunk();
              this.sendEvent({ type: 'agent.speak_end', event_id: shortuuid() });
              this.sendEvent({ type: 'agent.start_listening', event_id: shortuuid() });
              isFirstChunk = true;
              continue;
            }

            if (interruptDraining) {
              // Drop any frame from the interrupted segment that was already
              // sitting in the channel; they would otherwise leak into the
              // next segment's audio.
              continue;
            }

            if (!this.audioPlaying) {
              this.audioPlaying = true;
            }
            for (const resampled of this.resampleAudio(value)) {
              chunkBuf.push(new Uint8Array(resampled.data.buffer));
              const frameDurationMs = (resampled.samplesPerChannel / resampled.sampleRate) * 1000;
              chunkDurationMs += frameDurationMs;
              const thresholdMs = isFirstChunk
                ? FIRST_CHUNK_THRESHOLD_MS
                : SUBSEQUENT_CHUNK_THRESHOLD_MS;
              if (chunkDurationMs >= thresholdMs) {
                flushChunk();
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      };

      const sendTask = async (): Promise<void> => {
        if (!this.msgChannel) return;
        const reader = this.msgChannel.stream().getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            try {
              wsRef.send(JSON.stringify(value));
              resetKeepAlive();
            } catch (e) {
              this.#logger.warn({ error: String(e) }, 'failed to send LiveAvatar event');
              break;
            }
          }
        } finally {
          reader.releaseLock();
          try {
            wsRef.close();
          } catch {
            // ignore
          }
          this.closing = true;
          closingResolver.resolve();
        }
      };

      const recvTask = async (): Promise<void> => {
        const queue: RawData[] = [];
        let waiter: ((m: RawData) => void) | null = null;

        wsRef.on('message', (data: RawData) => {
          if (waiter) {
            const w = waiter;
            waiter = null;
            w(data);
          } else {
            queue.push(data);
          }
        });
        const closedFuture = new Future<void>();
        wsRef.on('close', () => closedFuture.resolve());
        wsRef.on('error', () => closedFuture.resolve());

        const nextMessage = (): Promise<RawData | null> =>
          new Promise((resolve) => {
            if (queue.length > 0) {
              resolve(queue.shift()!);
              return;
            }
            waiter = (m: RawData) => resolve(m);
            void closedFuture.await.then(() => {
              if (waiter) {
                waiter = null;
                resolve(null);
              }
            });
          });

        while (true) {
          const msg = await nextMessage();
          if (msg === null) {
            if (this.closing) return;
            if (this.isSandbox) {
              this.#logger.warn('The LiveAvatar Sandbox connection surpassed the 1 minute limit');
              return;
            }
            throw new APIConnectionError({
              message: 'LiveAvatar connection closed unexpectedly.',
            });
          }
          let parsed: { type?: string; state?: string };
          try {
            parsed = JSON.parse(msg.toString()) as { type?: string; state?: string };
          } catch {
            continue;
          }
          switch (parsed.type) {
            case 'session.state_updated':
              this.#logger.debug({ state: parsed.state }, 'LiveAvatar session state');
              if (parsed.state === 'connected') {
                if (!this.sessionConnectedFuture.done) {
                  this.sessionConnectedFuture.resolve();
                }
              }
              break;
            case 'agent.speak_interrupted':
              this.handleAgentSpeakInterrupted();
              break;
            case 'agent.speak_ended':
              this.handleAgentSpeakEnded();
              break;
            case 'agent.speak_started':
              this.handleAgentSpeakStarted();
              break;
            default:
              this.#logger.debug({ type: parsed.type }, 'Unhandled LiveAvatar event');
          }
        }
      };

      const keepAliveTask = async (): Promise<void> => {
        await this.sessionConnectedFuture.await;
        let timer: NodeJS.Timeout | null = null;
        const tick = () => {
          if (this.closing) return;
          this.sendEvent({ type: 'session.keep_alive', event_id: shortuuid() });
          timer = setTimeout(tick, KEEP_ALIVE_INTERVAL_MS);
        };
        timer = setTimeout(tick, KEEP_ALIVE_INTERVAL_MS);
        resetKeepAlive = () => {
          if (timer) clearTimeout(timer);
          if (!this.closing) {
            timer = setTimeout(tick, KEEP_ALIVE_INTERVAL_MS);
          }
        };
        await closingResolver.await;
        if (timer) clearTimeout(timer);
      };

      await Promise.race([forwardAudio(), sendTask(), recvTask(), keepAliveTask()]);
    } catch (e) {
      this.#logger.warn({ error: String(e) }, 'LiveAvatar main task error');
    } finally {
      this.closing = true;
      closingResolver.resolve();

      try {
        if (this.sessionId && this.sessionToken) {
          const data = await this.api.stopStreamingSession(this.sessionId, this.sessionToken);
          // Mirrors python livekit-plugins-liveavatar/.../avatar.py - 304 line
          if (data.code <= 200) {
            this.#logger.info({ sessionId: this.sessionId }, 'LiveAvatar session stopped');
          }
        }
      } catch (e) {
        this.#logger.warn({ error: String(e) }, 'Failed to stop LiveAvatar session');
      }

      if (this.audioBuffer) {
        await this.audioBuffer.aclose();
      }
      if (this.audioResampler) {
        try {
          this.audioResampler.close();
        } catch {
          // ignore
        }
        this.audioResampler = null;
      }
      if (ws) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * Ref: python livekit-plugins/livekit-plugins-liveavatar/livekit/plugins/liveavatar/avatar.py - 310-311 lines
   */
  private handleAgentSpeakInterrupted(): void {
    this.avatarInterrupted = true;
  }

  /**
   * Ref: python livekit-plugins/livekit-plugins-liveavatar/livekit/plugins/liveavatar/avatar.py - 313-322 lines
   */
  private handleAgentSpeakEnded(): void {
    this.avatarSpeaking = false;
    if (!this.avatarInterrupted && this.audioBuffer) {
      this.audioBuffer.notifyPlaybackFinished(this.playbackPosition, false);
      this.playbackPosition = 0;
      this.audioPlaying = false;
    }
  }

  /**
   * Ref: python livekit-plugins/livekit-plugins-liveavatar/livekit/plugins/liveavatar/avatar.py - 324-327 lines
   */
  private handleAgentSpeakStarted(): void {
    this.avatarSpeaking = true;
    this.avatarInterrupted = false;
    this.audioBuffer?.notifyPlaybackStarted();
  }
}
