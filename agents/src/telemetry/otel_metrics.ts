// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type Attributes, type Histogram, type MeterProvider, metrics } from '@opentelemetry/api';
import { getJobContext } from '../job.js';
import * as traceTypes from './trace_types.js';

// Instruments are looked up per call: the global meter provider may be installed after this
// module loads (the cloud pipeline is set up when the job registers), and a histogram created
// on the no-op provider would stay a no-op.
let meterProvider: MeterProvider | undefined;
const histograms = new Map<string, Histogram>();

function histogram(name: string, description: string): Histogram {
  const currentProvider = metrics.getMeterProvider();
  if (currentProvider !== meterProvider) {
    meterProvider = currentProvider;
    histograms.clear();
  }
  let instrument = histograms.get(name);
  if (!instrument) {
    instrument = metrics.getMeter('livekit-agents').createHistogram(name, {
      unit: 's',
      description,
    });
    histograms.set(name, instrument);
  }
  return instrument;
}

/**
 * Per-measurement job attribution.
 *
 * The meter provider has process lifetime (the OTel metrics global is set-once), so per-job
 * fields cannot live on its resource. Each measurement carries the same per-job attributes that
 * are stamped on spans and logs instead. Returns a fresh object; callers may add to it.
 */
function jobAttrs(): Attributes {
  const ctx = getJobContext(false);
  const attributes: Attributes = {};
  if (ctx) {
    Object.assign(attributes, ctx._otelMetadata());
    const roomId = ctx.job.room?.sid;
    if (roomId) attributes.room_id = roomId;
    if (ctx.job.id) attributes.job_id = ctx.job.id;
    if (ctx.job.agentName) attributes['lk.agent_name'] = ctx.job.agentName;
  }
  return attributes;
}

/** Record an event-loop stall in seconds, with the severity and what caused it. */
export function recordEventLoopBlocked(duration: number, severity: string, cause: string): void {
  const attributes = jobAttrs();
  attributes.severity = severity;
  attributes.cause = cause;
  histogram(
    'lk.agents.event_loop.blocked_duration',
    'Duration of synchronous blocks detected on an agent event loop',
  ).record(duration, attributes);
}

/** `gen_ai.invoke_agent.duration` for one agent turn, in seconds. */
export function recordInvokeAgentDuration(duration: number, agentName: string): void {
  const attributes = jobAttrs();
  attributes[traceTypes.ATTR_GEN_AI_OPERATION_NAME] = traceTypes.GenAIOperationName.INVOKE_AGENT;
  attributes[traceTypes.ATTR_GEN_AI_AGENT_NAME] = agentName;
  histogram(traceTypes.METRIC_GEN_AI_INVOKE_AGENT_DURATION, 'Agent invocation duration').record(
    duration,
    attributes,
  );
}
