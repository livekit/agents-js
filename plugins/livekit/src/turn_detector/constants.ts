// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
export type EOUModelType = 'en' | 'multilingual';

export const MAX_HISTORY_TOKENS = 128;
export const MAX_HISTORY_TURNS = 6;

export const MODEL_REVISIONS: Record<EOUModelType, string> = {
  en: 'v1.2.2-en',
  multilingual: 'v0.4.1-intl',
};

export const HG_MODEL_REPO = 'livekit/turn-detector';

export const ONNX_FILEPATH = 'onnx/model_q8.onnx';
