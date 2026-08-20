// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type ExportResult, ExportResultCode } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPExporterError } from '@opentelemetry/otlp-exporter-base';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { log } from '../log_core.js';

const DISABLED_MARKERS = ['data recording is disabled', 'disabled by owner'];

/**
 * Session-scoped latch that stops Cloud uploads after the project reports data recording is
 * disabled.
 */
class UploadGate {
  private isDisabled = false;
  private currentGeneration = 0;

  /** Re-enables uploads and invalidates responses from the previous session. */
  reset(): void {
    this.isDisabled = false;
    this.currentGeneration += 1;
  }

  /** Whether Cloud uploads are disabled for the current session. */
  get disabled(): boolean {
    return this.isDisabled;
  }

  /** Current session generation used to isolate in-flight responses across resets. */
  get generation(): number {
    return this.currentGeneration;
  }

  /**
   * Disables uploads for the matching session generation and emits the session warning once.
   *
   * @param generation - Generation that received the disabled response.
   */
  disable(generation: number = this.currentGeneration): void {
    if (generation !== this.currentGeneration) return;
    if (this.isDisabled) return;
    this.isDisabled = true;
    log().warn(
      'LiveKit Cloud data recording is disabled for this project; ' +
        'skipping telemetry and recording uploads for this session',
    );
  }

  /** Returns whether an HTTP response is the known project-recording-disabled rejection. */
  isDisabledResponse(statusCode: number, body: Uint8Array | ArrayBuffer | string): boolean {
    if (statusCode !== 401) return false;
    const text = bodyToText(body).toLowerCase();
    return DISABLED_MARKERS.some((marker) => text.includes(marker));
  }
}

/** Shared upload gate for LiveKit Cloud telemetry and recording transports. */
export const uploadGate = new UploadGate();

/**
 * Sends a Fetch request through the upload gate and converts the known disabled response to
 * synthetic success.
 */
export async function fetchWithUploadGate(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const generation = uploadGate.generation;
  if (uploadGate.disabled) return makeOkResponse();

  const response = await fetch(input, init);
  if (await isDisabledFetchResponse(response)) {
    uploadGate.disable(generation);
    return makeOkResponse();
  }
  return response;
}

function makeOkResponse(): Response {
  return new Response(null, { status: 200 });
}

async function isDisabledFetchResponse(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  const body = await response.clone().arrayBuffer();
  return uploadGate.isDisabledResponse(response.status, body);
}

function bodyToText(body: Uint8Array | ArrayBuffer | string): string {
  if (typeof body === 'string') return body;
  return Buffer.from(body instanceof ArrayBuffer ? new Uint8Array(body) : body).toString('utf8');
}

/**
 * OTLP trace exporter that applies the shared upload gate without modifying process-wide HTTP
 * functions.
 */
export class UploadGateTraceExporter extends OTLPTraceExporter {
  /** Exports spans, converting the known disabled response to synthetic success. */
  override export(items: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const generation = uploadGate.generation;
    if (uploadGate.disabled) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }

    super.export(items, (result) => {
      if (isDisabledTraceExport(result)) {
        uploadGate.disable(generation);
        resultCallback({ code: ExportResultCode.SUCCESS });
        return;
      }
      resultCallback(result);
    });
  }
}

function isDisabledTraceExport(result: ExportResult): boolean {
  const error = result.error;
  return (
    result.code === ExportResultCode.FAILED &&
    error instanceof OTLPExporterError &&
    uploadGate.isDisabledResponse(error.code ?? 0, error.data ?? '')
  );
}
