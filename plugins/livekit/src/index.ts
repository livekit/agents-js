// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import * as turnDetector from './turn_detector.js';
import { InferenceRunner } from '@livekit/agents';

InferenceRunner.registerRunner(turnDetector.EOURunner.INFERENCE_METHOD, import.meta.resolve('./turn_detector.ts'))
export { turnDetector };
