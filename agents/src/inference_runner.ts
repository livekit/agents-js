// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** @internal */
export abstract class InferenceRunner {
  abstract INFERENCE_METHOD: string;
  static registeredRunners: { [id: string]: InferenceRunner } = {};

  static registerRunner(runner: InferenceRunner) {
    if (InferenceRunner.registeredRunners[runner.INFERENCE_METHOD]) {
      throw new Error(`Inference runner ${runner.INFERENCE_METHOD} already registered`);
    }
    InferenceRunner.registeredRunners[runner.INFERENCE_METHOD] = runner;
  }

  abstract initialize(): Promise<void>;
  abstract run(data: any): Promise<any>;
}
