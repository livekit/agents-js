// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type * as httpTypes from 'node:http';
import type * as httpsTypes from 'node:https';
import { createRequire } from 'node:module';

const DISABLED_MARKERS = ['data recording is disabled', 'disabled by owner'];

class UploadGate {
  private isDisabled = false;

  reset(): void {
    this.isDisabled = false;
  }

  get disabled(): boolean {
    return this.isDisabled;
  }

  disable(): void {
    if (this.isDisabled) return;
    this.isDisabled = true;
    console.warn(
      'LiveKit Cloud data recording is disabled for this project; ' +
        'skipping telemetry and recording uploads for this session',
    );
  }

  isDisabledResponse(statusCode: number, body: Uint8Array | ArrayBuffer | string): boolean {
    if (statusCode !== 401) return false;
    const text = bodyToText(body).toLowerCase();
    return DISABLED_MARKERS.some((marker) => text.includes(marker));
  }
}

export const uploadGate = new UploadGate();

export async function fetchWithUploadGate(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (uploadGate.disabled) return makeOkResponse();

  const response = await fetch(input, init);
  if (await isDisabledFetchResponse(response)) {
    uploadGate.disable();
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

const otlpHttpTargets = new Set<string>();
let otlpHttpInterceptorInstalled = false;

export function registerOtlpHttpUploadGateTarget(rawUrl: string): void {
  const url = new URL(rawUrl);
  otlpHttpTargets.add(requestTargetKey(url.hostname, url.port, url.pathname));
  installOtlpHttpInterceptor();
}

function installOtlpHttpInterceptor(): void {
  if (otlpHttpInterceptorInstalled) return;
  otlpHttpInterceptorInstalled = true;

  const require = createRequire(import.meta.url);
  const httpModule = require('node:http') as typeof httpTypes;
  const httpsModule = require('node:https') as typeof httpsTypes;

  httpModule.request = wrapRequest(httpModule.request as RequestFn) as typeof httpModule.request;
  httpsModule.request = wrapRequest(httpsModule.request as RequestFn) as typeof httpsModule.request;
}

type RequestArg =
  | string
  | URL
  | httpTypes.RequestOptions
  | ((res: httpTypes.IncomingMessage) => void)
  | undefined;
type RequestFn = (...args: RequestArg[]) => httpTypes.ClientRequest;

function wrapRequest(original: RequestFn) {
  return (...args: RequestArg[]): httpTypes.ClientRequest => {
    if (!matchesRegisteredTarget(args)) {
      return original(...args);
    }

    const callbackIndex = args.findIndex((arg) => typeof arg === 'function');
    if (callbackIndex === -1) {
      return original(...args);
    }

    const callback = args[callbackIndex] as (res: httpTypes.IncomingMessage) => void;
    args[callbackIndex] = (res: httpTypes.IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        if (uploadGate.isDisabledResponse(res.statusCode ?? 0, Buffer.concat(chunks))) {
          uploadGate.disable();
          res.statusCode = 200;
          res.statusMessage = 'OK';
        }
      });
      callback(res);
    };

    return original(...args);
  };
}

function matchesRegisteredTarget(args: unknown[]): boolean {
  const target = getRequestTarget(args);
  return target !== undefined && otlpHttpTargets.has(target);
}

function getRequestTarget(args: unknown[]): string | undefined {
  const first = args[0];
  const second = args[1];

  if (typeof first === 'string' || first instanceof URL) {
    const url = new URL(first);
    const options = isRequestOptions(second) ? second : {};
    const hostname = options.hostname ?? options.host?.split(':')[0] ?? url.hostname;
    const port = options.port?.toString() ?? url.port;
    const path = options.path?.toString() ?? url.pathname;
    return requestTargetKey(hostname, port, path.split('?')[0] ?? path);
  }

  if (isRequestOptions(first)) {
    const hostname = first.hostname ?? first.host?.split(':')[0];
    if (!hostname) return undefined;
    const port = first.port?.toString() ?? '';
    const path = first.path?.toString() ?? '/';
    return requestTargetKey(hostname, port, path.split('?')[0] ?? path);
  }

  return undefined;
}

function isRequestOptions(value: unknown): value is httpTypes.RequestOptions {
  return typeof value === 'object' && value !== null;
}

function requestTargetKey(
  hostname: string,
  port: string | number | undefined,
  path: string,
): string {
  return `${hostname}:${port ?? ''}:${path}`;
}
