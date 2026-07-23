// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AgentDev } from '@livekit/protocol';
import { type Socket, createConnection } from 'node:net';
import { log } from './log.js';

/**
 * Client for the dev channel opened by the driving `lk` CLI (its address is
 * passed via `--cli-addr`). On connect it reports this agent server's
 * {@link AgentDev.ServerInfo | ServerInfo} (agent name + LiveKit URL) so the CLI
 * can surface things like a Cloud console link.
 *
 * This mirrors the Python `WatchClient`'s ServerInfo handshake. Unlike Python,
 * Node reloads are a plain kill+respawn, so there is no running-job capture /
 * restore — the client only sends ServerInfo. It is strictly best-effort: a
 * missing or broken dev channel must never take the agent down.
 */
export class CLIClient {
  #cliAddr: string;
  #agentName: string;
  #url: string;
  #socket?: Socket;

  constructor(cliAddr: string, agentName: string, url: string) {
    this.#cliAddr = cliAddr;
    this.#agentName = agentName;
    this.#url = url;
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
            value: new AgentDev.ServerInfo({ agentName: this.#agentName, url: this.#url }),
          },
        });
        this.#sendProto(socket, msg.toBinary());
      });

      // Best-effort: log and move on if the CLI isn't listening.
      socket.on('error', (err) => {
        logger.debug({ 'lk.pii.error': err }, 'dev channel unavailable');
      });

      this.#socket = socket;
    } catch (err) {
      logger.debug({ 'lk.pii.error': err }, 'dev channel unavailable');
    }
  }

  close(): void {
    this.#socket?.destroy();
    this.#socket = undefined;
  }

  /** Frames a message with a 4-byte big-endian length prefix (matches the Go CLI). */
  #sendProto(socket: Socket, payload: Uint8Array): void {
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(payload.length, 0);
    socket.write(Buffer.concat([header, payload]));
  }
}
