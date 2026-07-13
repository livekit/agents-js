// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';

/**
 * Marker for the LiveKit Cloud-bundled Krisp backend.
 * @public
 */
export class LiveKitCloudAuthProvider {}

/** @public */
export type KrispLicenseAuthProviderOptions = {
  licenseKey?: string;
  modelPath?: string;
};

/**
 * Krisp-direct auth using a license key and `.kef` model file.
 * @public
 */
export class KrispLicenseAuthProvider {
  readonly licenseKey: string;
  readonly modelPath: string;

  constructor({ licenseKey, modelPath }: KrispLicenseAuthProviderOptions = {}) {
    const resolvedLicenseKey = licenseKey ?? process.env.KRISP_VIVA_SDK_LICENSE_KEY ?? '';
    const resolvedModelPath = modelPath ?? process.env.KRISP_VIVA_FILTER_MODEL_PATH;

    if (!resolvedModelPath) {
      throw new Error(
        'Krisp model path is required. Pass modelPath or set KRISP_VIVA_FILTER_MODEL_PATH.',
      );
    }
    if (!resolvedModelPath.endsWith('.kef')) {
      throw new Error('Krisp model must have .kef extension');
    }
    if (!existsSync(resolvedModelPath)) {
      throw new Error(`Krisp model file not found: ${resolvedModelPath}`);
    }

    this.licenseKey = resolvedLicenseKey;
    this.modelPath = resolvedModelPath;
  }
}

/** @public */
export const livekitCloud = LiveKitCloudAuthProvider;
/** @public */
export const krispLicense = KrispLicenseAuthProvider;
