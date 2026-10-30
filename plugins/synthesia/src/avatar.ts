// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { DEFAULT_API_CONNECT_OPTIONS, getJobContext, voice } from '@livekit/agents';
import type { RemoteParticipant, RemoteTrackPublication, Room } from '@livekit/rtc-node';
import { RoomEvent, TrackKind } from '@livekit/rtc-node';
import type { VideoGrant } from 'livekit-server-sdk';
import { AccessToken } from 'livekit-server-sdk';
import { SynthesiaAPI, errorName, requireSecureApiUrl } from './api.js';
import { ErrorType, SynthesiaError } from './errors.js';
import { log } from './log.js';
import {
  AVATAR_IDENTITY,
  AVATAR_NAME,
  type AvatarConfig,
  DEFAULT_API_URL,
  DEFAULT_JOIN_TIMEOUT,
  DEFAULT_SWAP_TIMEOUT,
  TOKEN_TTL,
} from './types.js';

const ATTRIBUTE_PUBLISH_ON_BEHALF = 'lk.publish_on_behalf';

enum State {
  IDLE,
  STARTED,
  CLOSED,
}

/** Options for configuring an AvatarSession. @public */
export interface AvatarSessionOptions {
  /** Synthesia API key. Falls back to `SYNTHESIA_API_KEY`. */
  apiKey?: string | null;
  /** Synthesia API URL. Falls back to `SYNTHESIA_API_URL`. */
  apiUrl?: string | null;
  /** Maximum time in milliseconds to wait for the avatar to join. */
  joinTimeout?: number;
  /** Identity for the avatar participant. */
  avatarParticipantIdentity?: string | null;
  /** Display name for the avatar participant. */
  avatarParticipantName?: string | null;
}

/** Optional LiveKit credentials for {@link AvatarSession.start}. @public */
export interface StartOptions {
  livekitUrl?: string | null;
  livekitApiKey?: string | null;
  livekitApiSecret?: string | null;
  /** Wait for the avatar to join before returning. */
  waitForAvatar?: boolean;
}

/**
 * A Synthesia interactive avatar for a LiveKit voice agent.
 *
 * By default, {@link AvatarSession.start} returns once the avatar has joined the room. Set
 * `waitForAvatar` to `false` to return as soon as the audio output is installed and finish the
 * launch in the background. Call {@link AvatarSession.waitUntilReady} to wait for the avatar and
 * surface a failed background launch.
 *
 * @public
 */
export class AvatarSession extends voice.AvatarSession {
  private avatarIds: readonly string[];
  #apiKey: string;
  private apiUrl: string;
  private joinTimeout: number;
  private avatarParticipantIdentity: string;
  private avatarParticipantName: string;
  private state = State.IDLE;
  private starting = false;
  private room?: Room;
  private sessionIdValue: string | null = null;
  private agentSession?: voice.AgentSession;
  private audioOutput?: voice.DataStreamAudioOutput;
  private previousAudio: voice.AudioOutput | null = null;
  private closePromise?: Promise<void>;
  private teardownPromise?: Promise<void>;
  private launchPromise?: Promise<void>;
  private launchError?: SynthesiaError;
  private launchAbort?: AbortController;
  private launchInProgress = false;

  constructor(avatarConfig: AvatarConfig, options: AvatarSessionOptions = {}) {
    super();
    if (options.avatarParticipantIdentity !== undefined) {
      requirePresent(options.avatarParticipantIdentity, 'avatarParticipantIdentity');
    }
    if (options.avatarParticipantName !== undefined) {
      requirePresent(options.avatarParticipantName, 'avatarParticipantName');
    }
    const apiKey = options.apiKey ?? process.env.SYNTHESIA_API_KEY;
    if (!apiKey) {
      throw new SynthesiaError(
        'a Synthesia API key is required: pass apiKey or set SYNTHESIA_API_KEY',
      );
    }
    this.avatarIds = [...avatarConfig.avatarIds];
    this.#apiKey = apiKey;
    this.apiUrl = requireSecureApiUrl(
      options.apiUrl ?? process.env.SYNTHESIA_API_URL ?? DEFAULT_API_URL,
    );
    this.joinTimeout = options.joinTimeout ?? DEFAULT_JOIN_TIMEOUT;
    this.avatarParticipantIdentity = options.avatarParticipantIdentity ?? AVATAR_IDENTITY;
    this.avatarParticipantName = options.avatarParticipantName ?? AVATAR_NAME;
  }

  override get avatarIdentity(): string {
    return this.avatarParticipantIdentity;
  }

  override get provider(): string {
    return 'synthesia';
  }

