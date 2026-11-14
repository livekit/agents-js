// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  CreateJobTokenRequest,
  type CreateJobTokenResponse,
  WorkerMessage,
} from '@livekit/protocol';
import { type TokenSource, claimsToJwtPayload } from 'livekit-server-sdk';
import { randomUUID } from 'node:crypto';

/** How long the worker waits for the server to answer a CreateJobTokenRequest. */
export const CREATE_JOB_TOKEN_TIMEOUT = 5000;

/**
 * How long a job waits for its worker to answer a job token request. Above the worker's limit
 * for the server, so that this one ends the wait only when the worker itself does not answer.
 */
export const JOB_TOKEN_IPC_TIMEOUT = CREATE_JOB_TOKEN_TIMEOUT + 1000;

/**
 * The worker token in token mode, where the agent holds no API key or secret and is given a
 * pre-minted token in `LIVEKIT_TOKEN` instead; undefined in key mode.
 *
 * The worker exports the token to the environment, so its job processes inherit it. This is the
 * one place the token is read, so a refreshed token only has to be put where this reads it.
 */
export function getWorkerToken(): string | undefined {
  if (process.env.LIVEKIT_API_KEY || process.env.LIVEKIT_API_SECRET) return undefined;
  return process.env.LIVEKIT_TOKEN || undefined;
}

/** A token the server issued for a job. */
export interface JobToken {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/**
 * The worker's side of CreateJobToken: sends a job's requests on the worker connection, and
 * matches the server's responses to them by request id.
 */
export class CreateJobTokenRequests {
  #send: (msg: WorkerMessage) => boolean;
  #timeout: number;
  #pending = new Map<
    string,
    {
      resolve: (token: JobToken) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  /** @param send - sends on the worker connection; returns false when there is none */
  constructor(send: (msg: WorkerMessage) => boolean, timeout = CREATE_JOB_TOKEN_TIMEOUT) {
    this.#send = send;
    this.#timeout = timeout;
  }

  /**
   * Asks the server for a token with these claims (JSON, the payload of an access token) for a
   * job this worker runs. Rejects at once when the worker is not connected, with the server's
   * error when it refuses, and after the timeout when it does not answer.
   */
  request(jobId: string, claims: string): Promise<JobToken> {
    const requestId = randomUUID();
    return new Promise<JobToken>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(
          new Error(
            `the LiveKit server did not answer the job token request in ${this.#timeout}ms`,
          ),
        );
      }, this.#timeout);
      this.#pending.set(requestId, { resolve, reject, timer });
      const sent = this.#send(
        new WorkerMessage({
          message: {
            case: 'createJobToken',
            value: new CreateJobTokenRequest({ requestId, jobId, claims }),
          },
        }),
      );
      if (!sent) {
        this.#pending.delete(requestId);
        clearTimeout(timer);
        reject(
          new Error(
            'cannot ask for a job token: the worker is not connected to the LiveKit server',
          ),
        );
      }
    });
  }

  /** @returns false when no request waits for this response (it timed out, or is not ours) */
  handleResponse(res: CreateJobTokenResponse): boolean {
    const pending = this.#pending.get(res.requestId);
    if (!pending) return false;
    this.#pending.delete(res.requestId);
    clearTimeout(pending.timer);
    if (res.error) {
      pending.reject(new Error(`the LiveKit server refused CreateJobToken: ${res.error}`));
    } else {
      pending.resolve({ token: res.token, expiresAt: Number(res.expiresAt) * 1000 });
    }
    return true;
  }
}

/**
 * The job's side of CreateJobToken: gets the job's tokens from the server, through its worker,
 * and keeps each one, per claims, until half of its lifetime has passed.
 */
export class JobTokenClient {
  #createJobToken: (claims: string) => Promise<JobToken>;
  #cache = new Map<string, { token: string; renewAt: number }>();
  #inflight = new Map<string, Promise<string>>();

  /** @param createJobToken - asks the worker for a token with these claims */
  constructor(createJobToken: (claims: string) => Promise<JobToken>) {
    this.#createJobToken = createJobToken;
  }

  /** Returns a token with these claims (JSON, the payload of an access token). */
  token(claims: string): Promise<string> {
    const cached = this.#cache.get(claims);
    if (cached && Date.now() < cached.renewAt) return Promise.resolve(cached.token);

    let inflight = this.#inflight.get(claims);
    if (!inflight) {
      inflight = this.#create(claims).finally(() => this.#inflight.delete(claims));
      this.#inflight.set(claims, inflight);
    }
    return inflight;
  }

  /** For the server SDK clients: a token with the grants each call needs. */
  tokenSource: TokenSource = (grants) => this.token(JSON.stringify(claimsToJwtPayload(grants)));

  async #create(claims: string): Promise<string> {
    const requestedAt = Date.now();
    const { token, expiresAt } = await this.#createJobToken(claims);
    this.#cache.set(claims, { token, renewAt: requestedAt + (expiresAt - requestedAt) / 2 });
    return token;
  }
}
