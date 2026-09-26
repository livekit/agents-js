// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Trace RPCs the agent performs and handles.
 *
 * The room SDK exposes an `RpcInterceptor` hook (`@livekit/rtc-node` with
 * `LocalParticipant.addRpcInterceptor`) that wraps every call made through `performRpc` and
 * every invocation dispatched to a registered handler. This module installs one interceptor per
 * job on its local participant that turns each call into a span following the OpenTelemetry RPC
 * semantic conventions:
 *
 * - `rpc_call` (`SpanKind.CLIENT`) for outgoing calls, under whatever span is current where the
 *   call is made (an RPC issued from a tool nests under `function_tool`);
 * - `rpc_handler` (`SpanKind.SERVER`) for incoming invocations, under the primary agent
 *   session's root span, else the job's root (`job_entrypoint`): the SDK dispatches them on a
 *   task whose context carries neither.
 *
 * Payloads are recorded truncated under `lk.pii` keys. Participant identities are application
 * identifiers, not end-user data, and are recorded as is.
 */
import {
  type IncomingRpcNext,
  type LocalParticipant,
  type OutgoingRpcNext,
  type RpcCallInfo,
  RpcError,
  type RpcInterceptor,
  type RpcInvocationData,
} from '@livekit/rtc-node';
import { type Attributes, SpanKind } from '@opentelemetry/api';
import { type JobContext, getJobContext, runWithJobContext } from '../job.js';
import { jobRootContext, sessionRootContext } from './session_context.js';
import * as traceTypes from './trace_types.js';
import { tracer } from './traces.js';
import { recordException } from './utils.js';

/** Request and response payloads longer than this many characters are truncated in span attributes. */
export const MAX_PAYLOAD_ATTR_LEN = 1024;

function truncate(payload: string): string {
  return payload.slice(0, MAX_PAYLOAD_ATTR_LEN);
}

function payloadAttributes(payload: string): Attributes {
  const attrs: Attributes = {
    [traceTypes.ATTR_RPC_PAYLOAD_SIZE]: Buffer.byteLength(payload, 'utf8'),
  };
  if (payload) attrs[traceTypes.ATTR_RPC_PAYLOAD] = truncate(payload);
  return attrs;
}

function responseAttributes(response: string | undefined | null): Attributes {
  const text = response ?? '';
  const attrs: Attributes = {
    [traceTypes.ATTR_RPC_RESPONSE_SIZE]: Buffer.byteLength(text, 'utf8'),
  };
  if (text) attrs[traceTypes.ATTR_RPC_RESPONSE] = truncate(text);
  return attrs;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * An `RpcInterceptor` emitting `rpc_call` / `rpc_handler` spans. Bound to the job it was
 * installed for: incoming invocations arrive outside that job's context (see interceptIncoming).
 */
export class TracingRpcInterceptor implements RpcInterceptor {
  constructor(private readonly job?: JobContext) {}

  async interceptOutgoing(call: RpcCallInfo, next: OutgoingRpcNext): Promise<string> {
    const attributes: Attributes = {
      [traceTypes.ATTR_RPC_METHOD]: call.method,
      [traceTypes.ATTR_RPC_DESTINATION_IDENTITY]: call.destinationIdentity,
      ...payloadAttributes(call.payload),
    };
    if (call.responseTimeout !== undefined) {
      attributes[traceTypes.ATTR_RPC_RESPONSE_TIMEOUT] = call.responseTimeout / 1000;
    }

    return tracer.startActiveSpan(
      async (span) => {
        let response: string;
        try {
          response = await next(call);
        } catch (error) {
          if (error instanceof RpcError) {
            span.setAttribute(traceTypes.ATTR_RPC_ERROR_CODE, Number(error.code));
          }
          recordException(span, toError(error));
          throw error;
        }
        span.setAttributes(responseAttributes(response));
        return response;
      },
      { name: 'rpc_call', kind: SpanKind.CLIENT, attributes },
    );
  }

  async interceptIncoming(invocation: RpcInvocationData, next: IncomingRpcNext): Promise<string> {
    // the SDK dispatches invocations from its FFI event path, outside the job's
    // AsyncLocalStorage: restore the job this interceptor was installed for so the session and
    // job roots resolve (and the handler sees getJobContext(), as a Python handler does)
    const job = getJobContext(false) ?? this.job;
    if (job !== undefined && getJobContext(false) === undefined) {
      return runWithJobContext(job, () => this.handleIncoming(invocation, next));
    }
    return this.handleIncoming(invocation, next);
  }

  private async handleIncoming(
    invocation: RpcInvocationData,
    next: IncomingRpcNext,
  ): Promise<string> {
    const attributes: Attributes = {
      [traceTypes.ATTR_RPC_METHOD]: invocation.method,
      [traceTypes.ATTR_RPC_REQUEST_ID]: invocation.requestId,
      [traceTypes.ATTR_RPC_CALLER_IDENTITY]: invocation.callerIdentity,
      [traceTypes.ATTR_RPC_RESPONSE_TIMEOUT]: invocation.responseTimeout / 1000,
      ...payloadAttributes(invocation.payload),
    };

    return tracer.startActiveSpan(
      async (span) => {
        let response: string;
        try {
          response = await next(invocation);
        } catch (error) {
          if (error instanceof RpcError) {
            span.setAttribute(traceTypes.ATTR_RPC_ERROR_CODE, Number(error.code));
          }
          recordException(span, toError(error));
          throw error;
        }
        span.setAttributes(responseAttributes(response));
        return response;
      },
      {
        name: 'rpc_handler',
        // the session timeline, from whatever task the SDK dispatches on; before or after the
        // session, the job's own timeline
        context: sessionRootContext() ?? jobRootContext(),
        kind: SpanKind.SERVER,
        attributes,
      },
    );
  }
}

/** One interceptor per job, so a process hosting several jobs routes each invocation to its own. */
const interceptors = new WeakMap<JobContext, TracingRpcInterceptor>();
let joblessInterceptor: TracingRpcInterceptor | undefined;

/** The interceptor for `job` (or the one shared outside any job), created on first use. */
function interceptorFor(job: JobContext | undefined): TracingRpcInterceptor {
  if (job === undefined) return (joblessInterceptor ??= new TracingRpcInterceptor());
  let interceptor = interceptors.get(job);
  if (!interceptor) {
    interceptor = new TracingRpcInterceptor(job);
    interceptors.set(job, interceptor);
  }
  return interceptor;
}

/**
 * Trace RPCs on `localParticipant` for `jobCtx` (else the current job). Idempotent: one
 * interceptor per job, and the SDK keeps one registration per interceptor instance, so every
 * connect and reconnect may install again. A missing participant (the room is not connected
 * yet), or one without the interceptor hook (an older room SDK, a stand-in in tests), installs
 * nothing: tracing must never be what breaks a connection. Returns the interceptor.
 */
export function install(
  localParticipant: LocalParticipant | undefined,
  jobCtx?: JobContext,
): TracingRpcInterceptor {
  const interceptor = interceptorFor(jobCtx ?? getJobContext(false));
  if (typeof localParticipant?.addRpcInterceptor === 'function') {
    localParticipant.addRpcInterceptor(interceptor);
  }
  return interceptor;
}
