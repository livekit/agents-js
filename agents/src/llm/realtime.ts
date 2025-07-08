// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import type { ChatContext } from './chat_context.js';
import type { ToolContext } from './tool_context.js';

export interface RealtimeCapabilities {
  messageTruncation: boolean;
  turnDetection: boolean;
  userTranscription: boolean;
  autoToolReplyGeneration: boolean;
}

export abstract class RealtimeModel {
  private _capabilities: RealtimeCapabilities;

  constructor(capabilities: RealtimeCapabilities) {
    this._capabilities = capabilities;
  }

  get capabilities() {
    return this._capabilities;
  }

  abstract session(): RealtimeSession;

  abstract close(): Promise<void>;
}

export abstract class RealtimeSession {
  private _realtimeModel: RealtimeModel;

  constructor(realtimeModel: RealtimeModel) {
    this._realtimeModel = realtimeModel;
  }

  get realtimeModel() {
    return this._realtimeModel;
  }

  abstract get chatCtx(): ChatContext;

  abstract get tools(): ToolContext;

  abstract updateInstructions(instructions: string): Promise<void>;

  /**
   * @throws RealtimeError on Timeout
   */
  abstract updateChatCtx(chatCtx: ChatContext): Promise<void>;

  abstract updateTools(tools: ToolContext): Promise<void>;

  abstract pushAudio(frame: AudioFrame): void;

  /**
   * @throws RealtimeError on Timeout
   */
  abstract generateReply(options: { instructions: string }): Promise<void>;

  /**
   * Commit the input audio buffer to the server
   */
  abstract commitAudio(): Promise<void>;

  /**
   * Clear the input audio buffer to the server
   */
  abstract clearAudio(): Promise<void>;

  /**
   * Cancel the current generation (do nothing if no generation is in progress)
   */
  abstract interrupt(): Promise<void>;

  /**
   * Truncate the message at the given audio end time
   */
  abstract truncate(options: { messageId: string; audioEndMs: number }): Promise<void>;

  abstract close(): Promise<void>;

  /**
   * Notifies the model that user activity has started
   */
  abstract startUserActivity(): void;
}
