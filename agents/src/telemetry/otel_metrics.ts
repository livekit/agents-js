// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type Attributes, type Histogram, type MeterProvider, metrics } from '@opentelemetry/api';
import { getJobContext } from '../job.js';

let meterProvider: MeterProvider | undefined;
let blockedDuration: Histogram | undefined;

function eventLoopBlockedHistogram(): Histogram {
  const currentProvider = metrics.getMeterProvider();
  if (currentProvider !== meterProvider || !blockedDuration) {
    meterProvider = currentProvider;
    blockedDuration = metrics
      .getMeter('livekit-agents')
      .createHistogram('lk.agents.event_loop.blocked_duration', {
        unit: 's',
        description: 'Duration of synchronous blocks detected on an agent event loop',
      });
  }
  return blockedDuration;
}

/** Record a synchronous event-loop block in seconds. */
export function recordEventLoopBlocked(duration: number, severity: string): void {
  const ctx = getJobContext(false);
  const attributes: Attributes = { severity };
  if (ctx) {
    Object.assign(attributes, ctx._otelMetadata());
    const roomId = ctx.job.room?.sid;
    if (roomId) attributes.room_id = roomId;
    if (ctx.job.id) attributes.job_id = ctx.job.id;
    if (ctx.job.agentName) attributes['lk.agent_name'] = ctx.job.agentName;
  }
  eventLoopBlockedHistogram().record(duration, attributes);
}
