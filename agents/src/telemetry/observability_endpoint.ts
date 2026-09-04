// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '../log.js';

/**
 * Where the observability exporters send data.
 *
 * `cloudHostname` is the pre-1.8 spelling: a bare host that always implied `https`. It is still
 * accepted so callers compiled against earlier releases keep working, and resolves to exactly the
 * URL they got before. New callers should pass `observabilityUrl`, which can also carry a scheme,
 * a port, and a base path.
 */
export type ObservabilityEndpoint =
  | {
      /** Base URL for LiveKit Cloud observability, without a trailing slash. */
      observabilityUrl: string;
      cloudHostname?: undefined;
    }
  | {
      observabilityUrl?: undefined;
      /** @deprecated Pass `observabilityUrl` instead. A bare hostname is assumed to be `https`. */
      cloudHostname: string;
    };

let warnedDeprecatedCloudHostname = false;

/** Resolve an {@link ObservabilityEndpoint} to the base URL consumers append their path to. */
export function resolveObservabilityUrl(endpoint: ObservabilityEndpoint): string {
  if (endpoint.observabilityUrl) {
    return endpoint.observabilityUrl;
  }

  if (endpoint.cloudHostname) {
    if (!warnedDeprecatedCloudHostname) {
      warnedDeprecatedCloudHostname = true;
      log().warn(
        'cloudHostname is deprecated for LiveKit Cloud observability, use observabilityUrl instead',
      );
    }
    return `https://${endpoint.cloudHostname}`;
  }

  throw new Error('observabilityUrl is required for LiveKit Cloud observability');
}
