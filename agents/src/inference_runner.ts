// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** @internal */
export abstract class InferenceRunner {
  static INFERENCE_METHOD: string;
  static registeredRunners: { [id: string]: string } = {};

  static registerRunner(method: string, importPath: string) {
    if (InferenceRunner.registeredRunners[method]) {
      throw new Error(`Inference runner ${method} already registered`);
    }
    InferenceRunner.registeredRunners[method] = importPath;
  }

  abstract initialize(): Promise<void>;
  abstract run(data: unknown): Promise<unknown>;
}
