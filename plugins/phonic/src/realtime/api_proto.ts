// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Phonic } from 'phonic';

export type ServerEvent =
  | Phonic.ReadyToStartConversationPayload
  | Phonic.ConversationCreatedPayload
  | Phonic.InputTextPayload
  | Phonic.InputCancelledPayload
  | Phonic.AudioChunkResponsePayload
  | Phonic.UserStartedSpeakingPayload
  | Phonic.UserFinishedSpeakingPayload
  | Phonic.DtmfPayload
  | Phonic.ToolCallPayload
  | Phonic.ToolCallOutputProcessedPayload
  | Phonic.ToolCallInterruptedPayload
  | Phonic.AssistantChoseNotToRespondPayload
  | Phonic.AssistantEndedConversationPayload
  | Phonic.AssistantStartedSpeakingPayload
  | Phonic.AssistantFinishedSpeakingPayload
  | Phonic.ErrorPayload;

export type Voice =
  | 'sabrina'
  | 'grant'
  | 'virginia'
  | 'landon'
  | 'eleanor'
  | 'shelby'
  | 'nolan'
  | string;
