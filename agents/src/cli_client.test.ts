// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AgentDev } from '@livekit/protocol';
import { once } from 'node:events';
import { type AddressInfo, type Server, type Socket, createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIClient } from './cli_client.js';
import { initializeLogger } from './log.js';

initializeLogger({ pretty: false, level: 'silent' });

const frame = (msg: AgentDev.AgentDevMessage): Buffer => {
  const payload = msg.toBinary();
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
};

const credentials = (token: string) =>
  new AgentDev.AgentDevMessage({
    message: {
      case: 'credentials',
      value: new AgentDev.Credentials({ url: 'wss://x', token, expiresAt: 1n }),
    },
  });

describe('CLIClient', () => {
  let server: Server | undefined;
  let client: CLIClient | undefined;

  afterEach(() => {
    client?.close();
    server?.close();
  });

  it('reports token-mode support, and hands on each worker token the CLI sends', async () => {
    // the stand-in CLI: gets the agent's connection
    server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const connected = once(server, 'connection') as Promise<[Socket]>;

    const onCredentials = vi.fn();
    const port = (server.address() as AddressInfo).port;
    client = new CLIClient(`127.0.0.1:${port}`, 'my-agent', 'wss://one.test', onCredentials);
    client.start();
    const [cli] = await connected;

    const [data] = (await once(cli, 'data')) as [Buffer];
    const info = AgentDev.AgentDevMessage.fromBinary(data.subarray(4, 4 + data.readUInt32BE(0)));
    expect(info.message.case).toBe('serverInfo');
    expect(info.message.value).toMatchObject({
      agentName: 'my-agent',
      url: 'wss://one.test',
      supportsTokenMode: true,
    });

    // two messages in one chunk, then one split across chunks
    const second = frame(credentials('second'));
    cli.write(Buffer.concat([frame(credentials('first')), second.subarray(0, 3)]));
    await vi.waitFor(() => expect(onCredentials).toHaveBeenCalledTimes(1));
    cli.write(Buffer.concat([second.subarray(3), frame(credentials('third'))]));
    await vi.waitFor(() => expect(onCredentials).toHaveBeenCalledTimes(3));
    expect(onCredentials.mock.calls).toEqual([['first'], ['second'], ['third']]);
  });
});
