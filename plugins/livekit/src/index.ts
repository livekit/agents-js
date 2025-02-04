// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { InferenceRunner } from '@livekit/agents';
import * as turnDetector from './turn_detector.js';

InferenceRunner.registerRunner(
  turnDetector.EOURunner.INFERENCE_METHOD,
  import.meta.resolve('./turn_detector.js'),
);
export { turnDetector };
