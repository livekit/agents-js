// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { llm } from '@livekit/agents';
import { GPTLiveModel as BaseGPTLiveModel } from '@livekit/agents/llm/openai_realtime/gpt_live_model';
import type OpenAI from 'openai';
import { OpenAITool } from '../tools.js';

export {
  type GPTLiveDelegation,
  type GPTLiveModelOptions,
  GPTLiveSession,
  type GPTLiveVoices,
  type ResponsesDelegationOptions,
} from '@livekit/agents/llm/openai_realtime/gpt_live_model';

/** OpenAI GPT-Live full-duplex voice model, ready to pass to AgentSession.
 * @public
 */
export class GPTLiveModel extends BaseGPTLiveModel {
  /** @internal */
  override _providerToolConfig(tool: llm.ProviderTool): OpenAI.Responses.Tool | undefined {
    return tool instanceof OpenAITool
      ? (tool.toToolConfig() as unknown as OpenAI.Responses.Tool)
      : undefined;
  }
}
