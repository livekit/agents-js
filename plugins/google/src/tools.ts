// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Tool } from '@google/genai';

export type LLMTools = Omit<Tool, 'functionDeclarations'>;
