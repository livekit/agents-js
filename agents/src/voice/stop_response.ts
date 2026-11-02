// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
export const STOP_RESPONSE_SYMBOL = Symbol('StopResponse');

export class StopResponse extends Error {
  constructor() {
    super();
    this.name = 'StopResponse';

    Object.defineProperty(this, STOP_RESPONSE_SYMBOL, {
      value: true,
    });
  }
}

export function isStopResponse(value: unknown): value is StopResponse {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === 'object' &&
    STOP_RESPONSE_SYMBOL in value
  );
}
