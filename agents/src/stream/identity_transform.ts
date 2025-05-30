// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export class IdentityTransform<T> extends TransformStream<T, T> {
  constructor() {
    super({
      transform: (chunk, controller) => controller.enqueue(chunk),
    });
  }
}