  /** Synthesia session ID after provisioning succeeds, otherwise `null`. */
  get sessionId(): string | null {
    return this.sessionIdValue;
  }

  async start(
    agentSession: voice.AgentSession,
    room: Room,
    options: StartOptions = {},
  ): Promise<void> {
    if (this.starting || this.launchInProgress) {
      throw new SynthesiaError('start() is already in progress');
    }
    this.starting = true;
    try {
      if (this.closePromise) {
        try {
          await this.closePromise;
        } catch (cause) {
          throw new SynthesiaError(
            'the previous avatar session did not tear down cleanly; not restarting',
            { cause },
          );
        }
        this.closePromise = undefined;
        this.teardownPromise = undefined;
      }
      if (this.state === State.STARTED) return;

      const livekitUrl = options.livekitUrl ?? process.env.LIVEKIT_URL;
      const livekitApiKey = options.livekitApiKey ?? process.env.LIVEKIT_API_KEY;
      const livekitApiSecret = options.livekitApiSecret ?? process.env.LIVEKIT_API_SECRET;
      if (![livekitUrl, livekitApiKey, livekitApiSecret].every(isPresent)) {
        throw new SynthesiaError(
          'LiveKit url, API key, and API secret are required: pass them or set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET',
        );
      }
      const normalizedUrl = toWebSocketUrl(livekitUrl!);
      if (!normalizedUrl.startsWith('ws://') && !normalizedUrl.startsWith('wss://')) {
        throw new SynthesiaError(
          `livekitUrl ${JSON.stringify(normalizedUrl)} is not a ws:// or wss:// URL`,
        );
      }

      this.state = State.IDLE;
      this.room = room;
      this.launchPromise = undefined;
      this.launchError = undefined;
      this.launchAbort = undefined;
      try {
        await super.start(agentSession, room);
        const api = new SynthesiaAPI({ apiKey: this.#apiKey, apiUrl: this.apiUrl });
        const request = {
          avatarIds: this.avatarIds,
          livekitUrl: normalizedUrl,
          livekitToken: await this.mintToken(room, livekitApiKey!, livekitApiSecret!),
        };
        const connOptions = {
          ...DEFAULT_API_CONNECT_OPTIONS,
          timeoutMs: this.joinTimeout,
          maxRetry: 0,
        };
        if (options.waitForAvatar === false) {
          this.installAudioOutput(agentSession, room);
          const controller = new AbortController();
          this.launchAbort = controller;
          this.launchInProgress = true;
          this.launchPromise = Promise.resolve().then(() =>
            this.launchInBackground(
              api,
              request,
              connOptions,
              agentSession,
              room,
              controller.signal,
            ),
          );
          return;
        }
        await this.launch(api, request, connOptions, agentSession, room);
      } catch (error) {
        await this.aclose().catch(() => undefined);
        await this.discardPartialStart();
        if (error instanceof JoinTimeoutError) {
          throw new SynthesiaError(`avatar did not join within ${this.joinTimeout}ms`, {
            type: ErrorType.TIMEOUT,
            cause: error,
          });
        }
        throw error;
      }

      await this.finishStart(room);
    } finally {
      this.starting = false;
    }
  }

  /**
   * Wait until the avatar has joined the room. A failed background launch raises the same
   * {@link SynthesiaError} that a blocking {@link AvatarSession.start} would have raised. The
   * agent's audio may remain routed to the avatar until the agent session ends, so end or restart
   * the session when this method rejects.
   */
  async waitUntilReady(): Promise<void> {
    if (this.launchPromise) {
      await this.launchPromise;
      if (this.launchError) throw this.launchError;
      return;
    }
    if (this.state !== State.STARTED) {
      throw new SynthesiaError('the avatar session is not started');
    }
  }

  private installAudioOutput(agentSession: voice.AgentSession, room: Room): void {
    const audioOutput = new voice.DataStreamAudioOutput({
      room,
      destinationIdentity: this.avatarIdentity,
      waitRemoteTrack: TrackKind.KIND_VIDEO,
    });
    this.agentSession = agentSession;
    this.previousAudio = agentSession.output.audio;
    agentSession.output.audio = audioOutput;
    this.audioOutput = audioOutput;
  }

  private async launch(
    api: SynthesiaAPI,
    request: Parameters<SynthesiaAPI['startSession']>[0],
    connOptions: Parameters<SynthesiaAPI['startSession']>[1],
    agentSession: voice.AgentSession,
    room: Room,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw new LaunchCancelledError();
    const response = await raceWithAbort(api.startSession(request, connOptions, signal), signal);
    this.sessionIdValue = response.sessionId;
    if (!this.audioOutput) this.installAudioOutput(agentSession, room);
    if (signal?.aborted) throw new LaunchCancelledError();
    await raceWithAbort(this.waitForJoinWithin(this.joinTimeout), signal);
  }

  private async finishStart(room: Room): Promise<void> {
    if (this.isClosed()) {
      await this.closePromise;
      await this.discardPartialStart();
      throw new SynthesiaError('avatar session was closed while starting');
    }
    room.on(RoomEvent.Disconnected, this.onRoomDisconnected);
    room.on(RoomEvent.TrackUnpublished, this.onTrackUnpublished);
    room.on(RoomEvent.ParticipantDisconnected, this.onParticipantDisconnected);
    this.state = State.STARTED;
  }

  private async launchInBackground(
    api: SynthesiaAPI,
    request: Parameters<SynthesiaAPI['startSession']>[0],
    connOptions: Parameters<SynthesiaAPI['startSession']>[1],
    agentSession: voice.AgentSession,
    room: Room,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.launch(api, request, connOptions, agentSession, room, signal);
      await this.finishStart(room);
    } catch (error) {
      if (signal.aborted || error instanceof LaunchCancelledError) {
        this.launchError = new SynthesiaError('avatar session was closed while starting');
        return;
      }
      const failure =
        error instanceof JoinTimeoutError
          ? new SynthesiaError(`avatar did not join within ${this.joinTimeout}ms`, {
              type: ErrorType.TIMEOUT,
              cause: error,
            })
          : error instanceof SynthesiaError
            ? error
            : new SynthesiaError(`avatar failed to start: ${String(error)}`, { cause: error });
      this.launchError = failure;
      log().error(
        {
          error: errorClassName(error),
          type: failure.type,
          status: failure.status,
          requestId: failure.requestId,
        },
        'avatar failed to start',
      );
      await this.closeAfterLaunchFailure();
      await this.discardPartialStart();
    } finally {
      this.launchInProgress = false;
    }
  }

  private async closeAfterLaunchFailure(): Promise<void> {
    this.state = State.CLOSED;
    this.sessionIdValue = null;
    this.closePromise ??= this.closeImpl();
    await this.closePromise.catch(() => undefined);
  }

  /** Switch the rendered avatar during a started session. */
  async swapAvatar(avatarId: string, { timeout = DEFAULT_SWAP_TIMEOUT } = {}): Promise<string> {
    if (this.state !== State.STARTED || this.teardownPromise || !this.room) {
      throw new SynthesiaError('swapAvatar() requires a started avatar session');
    }
    if (avatarId !== 'default' && !this.avatarIds.includes(avatarId)) {
      throw new SynthesiaError(`avatar ${JSON.stringify(avatarId)} was not in initial avatarIds`, {
        type: ErrorType.UNKNOWN_AVATAR,
      });
    }

    let raw: string;
    try {
      raw = await this.room.localParticipant!.performRpc({
        destinationIdentity: this.avatarIdentity,
        method: 'swapAvatar',
        payload: JSON.stringify({ avatar_id: avatarId }),
        responseTimeout: timeout,
      });
    } catch (error) {
      // the RPC error can carry provider content, so only its name and code are surfaced
      const code = isRecord(error) && typeof error.code === 'number' ? ` (code ${error.code})` : '';
      throw new SynthesiaError(`avatar swap RPC failed: ${errorName(error)}${code}`, {
        type: ErrorType.CONNECTION,
      });
    }

    let response: unknown;
    try {
      response = JSON.parse(raw) as unknown;
    } catch {
      throw new SynthesiaError('avatar swap returned a malformed response');
    }
    const result = isRecord(response) ? response.avatar_id : undefined;
    if (!isRecord(response) || response.error || typeof result !== 'string') {
      if (isRecord(response) && response.error) {
        // the worker's error text is provider content, so it only goes to a redactable field
        log().warn({ 'lk.pii.error': String(response.error) }, 'avatar swap failed');
        throw new SynthesiaError('avatar swap failed');
      }
      throw new SynthesiaError('avatar swap returned an unrecognized response');
    }
    return result;
  }

  override async aclose(): Promise<void> {
    if (this.closePromise) {
      await this.closePromise.catch(() => undefined);
      return;
    }
    this.state = State.CLOSED;
    this.sessionIdValue = null;
    this.launchAbort?.abort();
    this.closePromise = this.closeImpl();
    try {
      await this.closePromise;
    } finally {
      await this.launchPromise;
    }
  }

  private async closeImpl(): Promise<void> {
    // every stage runs even if an earlier one fails; the first failure is rethrown at the end
    let failure: unknown;
    const attempt = async (stage: () => Promise<void> | void) => {
      try {
        await stage();
      } catch (error) {
        failure ??= error;
      }
    };
    await attempt(() => this.releaseAudioOutput());
    const room = this.room;
    if (room) {
      room.off(RoomEvent.Disconnected, this.onRoomDisconnected);
      room.off(RoomEvent.TrackUnpublished, this.onTrackUnpublished);
      room.off(RoomEvent.ParticipantDisconnected, this.onParticipantDisconnected);
    }
    await attempt(() => super.aclose());
    this.room = undefined;
    if (failure !== undefined) throw failure;
  }

  private async discardPartialStart(): Promise<void> {
    this.releaseAudioOutput();
    this.sessionIdValue = null;
  }

  /**
   * Detach the avatar output from the agent session. Segments it can no longer report are
   * settled as interrupted so pending playout waits finish, and the sink it replaced is restored
   * so later speech keeps playing.
   */
  private releaseAudioOutput(): void {
    const audioOutput = this.audioOutput;
    const previous = this.previousAudio;
    const output = this.agentSession?.output;
    this.audioOutput = undefined;
    this.previousAudio = null;
    this.agentSession = undefined;
    if (!audioOutput) return;
    while (audioOutput.pendingPlayoutSegments > 0) {
      audioOutput.onPlaybackFinished({ playbackPosition: 0, interrupted: true });
    }
    if (output?.audio === audioOutput) output.audio = previous;
  }

  /** The timer lives here so a join timeout is told apart by type, not by the base's message. */
  private async waitForJoinWithin(timeout: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.waitForJoin({ timeout: null }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new JoinTimeoutError()), timeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async mintToken(room: Room, apiKey: string, apiSecret: string): Promise<string> {
    const jobContext = getJobContext(false);
    const agentIdentity =
      jobContext?.agent?.identity ??
      room.localParticipant?.identity ??
      jobContext?.info.acceptArguments.identity;
    if (!isPresent(agentIdentity)) {
      throw new SynthesiaError(
        "the room's local participant has no identity; connect the room before starting the avatar session",
      );
    }
    const roomName = room.name || jobContext?.job.room?.name;
    if (!isPresent(roomName)) {
      throw new SynthesiaError(
        'failed to get room name; connect the room before starting outside a job context',
      );
    }
    const token = new AccessToken(apiKey, apiSecret, {
      identity: this.avatarIdentity,
      name: this.avatarParticipantName,
      ttl: TOKEN_TTL,
    });
    token.kind = 'agent';
    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    } as VideoGrant);
    token.attributes = { [ATTRIBUTE_PUBLISH_ON_BEHALF]: agentIdentity };
    return token.toJwt();
  }

