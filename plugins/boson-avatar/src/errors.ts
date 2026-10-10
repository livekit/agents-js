// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Base exception for Boson Avatar configuration and protocol errors. @public */
export class BosonAvatarException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BosonAvatarException';
  }
}
