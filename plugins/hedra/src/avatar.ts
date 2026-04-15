// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Exception thrown when there are errors with the Hedra API.
 */
export class HedraException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HedraException';
  }
}

/**
 * A Hedra avatar session.
 *
 * @deprecated The Hedra realtime avatar service has been disabled.
 */
export class AvatarSession {
  constructor(..._args: unknown[]) {
    throw new HedraException(
      'The Hedra realtime avatar service has been disabled. ' +
        'Please visit https://docs.livekit.io/agents/integrations/avatar/ for other avatar integrations.',
    );
  }
}
