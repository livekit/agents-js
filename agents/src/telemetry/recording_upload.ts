// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Any, Duration, type Message, proto3 } from '@bufbuild/protobuf';
import { ThrowsPromise } from '@livekit/throws-transformer/throws';
import type FormData from 'form-data';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import { log } from '../log_core.js';
import { delay } from '../utils.js';
import { uploadGate } from './upload_gate.js';

export const RECORDING_UPLOAD_CONNECT_TIMEOUT_MS = 30_000;
export const RECORDING_UPLOAD_TOTAL_TIMEOUT_MS = 900_000;

const RECORDING_UPLOAD_MAX_RETRIES = 3;
const RETRYABLE_CONNECTION_ERROR_CODES = new Set([
  'EADDRNOTAVAIL',
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
]);

interface RetryInfo extends Message<RetryInfo> {
  retryDelay?: Duration;
}

const RetryInfo = proto3.makeMessageType<RetryInfo>('google.rpc.RetryInfo', () => [
  { no: 1, name: 'retry_delay', kind: 'message', T: Duration },
]);

interface RpcStatus extends Message<RpcStatus> {
  details: Any[];
}

const RpcStatus = proto3.makeMessageType<RpcStatus>('google.rpc.Status', () => [
  { no: 3, name: 'details', kind: 'message', T: Any, repeated: true },
]);

type UploadResponse = {
  statusCode: number;
  body: Buffer;
};

class RecordingUploadAttemptError extends Error {
  constructor(
    readonly failure: string,
    readonly retryableConnectionFailure: boolean,
  ) {
    super(`Failed to upload session report: ${failure}`);
    this.name = 'RecordingUploadAttemptError';
  }
}

export async function uploadRecording(options: {
  observabilityUrl: string;
  jwt: string;
  createFormData: () => FormData;
}): Promise<void> {
  const uploadGeneration = uploadGate.generation;

  for (let attempt = 0; attempt <= RECORDING_UPLOAD_MAX_RETRIES; attempt += 1) {
    if (uploadGate.disabled) return;

    let retry: { delayMs: number; failure: string } | undefined;
    try {
      const response = await submitRecordingUpload({
        observabilityUrl: options.observabilityUrl,
        jwt: options.jwt,
        formData: options.createFormData(),
      });

      if (response.statusCode < 400) return;
      if (uploadGate.isDisabledResponse(response.statusCode, response.body)) {
        uploadGate.disable(uploadGeneration);
        return;
      }

      const retryDelayMs = parseRetryDelay(response.body);
      if (retryDelayMs === undefined || attempt === RECORDING_UPLOAD_MAX_RETRIES) {
        throw new RecordingUploadAttemptError(`status ${response.statusCode}`, false);
      }
      retry = { delayMs: retryDelayMs, failure: `status ${response.statusCode}` };
    } catch (error) {
      if (
        !(error instanceof RecordingUploadAttemptError) ||
        !error.retryableConnectionFailure ||
        attempt === RECORDING_UPLOAD_MAX_RETRIES
      ) {
        throw error;
      }
      retry = { delayMs: recordingUploadRetryDelay(attempt), failure: error.failure };
    }

    log().warn(
      {
        failure: retry.failure,
        attempt: attempt + 1,
        maxAttempts: RECORDING_UPLOAD_MAX_RETRIES + 1,
        retryDelaySeconds: retry.delayMs / 1_000,
      },
      'recording upload failed; retrying',
    );
    await delay(retry.delayMs);
  }
}

function recordingUploadRetryDelay(attempt: number): number {
  return Math.random() * Math.min(2 ** attempt, 8) * 1_000;
}

