// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ClientOptions, Transport } from '@modelcontextprotocol/client';
import { vi } from 'vitest';
import { MCPServer } from './mcp.js';

const clientMock = vi.hoisted<{ client?: object; options?: ClientOptions }>(() => ({}));

export { clientMock };

vi.mock('@modelcontextprotocol/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Client: class {
    constructor(_info: unknown, options: ClientOptions) {
      if (!clientMock.client) throw new Error('MCP client mock was not configured');
      clientMock.options = options;
      return clientMock.client;
    }
  },
}));

export const descriptor = {
  name: 'lookup',
  description: 'lookup',
  inputSchema: { type: 'object' },
};

export async function attachClient(server: MCPServer, client: object): Promise<void> {
  clientMock.client = { connect: async () => {}, close: async () => {}, ...client };
  await server.initialize();
}

export class TestServer extends MCPServer {
  protected override async createTransport(): Promise<Transport> {
    return {
      start: async () => {},
      send: async () => {},
      close: async () => {},
    };
  }

  async emitToolsChanged(): Promise<void> {
    await this.notifyToolsChanged();
  }

  spyOnWarn() {
    return vi.spyOn(this.logger, 'warn').mockImplementation(() => {});
  }
}
