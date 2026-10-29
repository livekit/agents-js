// SPDX-FileCopyrightText: 2026 OpenSpline contributors
// SPDX-License-Identifier: Apache-2.0
import { Openspline, type Quality } from '@openspline/node';
import { LiveKitAvatarSession } from '@openspline/node/livekit';

/** OpenSpline provider settings. Supply exactly one portrait or saved avatar ID. */
export interface AvatarSessionOptions {
  /** Image path or bytes; mutually exclusive with avatarId. */
  portrait?: string | Uint8Array;
  /** Owned Cloud avatar ID from the OpenSpline developer dashboard. */
  avatarId?: string;
  /** OpenSpline key, defaulting to OPENSPLINE_API_KEY. */
  apiKey?: string;
  /** OpenSpline endpoint, defaulting to OPENSPLINE_URL or SDK defaults. */
  url?: string;
  /** Low by default, or the injected client's default. */
  quality?: Quality;
  /** Optional background image/video path or bytes. */
  background?: string | Uint8Array;
  /** Existing client, mutually exclusive with apiKey/url. */
  client?: Openspline;
  /** Defaults to LIVEKIT_URL. */
  livekitUrl?: string;
  /** Defaults to LIVEKIT_API_KEY. */
  livekitApiKey?: string;
  /** Defaults to LIVEKIT_API_SECRET. */
  livekitApiSecret?: string;
  /** Video publication timeout after worker preparation, in milliseconds. */
  joinTimeout?: number;
}

/** Start before AgentSession.start. The job closes the worker automatically. */
export class AvatarSession extends LiveKitAvatarSession {
  constructor(options: AvatarSessionOptions) {
    if (options.client && (options.apiKey !== undefined || options.url !== undefined))
      throw new Error('Pass client or apiKey/url, not both');
    super({
      portrait: options.portrait,
      avatarId: options.avatarId,
      client: options.client ?? new Openspline({ apiKey: options.apiKey, url: options.url }),
      quality: options.quality,
      background: options.background,
      url: options.livekitUrl,
      apiKey: options.livekitApiKey,
      apiSecret: options.livekitApiSecret,
      joinTimeout: options.joinTimeout,
    });
  }
}
