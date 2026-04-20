// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Room } from '@livekit/rtc-node';
import { getJobContext } from '../../job.js';
import { log } from '../../log.js';
import type { AgentSession } from '../agent_session.js';

// Ref: python livekit-agents/livekit/agents/voice/avatar/_types.py - 53-78 lines
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
export class AvatarSession {
  #logger = log();

  /**
   * Start the avatar session.
   *
   * Subclasses should override this method and call `super.start(agentSession, room)` at the
   * top of their implementation. Subclasses may widen the return type (e.g. returning a
   * session id), matching the `# type: ignore[override]` escape hatch used in Python.
   */
  async start(agentSession: AgentSession, _room: Room): Promise<unknown> {
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
    return undefined;
  }

  /**
   * Release any resources owned by this avatar session. Default implementation is a no-op;
   * subclasses can override to perform cleanup.
   */
  async aclose(): Promise<void> {}
}
