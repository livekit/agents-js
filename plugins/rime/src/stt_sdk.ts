// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIConnectionError, APIError, APIStatusError, APITimeoutError } from '@livekit/agents';

// Deliberately structural: public declarations must not resolve the optional SDK.
export interface RequestOptions {
  language: string;
  mode: 'written' | 'verbatim';
  contextTerms: string[];
  timeout: number;
  signal: AbortSignal;
  outputContract?: 'revised_hypotheses' | 'append_fragments';
}
export interface Transcript {
  text: string;
  language: string;
  requestId: string | null;
}
export interface TranscriptUpdate {
  kind: 'partial' | 'delta' | 'final';
  text: string;
  language?: string;
}
export interface SDKStream extends AsyncIterable<TranscriptUpdate> {
  requestId: string | null;
  cancel(): Promise<void>;
}
export interface SDKClient {
  stt: {
    transcribe(audio: Uint8Array, options: RequestOptions): Promise<Transcript>;
    stream(audio: AsyncIterable<Uint8Array>, options: RequestOptions): SDKStream;
  };
  close(): Promise<void>;
}
type SDKError = Error & { requestId: string | null };
export interface SDK {
  Rime: new (options: { apiKey: string }) => SDKClient;
  RimeError: new (...args: never[]) => SDKError;
  RimeTimeoutError: new (...args: never[]) => SDKError;
  RimeUnavailableError: new (...args: never[]) => SDKError;
  RimeAuthenticationError: new (...args: never[]) => SDKError;
  RimePermissionError: new (...args: never[]) => SDKError;
  RimeInputError: new (...args: never[]) => SDKError;
  RimeAudioFormatError: new (...args: never[]) => SDKError;
  RimeResourceLimitError: new (...args: never[]) => SDKError;
  RimeCancelledError: new (...args: never[]) => SDKError;
}

export async function loadSDK(): Promise<SDK> {
  try {
    // Native import() must survive the CJS build: the SDK is ESM-only.
    const specifier = '@rimelabs/sdk';
    return await import(specifier);
  } catch {
    throw new APIError('Install @rimelabs/sdk (>=0.1.0-alpha.18 <0.1.0) to use Rime STT', {
      retryable: false,
    });
  }
}

export function cancelled(): APIError {
  return new APIError('Rime STT request cancelled', { retryable: false });
}

/** Wait without retaining an abort listener after either outcome. Observes late rejections. */
export async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {});
    throw signal.reason;
  }
  let listener!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    listener = () => reject(signal.reason);
    signal.addEventListener('abort', listener, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener('abort', listener);
  }
}

export function mapError(
  error: unknown,
  sdk?: SDK,
  streaming = false,
  override?: APIError,
): APIError {
  if (error instanceof APIError && !override) return error;
  let mapped: APIError;
  let requestId: string | null = null;
  if (sdk && error instanceof sdk.RimeError) {
    requestId = error.requestId;
    const options = { retryable: !streaming };
    if (override) mapped = override;
    else if (error instanceof sdk.RimeTimeoutError) {
      mapped = new APITimeoutError({ message: 'Rime STT request timed out', options });
    } else if (error instanceof sdk.RimeUnavailableError) {
      mapped = new APIConnectionError({ message: 'Rime STT service unavailable', options });
    } else {
      let message = 'Rime STT request failed';
      if (error instanceof sdk.RimeAuthenticationError) message = 'Rime STT authentication failed';
      else if (error instanceof sdk.RimePermissionError) message = 'Rime STT permission denied';
      else if (error instanceof sdk.RimeInputError || error instanceof sdk.RimeAudioFormatError)
        message = 'Rime STT rejected the input';
      else if (error instanceof sdk.RimeResourceLimitError)
        message = 'Rime STT resource limit exceeded';
      else if (error instanceof sdk.RimeCancelledError) message = 'Rime STT request cancelled';
      mapped = new APIStatusError({ message, options: { requestId, retryable: false } });
    }
  } else {
    mapped = override ?? new APIError('Rime STT request failed', { retryable: false });
  }
  // Connection errors have no requestId field and discard body in their constructors.
  if (requestId) Object.defineProperty(mapped, 'body', { value: { request_id: requestId } });
  return mapped;
}