function parseRetryDelay(body: Uint8Array): number | undefined {
  try {
    const status = RpcStatus.fromBinary(body);
    for (const detail of status.details) {
      if (!detail.is(RetryInfo)) continue;
      const duration = RetryInfo.fromBinary(detail.value).retryDelay;
      if (!duration) return 0;
      return Number(duration.seconds) * 1_000 + duration.nanos / 1_000_000;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function submitRecordingUpload(options: {
  observabilityUrl: string;
  jwt: string;
  formData: FormData;
}): Promise<UploadResponse> {
  return new ThrowsPromise<UploadResponse, Error>((resolve, reject) => {
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let socket: Socket | undefined;
    let socketReadyEvent: 'connect' | 'secureConnect' | undefined;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let totalTimer: ReturnType<typeof setTimeout> | undefined;
    let connected = false;
    let settled = false;

    const clearConnectTimer = () => {
      if (connectTimer !== undefined) clearTimeout(connectTimer);
      connectTimer = undefined;
    };
    const markConnected = () => {
      connected = true;
      clearConnectTimer();
    };
    const cleanup = () => {
      clearConnectTimer();
      if (totalTimer !== undefined) clearTimeout(totalTimer);
      totalTimer = undefined;
      request?.removeListener('socket', onSocket);
      if (socket && socketReadyEvent) socket.removeListener(socketReadyEvent, markConnected);
      options.formData.removeListener('error', onFormError);
    };
    const succeed = (value: UploadResponse) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = (error: RecordingUploadAttemptError) => {
      fail(error);
      if (response) response.destroy();
      else request?.destroy(error);
    };
    const onSocket = (assignedSocket: Socket) => {
      socket = assignedSocket;
      if (assignedSocket instanceof TLSSocket) {
        if (!assignedSocket.connecting && assignedSocket.getProtocol() !== null) {
          markConnected();
          return;
        }
        socketReadyEvent = 'secureConnect';
      } else {
        if (!assignedSocket.connecting) {
          markConnected();
          return;
        }
        socketReadyEvent = 'connect';
      }
      assignedSocket.once(socketReadyEvent, markConnected);
    };
    const onFormError = () => {
      fail(new RecordingUploadAttemptError('multipart body error', false));
      request?.destroy();
    };

    options.formData.once('error', onFormError);
    try {
      // form-data takes host and port separately, so a port in the endpoint must not stay
      // glued to the hostname — Node would resolve "host:port" as a domain name.
      const endpoint = new URL(`${options.observabilityUrl}/observability/recordings/v0`);
      if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
        fail(new RecordingUploadAttemptError(`unsupported scheme ${endpoint.protocol}`, false));
        return;
      }

      request = options.formData.submit(
        {
          protocol: endpoint.protocol,
          host: endpoint.hostname,
          ...(endpoint.port ? { port: Number(endpoint.port) } : {}),
          path: `${endpoint.pathname}${endpoint.search}`,
          method: 'POST',
          headers: { Authorization: `Bearer ${options.jwt}` },
        },
        (error, incomingResponse) => {
          if (error) {
            const failure = requestFailureName(error);
            fail(
              new RecordingUploadAttemptError(
                failure,
                !connected && isRetryableConnectionError(error),
              ),
            );
            return;
          }

          response = incomingResponse;
          markConnected();
          const chunks: Buffer[] = [];
          const collectBody = (incomingResponse.statusCode ?? 0) >= 400;
          incomingResponse.on('data', (chunk) => {
            if (collectBody) chunks.push(Buffer.from(chunk));
          });
          incomingResponse.once('error', () => {
            fail(
              new RecordingUploadAttemptError(
                `response body error (status ${incomingResponse.statusCode ?? 0})`,
                false,
              ),
            );
          });
          incomingResponse.once('end', () => {
            succeed({
              statusCode: incomingResponse.statusCode ?? 0,
              body: Buffer.concat(chunks),
            });
          });
          incomingResponse.resume();
        },
      );
    } catch {
      fail(new RecordingUploadAttemptError('request setup error', false));
      return;
    }

    if (settled) return;
    if (request.socket) onSocket(request.socket);
    else request.once('socket', onSocket);

    if (!connected) {
      connectTimer = setTimeout(() => {
        abort(
          new RecordingUploadAttemptError(
            `connection timed out after ${RECORDING_UPLOAD_CONNECT_TIMEOUT_MS / 1_000} seconds`,
            true,
          ),
        );
      }, RECORDING_UPLOAD_CONNECT_TIMEOUT_MS);
      connectTimer.unref?.();
    }

    totalTimer = setTimeout(() => {
      abort(
        new RecordingUploadAttemptError(
          `request timed out after ${RECORDING_UPLOAD_TOTAL_TIMEOUT_MS / 1_000} seconds`,
          false,
        ),
      );
    }, RECORDING_UPLOAD_TOTAL_TIMEOUT_MS);
    totalTimer.unref?.();
  });
}

function requestFailureName(error: Error): string {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'request error';
}

function isRetryableConnectionError(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' && RETRYABLE_CONNECTION_ERROR_CODES.has(code);
}
