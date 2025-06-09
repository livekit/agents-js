// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { TransformStream } from 'node:stream/web';

export class IdentityTransform<T> extends TransformStream<T, T> {
  constructor() {
    super(
      {
        transform: (chunk, controller) => controller.enqueue(chunk),
      },
      // By default the transfor stream will buffer only one chunk at a time.
      // In order to follow the python agents channel.py, we set set the capaciy to be effectively infinite.
      { highWaterMark: Number.MAX_SAFE_INTEGER },
      { highWaterMark: Number.MAX_SAFE_INTEGER },
    );
  }
}
