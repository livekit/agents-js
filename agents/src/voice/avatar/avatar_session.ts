// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Room } from '@livekit/rtc-node';
import { RoomEvent, TrackKind } from '@livekit/rtc-node';
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import { RoomServiceClient } from 'livekit-server-sdk';
import { EventEmitter } from 'node:events';
import { getJobContext } from '../../job.js';
import { log } from '../../log.js';
import type { AvatarMetrics } from '../../metrics/base.js';
import { waitForParticipant, waitForTrackPublication } from '../../utils.js';
import type { AgentSession } from '../agent_session.js';
import {
  AgentSessionEventTypes,
  type ConversationItemAddedEvent,
  createMetricsCollectedEvent,
} from '../events.js';

export type AvatarSessionCallbacks = {
  metrics_collected: (metrics: AvatarMetrics) => void;
};

/**
 * Base class for avatar plugin sessions.
 *
 * Plugin implementations should extend this class and call `super.start(agentSession, room)`
 * first in their own `start()` method. The base:
 * - Registers {@link AvatarSession.aclose} as a job shutdown callback, so avatar resources
 *   are released when the job shuts down.
 * - Warns when the avatar session is started after {@link AgentSession.start} — in that
 *   case the existing audio output will be replaced by the avatar's.
 */
export class AvatarSession extends (EventEmitter as new () => TypedEmitter<AvatarSessionCallbacks>) {
  #logger = log();
  #agentSession?: AgentSession;
  #room?: Room;
  #waitAvatarJoinAbort?: AbortController;
  #waitAvatarJoinPromise?: Promise<void>;

  get avatarIdentity(): string {
    return 'unknown';
  }

  get provider(): string {
    return 'unknown';
  }

  /**
   * Start the avatar session.
   *
   * Subclasses should override this method and call `super.start(agentSession, room)` at the
   * top of their implementation. Subclasses may widen the return type (e.g. returning a
   * session id), matching the `# type: ignore[override]` escape hatch used in Python.
   */
  async start(agentSession: AgentSession, room: Room): Promise<unknown> {
    const jobCtx = getJobContext(false);
    if (jobCtx !== undefined) {
      jobCtx.addShutdownCallback(() => this.aclose());
    } else {
      this.#logger.debug(
        'AvatarSession started outside a job context; call aclose() manually to ' +
          'release resources when the job shuts down',
      );
    }

    const audioOutput = agentSession.output.audio;
    if (agentSession._started && audioOutput !== null) {
      this.#logger.warn(
        { audioOutput: audioOutput.constructor.name },
        'AvatarSession.start() was called after AgentSession.start(); ' +
          'the existing audio output may be replaced by the avatar. ' +
          'Please start the avatar session before AgentSession.start() to avoid this.',
      );
    }

    this.#agentSession = agentSession;
    this.#room = room;
    this.#agentSession.on(
      AgentSessionEventTypes.ConversationItemAdded,
      this.#onConversationItemAdded,
    );

    if (room.isConnected) {
      this.#startWaitAvatarJoin();
    } else {
      room.on(RoomEvent.ConnectionStateChanged, this.#onConnectionStateChanged);
    }
    return undefined;
  }

  /**
   * Wait until the avatar participant has joined the room and published its video track.
   *
   * @param timeout - Timeout in milliseconds. Pass `null` to wait indefinitely.
   */
  async waitForJoin({ timeout = 30000 }: { timeout?: number | null } = {}): Promise<void> {
    if (!this.#waitAvatarJoinPromise) return;
    if (timeout === null) {
      await this.#waitAvatarJoinPromise;
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.#waitAvatarJoinPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('timed out waiting for avatar participant')),
          timeout,
        );
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /**
   * Release any resources owned by this avatar session. Default implementation is a no-op;
   * subclasses can override to perform cleanup.
   */
  async aclose(): Promise<void> {
    const roomName = this.#room?.name;
    if (this.#room?.isConnected && roomName !== undefined) {
      const jobCtx = getJobContext(false);
      if (jobCtx !== undefined) {
        try {
          const client = new RoomServiceClient(
            jobCtx.info.url,
            jobCtx.info.apiKey,
            jobCtx.info.apiSecret,
          );
          await client.removeParticipant(roomName, this.avatarIdentity);
        } catch (error) {
          if (isTwirpNotFoundError(error)) {
            this.#logger.debug(
              { identity: this.avatarIdentity },
              'avatar participant not in room, skipping removal',
            );
          } else {
            this.#logger.warn(
              { 'lk.pii.error': error, identity: this.avatarIdentity },
              'failed to remove avatar participant',
            );
          }
        }
      }
    }

    if (this.#agentSession) {
      this.#agentSession.off(
        AgentSessionEventTypes.ConversationItemAdded,
        this.#onConversationItemAdded,
      );
      this.#agentSession = undefined;
    }

    if (this.#room) {
      this.#room.off(RoomEvent.ConnectionStateChanged, this.#onConnectionStateChanged);
      this.#room = undefined;
    }

    this.#waitAvatarJoinAbort?.abort();
    if (this.#waitAvatarJoinPromise) {
      await this.#waitAvatarJoinPromise;
      this.#waitAvatarJoinPromise = undefined;
    }
    this.#waitAvatarJoinAbort = undefined;
  }

  #startWaitAvatarJoin() {
    if (this.#waitAvatarJoinPromise) return;
    if (this.avatarIdentity === 'unknown') {
      this.#logger.warn('cannot wait for avatar join; avatar identity is unknown');
      return;
    }

    const abortController = new AbortController();
    this.#waitAvatarJoinAbort = abortController;
    this.#waitAvatarJoinPromise = this.#waitAvatarJoin(abortController.signal).catch((error) => {
      if (!abortController.signal.aborted) {
        this.#logger.warn({ 'lk.pii.error': error }, 'failed while waiting for avatar participant');
      }
    });
  }

  async #waitAvatarJoin(signal: AbortSignal): Promise<void> {
    const room = this.#room;
    if (!room) return;

    const startedAt = Date.now();
    await waitForParticipant({
      room,
      identity: this.avatarIdentity,
      includeLocal: true,
      signal,
    });
    await waitForTrackPublication({
      room,
      identity: this.avatarIdentity,
      kind: TrackKind.KIND_VIDEO,
      includeLocal: true,
      signal,
    });
    const joinedAt = Date.now();
    this.#emitMetrics({
      type: 'avatar_metrics',
      timestamp: joinedAt,
      sessionStartedAt: startedAt,
      avatarJoinedAt: joinedAt,
      metadata: { modelProvider: this.provider },
    });
  }

  #onConversationItemAdded = (ev: ConversationItemAddedEvent) => {
    const { item } = ev;
    if (item.type !== 'message' || item.role !== 'assistant') return;

    const { playbackLatency } = item.metrics;
    if (playbackLatency === undefined) return;

    this.#emitMetrics({
      type: 'avatar_metrics',
      timestamp: ev.createdAt,
      playbackLatencyMs: playbackLatency * 1000,
      metadata: { modelProvider: this.provider },
    });
  };

  #onConnectionStateChanged = () => {
    if (this.#room?.isConnected) {
      this.#startWaitAvatarJoin();
    }
  };

  #emitMetrics(metrics: AvatarMetrics) {
    this.emit('metrics_collected', metrics);
    this.#agentSession?.emit(
      AgentSessionEventTypes.MetricsCollected,
      createMetricsCollectedEvent({ metrics }),
    );
  }
}

function isTwirpNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'not_found'
  );
}
