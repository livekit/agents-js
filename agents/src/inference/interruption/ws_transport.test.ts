// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { webSocketToStream } from './ws_transport.js';

/** Helper to create a WebSocket server and return its port */
async function createServer(): Promise<{ wss: WebSocketServer; port: number }> {
  const wss = await new Promise<WebSocketServer>((resolve) => {
    const server: WebSocketServer = new WebSocketServer({ port: 0 }, () => resolve(server));
  });
  const port = (wss.address() as { port: number }).port;
  return { wss, port };
}

/** Helper to create a connected WebSocket client */
async function createClient(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}`);
  // await new Promise<void>((resolve, reject) => {
  //   ws.once('open', resolve);
  //   ws.once('error', reject);
  // });
  return ws;
}

describe('webSocketToStream', () => {
  describe('readable stream', () => {
    it('receives messages from the WebSocket', async () => {
      const { wss, port } = await createServer();

      wss.on('connection', (serverWs) => {
        serverWs.send('hello');
        serverWs.send('world');
        serverWs.close();
      });

      const ws = await createClient(port);
      const { readable } = webSocketToStream(ws);
      const reader = readable.getReader();

      const messages: string[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          messages.push(Buffer.from(value).toString());
        }
      } finally {
        reader.releaseLock();
      }

      expect(messages).toEqual(['hello', 'world']);

      wss.close();
    });

    it('handles binary messages', async () => {
      const { wss, port } = await createServer();

      const binaryData = new Uint8Array([1, 2, 3, 4, 5]);

      wss.on('connection', (serverWs) => {
        serverWs.send(binaryData);
        serverWs.close();
      });

      const ws = await createClient(port);
      const { readable } = webSocketToStream(ws);
      const reader = readable.getReader();

      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(new Uint8Array(value));
        }
      } finally {
        reader.releaseLock();
      }

      expect(chunks).toHaveLength(1);
      expect(Array.from(chunks[0]!)).toEqual([1, 2, 3, 4, 5]);

      wss.close();
    });

    it('handles empty stream when connection closes immediately', async () => {
      const { wss, port } = await createServer();

      wss.on('connection', (serverWs) => {
        serverWs.close();
      });

      const ws = await createClient(port);
      const { readable } = webSocketToStream(ws);
      const reader = readable.getReader();

      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }

      expect(chunks).toEqual([]);

      wss.close();
    });
  });

  describe('writable stream', () => {
    it('sends messages through the WebSocket', async () => {
      const { wss, port } = await createServer();

      const messagesReceived: string[] = [];
      const serverClosed = new Promise<void>((resolve) => {
        wss.on('connection', (serverWs) => {
          serverWs.on('message', (data) => {
            messagesReceived.push(data.toString());
          });
          serverWs.on('close', resolve);
        });
      });

      const ws = await createClient(port);
      const { writable } = webSocketToStream(ws);
      const writer = writable.getWriter();

      await writer.write(new TextEncoder().encode('hello'));
      await writer.write(new TextEncoder().encode('world'));
      await writer.close();

      await serverClosed;

      expect(messagesReceived).toEqual(['hello', 'world']);

      wss.close();
    });

    it('sends binary data through the WebSocket', async () => {
      const { wss, port } = await createServer();

      const chunksReceived: Buffer[] = [];
      const serverClosed = new Promise<void>((resolve) => {
        wss.on('connection', (serverWs) => {
          serverWs.on('message', (data) => {
            chunksReceived.push(Buffer.from(data as Buffer));
          });
          serverWs.on('close', resolve);
        });
      });

      const ws = await createClient(port);
      const { writable } = webSocketToStream(ws);
      const writer = writable.getWriter();

      const binaryData = new Uint8Array([10, 20, 30, 40, 50]);
      await writer.write(binaryData);
      await writer.close();

      await serverClosed;

      expect(chunksReceived).toHaveLength(1);
      expect(Array.from(chunksReceived[0]!)).toEqual([10, 20, 30, 40, 50]);

      wss.close();
    });
  });

  describe('bidirectional communication', () => {
    it('supports echo pattern with readable and writable', async () => {
      const { wss, port } = await createServer();

      // Server echoes messages back
      wss.on('connection', (serverWs) => {
        serverWs.on('message', (data) => {
          serverWs.send(data);
        });
      });

      const ws = await createClient(port);
      const { readable, writable } = webSocketToStream(ws);
      const writer = writable.getWriter();
      const reader = readable.getReader();

      // Send messages
      await writer.write(new TextEncoder().encode('ping1'));
      await writer.write(new TextEncoder().encode('ping2'));

      // Read echoed responses
      const { value: response1 } = await reader.read();
      const { value: response2 } = await reader.read();

      expect(Buffer.from(response1!).toString()).toBe('ping1');
      expect(Buffer.from(response2!).toString()).toBe('ping2');

      reader.releaseLock();
      await writer.close();

      wss.close();
    });
  });

  describe('error handling', () => {
    it('readable stream ends when WebSocket closes unexpectedly', async () => {
      const { wss, port } = await createServer();

      wss.on('connection', (serverWs) => {
        serverWs.send('before close');
        // Terminate connection abruptly
        serverWs.terminate();
      });

      const ws = await createClient(port);
      const { readable } = webSocketToStream(ws);
      const reader = readable.getReader();

      const chunks: string[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(Buffer.from(value).toString());
        }
      } catch {
        // Connection terminated, stream may error
      } finally {
        reader.releaseLock();
      }

      // Should have received the message sent before termination
      expect(chunks).toContain('before close');

      wss.close();
    });
  });
});
