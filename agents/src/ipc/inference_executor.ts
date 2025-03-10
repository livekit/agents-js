// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export interface InferenceExecutor {
  doInference(method: string, data: unknown): Promise<unknown>;
}
