// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type OpenAI from 'openai';
import type { Reasoning } from 'openai/resources/shared.js';

/** GPT-Live wire types. Field names follow the service protocol. @public */
export type DelegationTarget = 'responses' | 'client';
/** @public */
export type InputRole = 'developer' | 'user' | 'assistant';
/** @public */
export interface InputItem {
  type: 'message';
  role: InputRole;
  content: { type: 'input_text' | 'output_text'; text: string }[];
}
/** @public */
export interface ResponsesConfig {
  model?: string;
  instructions?: string;
  tools?: OpenAI.Responses.Tool[];
  tool_choice?: string | { type: 'function'; name: string };
  parallel_tool_calls?: boolean;
  reasoning?: Reasoning;
  text?: OpenAI.Responses.ResponseTextConfig;
  service_tier?: 'auto' | 'default' | 'flex' | 'priority';
  max_output_tokens?: number;
}
/** @public */
export type Delegation = { type: 'client' } | { type: 'responses'; responses: ResponsesConfig };
/** @public */
export interface SessionConfig {
  model: string;
  instructions?: string;
  input?: InputItem[];
  audio?: {
    format?: { type: 'audio/pcm' | 'audio/pcmu' | 'audio/pcma'; rate: number };
    output?: { voice?: string | Record<string, unknown> };
  };
  delegation?: Delegation;
}
/** @public */
export type ClientEvent = { event_id?: string } & (
  | { type: 'session.start'; session: SessionConfig }
  | { type: 'session.update'; session: { delegation: Delegation } }
  | { type: 'session.input_audio.append'; audio: string }
  | {
      type:
        | 'session.input_audio.mute'
        | 'session.input_audio.unmute'
        | 'session.close'
        | 'response.create';
    }
  | {
      type: 'session.instructions.append' | 'session.thinking.append' | 'session.commentary.append';
      /** Required on every append, including when no delegation is being answered. */
      delegation_id: string | null;
      content: string;
    }
  | { type: 'response.item.create'; item: OpenAI.Responses.ResponseInputItem }
);
/** @public */
export interface ResponseUsage {
  input_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  output_tokens?: number;
  output_tokens_details?: { reasoning_tokens?: number };
  total_tokens?: number;
}
/** @public */
export interface ResponsesEvent {
  type: string;
  response?: {
    id?: string | null;
    model?: string | null;
    usage?: ResponseUsage | null;
    error?: Record<string, unknown> | null;
    incomplete_details?: Record<string, unknown> | null;
  } | null;
  item?: {
    id?: string | null;
    type?: string | null;
    call_id?: string | null;
    name?: string | null;
    arguments?: string | null;
  } | null;
}
/** @public */
export interface ErrorBody {
  type?: string | null;
  code?: string | null;
  message?: string;
  param?: string | null;
  client_event_id?: string | null;
}
/** Server fields are optional so missing fields do not end a session. @public */
export type ServerEvent =
  | { type: 'session.started'; session?: { id?: string | null } }
  | { type: 'session.output_audio.delta'; delta?: string }
  | {
      type: 'session.output_transcript.delta' | 'session.input_transcript.delta';
      delta?: string;
      start_ms?: number | null;
      end_ms?: number | null;
    }
  | {
      type: 'session.delegation.created';
      delegation?: { id?: string | null; target?: DelegationTarget | null };
    }
  | { type: 'response.event'; delegation_id?: string | null; event?: ResponsesEvent }
  | {
      type: 'session.usage.updated';
      usage?: { seconds?: number };
      context_window?: { usage_ratio?: number | null } | null;
    }
  | {
      type: 'session.closed';
      reason?:
        | 'close_requested'
        | 'expired'
        | 'content'
        | 'remote_hangup'
        | 'connection_lost'
        | null;
      usage?: { seconds?: number };
      context_window?: { usage_ratio?: number | null } | null;
    }
  | { type: 'error'; error?: ErrorBody }
  | {
      type: 'session.updated' | 'session.input_audio.muted' | 'session.input_audio.unmuted';
      client_event_id?: string;
    }
  | {
      /** Sent at the estimated context-injection end; does not indicate speech completion. */
      type:
        | 'session.instructions.appended'
        | 'session.thinking.appended'
        | 'session.commentary.appended';
      client_event_id?: string;
    };
