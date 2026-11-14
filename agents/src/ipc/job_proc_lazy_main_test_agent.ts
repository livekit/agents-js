// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type DisconnectReason, Room } from '@livekit/rtc-node';
import { defineAgent } from '../generator.js';
import { JobContext } from '../job.js';
import { tracer } from '../telemetry/index.js';

export default defineAgent({
  prewarm: () => {
    const scenario = process.argv[3];
    if (!scenario) return;

    const cleanup = JobContext.prototype._onCleanup;
    JobContext.prototype._onCleanup = function () {
      cleanup.call(this);
      process.send!({ case: 'testCleanup' });
    };
    if (scenario === 'job startup throws') {
      Room.prototype.on = () => {
        throw new Error('cannot start the job');
      };
    } else if (scenario === 'root span creation throws') {
      tracer.startSpan = () => {
        throw new Error('cannot start the job span');
      };
    } else {
      JobContext.prototype._prepareTelemetry = async () => {
        if (scenario === 'setup rejects after shutdown') {
          await Promise.resolve();
          process.emit(
            'message',
            { case: 'shutdownRequest', value: { reason: 'test shutdown' } },
            undefined,
          );
        }
        throw new Error('cannot prepare telemetry');
      };
    }
  },
  entry: (ctx) => {
    if (process.argv[3]) process.send!({ case: 'testEntrypoint' });
    // RTC is the only external service replaced; the process and its lifecycle are real.
    ctx.room.disconnect = async (reason?: DisconnectReason) => {
      process.send!({ case: 'testDisconnect', reason });
    };
    ctx.addShutdownCallback(async () => {
      process.send!({ case: 'testShutdownCallback' });
    });

    const scenario = ctx.job.metadata;
    if (scenario === 'job api') {
      return (async () => {
        // the server API is the only external service replaced
        globalThis.fetch = async (_input, init) => {
          const authorization = new Headers(init?.headers).get('Authorization');
          process.send!({ case: 'testFetch', authorization });
          return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
        };
        await ctx.deleteRoom('myroom');
        await ctx.deleteRoom('myroom');
        ctx.shutdown();
      })();
    }
    if (scenario === 'synchronous throw') throw new Error('synchronous entrypoint failure');

    return (async () => {
      if (scenario === 'raise before connect') throw new Error('entrypoint failed before connect');
      if (scenario === 'connect rejects') {
        ctx.room.connect = async () => {
          throw new Error('connection failed');
        };
      }
      await ctx.connect();
      if (scenario === 'raise after connect') throw new Error('entrypoint failed after connect');
      ctx.shutdown();
      if (scenario === 'shutdown then raise') throw new Error('entrypoint failed after shutdown');
    })();
  },
  onSessionEnd: async () => {
    process.send!({ case: 'testSessionEnd' });
  },
});
