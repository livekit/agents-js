// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** @public */
export const DEFAULT_API_URL = 'https://developers.synthesia.io';
/** @public */
export const DEFAULT_JOIN_TIMEOUT = 30_000;
/** @public */
export const DEFAULT_SWAP_TIMEOUT = 15_000;
/** @public */
export const AVATAR_IDENTITY = 'synthesia-avatar-agent';
/** @public */
export const AVATAR_NAME = 'Synthesia avatar';
/** @public */
export const MAX_AVATAR_IDS = 5;
/** @internal */
export const TOKEN_TTL = '6h';

/** @public */
export interface AvatarConfigOptions {
  /** One to five gallery avatar IDs. The first ID is initially active. */
  avatarIds: readonly string[];
}

/** The avatars to render in the room. @public */
export class AvatarConfig {
  readonly avatarIds: readonly string[];

  constructor({ avatarIds }: AvatarConfigOptions) {
    if (!Array.isArray(avatarIds)) {
      throw new TypeError('avatarIds must be a list of ids, not a single string');
    }
    if (avatarIds.length < 1 || avatarIds.length > MAX_AVATAR_IDS) {
      throw new RangeError(
        `avatarIds must contain between 1 and ${MAX_AVATAR_IDS} ids, got ${avatarIds.length}`,
      );
    }
    this.avatarIds = [...avatarIds];
  }
}

/** @internal */
export interface StartSessionRequest {
  avatarIds: readonly string[];
  livekitUrl: string;
  livekitToken: string;
}

/** @internal */
export interface StartSessionResponse {
  sessionId: string;
}
