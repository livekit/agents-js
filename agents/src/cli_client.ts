// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AgentDev } from '@livekit/protocol';
import { type Socket, createConnection } from 'node:net';
import { log } from './log.js';

/**
 * Client for the dev channel opened by the driving `lk` CLI (its address is
 * passed via `--cli-addr`). On connect it reports this agent server's
 * {@link AgentDev.ServerInfo | ServerInfo} (agent name + LiveKit URL, and that it
 * supports token mode) so the CLI can surface things like a Cloud console link.
 * It then reads the CLI's messages: Credentials carry a refreshed worker token
 * in token mode.
 *
 * This mirrors the Python `WatchClient`. Unlike Python, Node reloads are a plain
 * kill+respawn, so there is no running-job capture / restore. It is strictly
 * best-effort: a missing or broken dev channel must never take the agent down.
 */
export class CLIClient {
  #cliAddr: string;
  #agentName: string;
  #url: string;
  #onCredentials?: (token: string) => void;
  #socket?: Socket;

  /** @param onCredentials - called with each worker token the CLI sends (token mode) */
  constructor(
    cliAddr: string,
    agentName: string,
    url: string,
    onCredentials?: (token: string) => void,
  ) {
    this.#cliAddr = cliAddr;
    this.#agentName = agentName;
    this.#url = url;
    this.#onCredentials = onCredentials;
  }

  start(): void {
    const logger = log().child({ cliAddr: this.#cliAddr });

    // cli_addr is host:port; the host may itself contain ':' (IPv6), so split on
    // the last colon.
    const sep = this.#cliAddr.lastIndexOf(':');
    if (sep === -1) {
      logger.warn('invalid --cli-addr, skipping dev channel');
      return;
    }
    let host = this.#cliAddr.slice(0, sep);
    if (host.startsWith('[') && host.endsWith(']')) {
      host = host.slice(1, -1);
    }
    const port = Number.parseInt(this.#cliAddr.slice(sep + 1), 10);
    if (Number.isNaN(port) || port < 0 || port > 65535) {
      logger.warn('invalid port in --cli-addr, skipping dev channel');
      return;
    }

    try {
      const socket = createConnection({ host, port }, () => {
        const msg = new AgentDev.AgentDevMessage({
          message: {
            case: 'serverInfo',
            value: new AgentDev.ServerInfo({
              agentName: this.#agentName,
              url: this.#url,
              supportsTokenMode: true,
            }),
          },
        });
        this.#sendProto(socket, msg.toBinary());
      });

      // Messages are framed with a 4-byte big-endian length prefix and can span
      // or share 'data' chunks.
      let pending = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 4) {
          const length = pending.readUInt32BE(0);
          if (pending.length < 4 + length) break;
          const payload = pending.subarray(4, 4 + length);
          pending = pending.subarray(4 + length);
          this.#handleMessage(payload);
        }
      });

      // Best-effort: log and move on if the CLI isn't listening.
      socket.on('error', (err) => {
        logger.debug(`dev channel unavailable: ${err.message}`);
      });

      this.#socket = socket;
    } catch (err) {
      logger.debug(`dev channel unavailable: ${(err as Error).message}`);
    }
  }

  close(): void {
    this.#socket?.destroy();
    this.#socket = undefined;
  }

  #handleMessage(payload: Uint8Array): void {
    let msg: AgentDev.AgentDevMessage;
    try {
      msg = AgentDev.AgentDevMessage.fromBinary(payload);
    } catch (err) {
      log().debug(`invalid dev channel message: ${(err as Error).message}`);
      return;
    }
    // Other messages (the job capture / restore requests) are Python-only.
    if (msg.message.case === 'credentials') {
      this.#onCredentials?.(msg.message.value.token);
    }
  }

  /** Frames a message with a 4-byte big-endian length prefix (matches the Go CLI). */
  #sendProto(socket: Socket, payload: Uint8Array): void {
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(payload.length, 0);
    socket.write(Buffer.concat([header, payload]));
  }
}
