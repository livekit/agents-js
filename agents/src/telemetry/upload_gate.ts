// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type * as httpTypes from 'node:http';
import type * as httpsTypes from 'node:https';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { Readable, Writable } from 'node:stream';

const DISABLED_MARKERS = ['data recording is disabled', 'disabled by owner'];

class UploadGate {
  private isDisabled = false;
  private currentGeneration = 0;

  reset(): void {
    this.isDisabled = false;
    this.currentGeneration += 1;
    resetOtlpHttpInterceptor();
  }

  get disabled(): boolean {
    return this.isDisabled;
  }

  get generation(): number {
    return this.currentGeneration;
  }

  disable(generation: number = this.currentGeneration): void {
    if (generation !== this.currentGeneration) return;
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

const otlpHttpTargets = new Set<string>();
let otlpHttpInterceptorInstalled = false;
let originalHttpRequest: RequestFn | undefined;
let originalHttpsRequest: RequestFn | undefined;
let installedHttpRequest: RequestFn | undefined;
let installedHttpsRequest: RequestFn | undefined;

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

  originalHttpRequest = httpModule.request as RequestFn;
  originalHttpsRequest = httpsModule.request as RequestFn;
  installedHttpRequest = wrapRequest(originalHttpRequest);
  installedHttpsRequest = wrapRequest(originalHttpsRequest);
  httpModule.request = installedHttpRequest as typeof httpModule.request;
  httpsModule.request = installedHttpsRequest as typeof httpsModule.request;
  // OpenTelemetry 2.x loads request through ESM, which may already have cached the old binding.
  syncBuiltinESMExports();
}

function resetOtlpHttpInterceptor(): void {
  otlpHttpTargets.clear();
  if (!otlpHttpInterceptorInstalled) return;

  const require = createRequire(import.meta.url);
  const httpModule = require('node:http') as typeof httpTypes;
  const httpsModule = require('node:https') as typeof httpsTypes;
  if (originalHttpRequest && httpModule.request === installedHttpRequest) {
    httpModule.request = originalHttpRequest as typeof httpModule.request;
  }
  if (originalHttpsRequest && httpsModule.request === installedHttpsRequest) {
    httpsModule.request = originalHttpsRequest as typeof httpsModule.request;
  }
  syncBuiltinESMExports();
  originalHttpRequest = undefined;
  originalHttpsRequest = undefined;
  installedHttpRequest = undefined;
  installedHttpsRequest = undefined;
  otlpHttpInterceptorInstalled = false;
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
    if (uploadGate.disabled) {
      return makeOkClientRequest(callback);
    }
    const generation = uploadGate.generation;

    args[callbackIndex] = (res: httpTypes.IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        if (uploadGate.isDisabledResponse(res.statusCode ?? 0, Buffer.concat(chunks))) {
          uploadGate.disable(generation);
          res.statusCode = 200;
          res.statusMessage = 'OK';
        }
      });
      callback(res);
    };

    return original(...args);
  };
}

function makeOkClientRequest(
  callback: (res: httpTypes.IncomingMessage) => void,
): httpTypes.ClientRequest {
  const request = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  }) as unknown as httpTypes.ClientRequest;
  request.setTimeout = () => request;
  request.setHeader = () => request;
  request.once('finish', () => {
    const response = Readable.from([]) as unknown as httpTypes.IncomingMessage;
    response.statusCode = 200;
    response.statusMessage = 'OK';
    response.headers = {};
    callback(response);
  });
  return request;
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
