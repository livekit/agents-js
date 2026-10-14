// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Any, Duration, type Message, proto3 } from '@bufbuild/protobuf';
import { ThrowsPromise } from '@livekit/throws-transformer/throws';
import type FormData from 'form-data';
import { log } from '../log.js';
import { delay } from '../utils.js';

const TOTAL_TIMEOUT_MS = 900_000;
const CONNECT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** Error codes that mean the server did not receive the upload when they occur before TLS completes. */
const RETRYABLE_CONNECT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

interface RetryInfo extends Message<RetryInfo> {
  retryDelay?: Duration;
}

const RetryInfo = proto3.makeMessageType<RetryInfo>('google.rpc.RetryInfo', [
  { no: 1, name: 'retry_delay', kind: 'message', T: Duration },
]);

/** `google.rpc.Status` with only the field this module reads. */
interface RpcStatus extends Message<RpcStatus> {
  details: Any[];
}

const RpcStatus = proto3.makeMessageType<RpcStatus>('google.rpc.Status', [
  { no: 3, name: 'details', kind: 'message', T: Any, repeated: true },
]);

type UploadForm = Pick<FormData, 'submit'>;

interface UploadTarget {
  host: string;
  jwt: string;
}

interface UploadResponse {
  statusCode: number;
  statusMessage: string;
  body: Buffer;
}

interface UploadRetry {
  delayMs: number;
  failure: string;
  error: Error;
}

class ConnectTimeoutError extends Error {
  constructor() {
    super('Session report upload connection timed out');
    this.name = 'ConnectTimeoutError';
  }
}

class RecordingUploadError extends Error {
  constructor(
    override readonly cause: Error,
    readonly retryable: boolean,
  ) {
    super(`Failed to upload session report: ${cause.message}`, { cause });
    this.name = 'RecordingUploadError';
  }
}

/**
 * Upload a session recording to LiveKit Cloud. Retry connection failures and responses that
 * carry a `google.rpc.RetryInfo` detail, up to 3 times.
 */
export async function uploadRecording(
  buildForm: () => UploadForm,
  target: UploadTarget,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    log().debug('uploading session report to LiveKit Cloud');
    const retry = await attemptUpload(buildForm(), target, attempt);
    if (!retry) break;
    if (attempt === MAX_RETRIES) throw retry.error;

    log().warn(
      `recording upload failed (${retry.failure}, attempt ${attempt + 1}/${MAX_RETRIES + 1}), ` +
        `retrying in ${(retry.delayMs / 1000).toFixed(1)}s`,
    );
    await delay(retry.delayMs);
  }
  log().debug('finished uploading');
}

/** Return null on success or a retry plan for a retryable failure. Throw other failures. */
async function attemptUpload(
  form: UploadForm,
  target: UploadTarget,
  attempt: number,
): Promise<UploadRetry | null> {
  let res: UploadResponse;
  try {
    res = await submitRecording(form, target);
  } catch (error) {
    if (!(error instanceof RecordingUploadError && error.retryable)) throw error;
    return {
      delayMs: Math.random() * Math.min(2 ** attempt * 1000, 8000),
      failure: (error.cause as NodeJS.ErrnoException).code ?? error.cause.name,
      error,
    };
  }
  if (res.statusCode < 400) return null;

  const error = new Error(
    `Failed to upload session report: ${res.statusCode} ${res.statusMessage} - ${res.body.toString('utf-8')}`,
  );
  const delayMs = parseRetryDelayMs(res.body);
  if (delayMs === null) throw error;
  return { delayMs, failure: `status ${res.statusCode}`, error };
}

function submitRecording(form: UploadForm, target: UploadTarget): Promise<UploadResponse> {
  return new ThrowsPromise<UploadResponse, RecordingUploadError>((resolve, reject) => {
    let connected = false;

    const request = form.submit({
      protocol: 'https:',
      host: target.host,
      path: '/observability/recordings/v0',
      method: 'POST',
      headers: { Authorization: `Bearer ${target.jwt}` },
    });

    const connectTimer = setTimeout(
      () => request.destroy(new ConnectTimeoutError()),
      CONNECT_TIMEOUT_MS,
    ).unref();
    const totalTimer = setTimeout(
      () => request.destroy(new Error('Session report upload timed out')),
      TOTAL_TIMEOUT_MS,
    ).unref();

    const markConnected = () => {
      connected = true;
      clearTimeout(connectTimer);
    };
    const fail = (error: Error) => {
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
      const { code } = error as NodeJS.ErrnoException;
      const retryable =
        !connected &&
        (error instanceof ConnectTimeoutError ||
          (code !== undefined && RETRYABLE_CONNECT_CODES.has(code)));
      reject(new RecordingUploadError(error, retryable));
    };

    // Listen on the request instead of passing a submit callback. form-data removes its error
    // listener when the response arrives, so a later timeout or reset would be uncaught.
    request.on('error', fail);
    request.on('socket', (socket) => {
      if (request.reusedSocket) markConnected();
      else socket.once('secureConnect', markConnected);
    });
    request.once('response', (res) => {
      markConnected();
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', fail);
      res.on('end', () => {
        clearTimeout(totalTimer);
        resolve({
          statusCode: res.statusCode!,
          statusMessage: res.statusMessage!,
          body: Buffer.concat(chunks),
        });
      });
    });
  });
}

/** Return the delay from a `google.rpc.RetryInfo` detail, or null when the body has none. */
function parseRetryDelayMs(body: Buffer): number | null {
  try {
    const detail = RpcStatus.fromBinary(body).details.find((d) => d.is(RetryInfo));
    if (!detail) return null;
    const retryDelay = RetryInfo.fromBinary(detail.value).retryDelay;
    const ms = retryDelay ? Number(retryDelay.seconds) * 1000 + retryDelay.nanos / 1e6 : 0;
    return Math.min(Math.max(ms, 0), MAX_TIMER_DELAY_MS);
  } catch {
    return null;
  }
}
