// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ThrowsPromise } from '@livekit/throws-transformer/throws';
import type { Logger } from 'pino';

type DisconnectableRoom = {
  disconnect(): Promise<void>;
};

/** @internal Exported for testing; not re-exported from the package index. */
export async function finalizeJobShutdown({
  room,
  shutdownCallbacks,
  logger,
  onDone,
}: {
  room: DisconnectableRoom;
  shutdownCallbacks: (() => Promise<void>)[];
  logger: Logger;
  onDone: () => void;
}): Promise<void> {
  try {
    await room.disconnect();
    logger.debug('disconnected from room');
  } catch (error) {
    logger.error({ error }, 'error in room.disconnect');
  }

  const shutdownTasks = [];
  for (const callback of shutdownCallbacks) {
    shutdownTasks.push(callback());
  }
  await ThrowsPromise.all(shutdownTasks).catch((error) =>
    logger.error({ error }, 'error while shutting down the job'),
  );

  onDone();
}
