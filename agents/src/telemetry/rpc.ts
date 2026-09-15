// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Trace RPCs the agent performs and handles.
 *
 * The room SDK exposes an `RpcInterceptor` hook (`@livekit/rtc-node` with
 * `LocalParticipant.addRpcInterceptor`) that wraps every call made through `performRpc` and
 * every invocation dispatched to a registered handler. This module installs one interceptor per
 * local participant that turns each call into a span following the OpenTelemetry RPC semantic
 * conventions:
 *
 * - `rpc_call` (`SpanKind.CLIENT`) for outgoing calls, under whatever span is current where the
 *   call is made (an RPC issued from a tool nests under `function_tool`);
 * - `rpc_handler` (`SpanKind.SERVER`) for incoming invocations, under the primary agent
 *   session's root span.
 *
 * Payloads are recorded truncated under `lk.pii` keys. Participant identities are application
 * identifiers, not end-user data, and are recorded as is. On an SDK without the hook, `install`
 * is a no-op.
 */
import { RpcError } from '@livekit/rtc-node';
import { type Attributes, SpanKind } from '@opentelemetry/api';
import { log } from '../log.js';
import { sessionRootContext } from './session_context.js';
import * as traceTypes from './trace_types.js';
import { tracer } from './traces.js';
import { recordException } from './utils.js';

/** Request and response payloads longer than this many characters are truncated in span attributes. */
export const MAX_PAYLOAD_ATTR_LEN = 1024;

// The SDK's interceptor API, spelled structurally: this compiles and installs against any
// `@livekit/rtc-node`, and does nothing on one that predates `addRpcInterceptor`.

/** An outgoing call, as `LocalParticipant.performRpc` hands it to interceptors. */
export interface RpcCallInfo {
  destinationIdentity: string;
  method: string;
  payload: string;
  /** Milliseconds the caller waits for a response; `undefined` for the SDK default. */
  responseTimeout?: number;
}

/** An incoming invocation, as the SDK hands it to interceptors and handlers. */
export interface RpcInvocationInfo {
  requestId: string;
  callerIdentity: string;
  payload: string;
  /** Milliseconds the caller waits for a response. */
  responseTimeout: number;
  /** Absent on an SDK that does not attach the method to invocations. */
  method?: string;
}

export type OutgoingRpcNext = (call: RpcCallInfo) => Promise<string>;
export type IncomingRpcNext = (invocation: RpcInvocationInfo) => Promise<string>;

/** The shape of `@livekit/rtc-node`'s `RpcInterceptor`. */
export interface RpcInterceptor {
  interceptOutgoing?(call: RpcCallInfo, next: OutgoingRpcNext): Promise<string>;
  interceptIncoming?(invocation: RpcInvocationInfo, next: IncomingRpcNext): Promise<string>;
}

interface RpcInterceptorHost {
  addRpcInterceptor(interceptor: RpcInterceptor): void;
}

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

/** An `RpcInterceptor` emitting `rpc_call` / `rpc_handler` spans. */
export class TracingRpcInterceptor implements RpcInterceptor {
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

  async interceptIncoming(invocation: RpcInvocationInfo, next: IncomingRpcNext): Promise<string> {
    const attributes: Attributes = {
      [traceTypes.ATTR_RPC_METHOD]: invocation.method ?? '',
      [traceTypes.ATTR_RPC_REQUEST_ID]: invocation.requestId,
      [traceTypes.ATTR_RPC_CALLER_IDENTITY]: invocation.callerIdentity,
      [traceTypes.ATTR_RPC_RESPONSE_TIMEOUT]: invocation.responseTimeout / 1000,
      [traceTypes.ATTR_RPC_HANDLER_REGISTERED]: true,
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
            if (error.code === RpcError.ErrorCode.UNSUPPORTED_METHOD) {
              // a client called a method this agent never registered (the transport normally
              // answers that before the SDK does; this is the defensive path)
              span.setAttribute(traceTypes.ATTR_RPC_HANDLER_REGISTERED, false);
            }
          }
          recordException(span, toError(error));
          throw error;
        }
        span.setAttributes(responseAttributes(response));
        return response;
      },
      {
        name: 'rpc_handler',
        // the session timeline, from whatever task the SDK dispatches on
        context: sessionRootContext(),
        kind: SpanKind.SERVER,
        attributes,
      },
    );
  }
}

/** The one interceptor every participant gets; the SDK dedups registrations by identity. */
export const interceptor = new TracingRpcInterceptor();

let warnedUnsupported = false;

/**
 * Trace RPCs on `localParticipant`. Idempotent. Returns false when the installed
 * `@livekit/rtc-node` has no interceptor support.
 */
export function install(localParticipant: unknown): boolean {
  const host = localParticipant as Partial<RpcInterceptorHost> | null | undefined;
  if (typeof host?.addRpcInterceptor !== 'function') {
    if (!warnedUnsupported) {
      warnedUnsupported = true;
      log().debug(
        '@livekit/rtc-node has no RpcInterceptor support; RPC calls will not be traced ' +
          '(requires a version with LocalParticipant.addRpcInterceptor)',
      );
    }
    return false;
  }
  host.addRpcInterceptor(interceptor);
  return true;
}