  private onRoomDisconnected = () => {
    if (this.teardownPromise || this.state === State.CLOSED) return;
    log().info('avatar session ended');
    this.beginTeardown();
  };

  private onTrackUnpublished = (
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    if (participant.identity === this.avatarIdentity && publication.kind === TrackKind.KIND_VIDEO) {
      this.reportAvatarLost();
    }
  };

  private onParticipantDisconnected = (participant: RemoteParticipant) => {
    if (participant.identity === this.avatarIdentity) this.reportAvatarLost();
  };

  private reportAvatarLost() {
    if (this.teardownPromise || this.state === State.CLOSED || !this.room?.isConnected) return;
    log().warn('avatar left the room unexpectedly');
    this.beginTeardown();
  }

  private beginTeardown() {
    if (this.teardownPromise || this.state === State.CLOSED) return;
    this.teardownPromise = this.aclose();
    void this.teardownPromise.catch((error) =>
      log().error(
        { errorType: errorName(error), 'lk.pii.error': String(error) },
        'avatar teardown failed',
      ),
    );
  }

  private isClosed(): boolean {
    return this.state === State.CLOSED;
  }
}

function isPresent(value: string | null | undefined): value is string {
  return Boolean(value?.trim());
}

function requirePresent(value: string | null, name: string): asserts value is string {
  if (!isPresent(value)) throw new SynthesiaError(`${name} must be a non-empty string`);
}

function toWebSocketUrl(url: string): string {
  if (url.startsWith('https://')) return 'wss://' + url.slice('https://'.length);
  if (url.startsWith('http://')) return 'ws://' + url.slice('http://'.length);
  return url;
}

class JoinTimeoutError extends Error {
  constructor() {
    super('timed out waiting for avatar participant');
    this.name = 'JoinTimeoutError';
  }
}

class LaunchCancelledError extends Error {}

async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw new LaunchCancelledError();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new LaunchCancelledError());
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorClassName(value: unknown): string {
  return value instanceof Error ? value.constructor.name : typeof value;
}
