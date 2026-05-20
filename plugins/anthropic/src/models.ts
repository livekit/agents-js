// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Supported Anthropic Chat Models.
 *
 * @remarks
 * Based on https://docs.anthropic.com/en/docs/about-claude/model-deprecations
 */
export type ChatModels =
  | 'claude-3-5-sonnet-20241022'
  | 'claude-3-5-haiku-20241022'
  | 'claude-3-haiku-20240307'
  | 'claude-3-7-sonnet-20250219'
  | 'claude-sonnet-4-20250514'
  | 'claude-sonnet-4-6'
  | 'claude-opus-4-20250514'
  | 'claude-opus-4-1-20250805'
  | 'claude-opus-4-6'
  | (string & Record<never, never>);
