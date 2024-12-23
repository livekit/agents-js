// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export abstract class InferenceExecutor {
  abstract doInference(method: string, data: unknown): Promise<unknown>;
}
