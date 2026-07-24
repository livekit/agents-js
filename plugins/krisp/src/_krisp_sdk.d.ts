// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Ambient typings for the untyped, user-installed `@krisp/viva-node-sdk` native
 * module, covering the subset of the documented server SDK surface this plugin
 * uses (https://sdk-docs.krisp.ai/docs/getting-started-server).
 *
 * The package is not a dependency — it is lazily `require`d at runtime in
 * license mode — so these declarations let the plugin type-check without it
 * installed.
 */
declare module '@krisp/viva-node-sdk' {
  /**
   * Opaque `enums.SamplingRate.Sr<rate>Hz` / `enums.FrameDuration.Fd<ms>ms`
   * member. The SDK treats these as tokens — we only read them from `enums` and
   * pass them straight back into `create`, never inspecting their runtime shape.
   */
  export type KrispEnumMember = unknown;

  /** Config passed to `NcInt16.create` for a noise-cancellation session. */
  export interface KrispSessionConfig {
    inputSampleRate: KrispEnumMember;
    inputFrameDuration: KrispEnumMember;
    outputSampleRate: KrispEnumMember;
    modelInfo: { path: string };
  }

  /** Noise-cancellation session returned by `NcInt16.create`. */
  export interface KrispNcSession {
    /**
     * Filter one fixed-size int16 chunk at the given suppression level (0–100).
     * Input is a byte buffer of interleaved int16 PCM; the return is a byte
     * buffer of the same length (samples × 2 bytes).
     */
    process(frame: Buffer | ArrayBuffer, noiseSuppressionLevel?: number): Buffer;
    destroy(): void;
  }

  /** The subset of the module surface this plugin uses. */
  export interface KrispModule {
    enums: {
      SamplingRate: Record<string, KrispEnumMember>;
      FrameDuration: Record<string, KrispEnumMember>;
    };
    /**
     * Process-global init. Takes a working-directory path; the second argument
     * is the license key (the SDK also honors overloads with log callbacks, not
     * used here). Pass `''` for the working dir to use the SDK default.
     */
    globalInit(workingDir: string, licenseKey?: string): void;
    /** Process-global teardown. */
    globalDestroy(): void;
    NcInt16: { create(config: KrispSessionConfig): KrispNcSession };
  }
}
