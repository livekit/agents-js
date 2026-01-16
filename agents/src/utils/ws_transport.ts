import { Readable, Writable } from 'node:stream';
import WebSocket, { createWebSocketStream } from 'ws';

export function webSocketStream(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  const duplex = createWebSocketStream(ws);
  duplex.on('error', console.error);

  // End the write side when the read side ends to properly close the stream.
  // This is needed because Readable.toWeb() waits for both sides of the duplex
  // to close before signaling done on the ReadableStream.
  duplex.on('end', () => {
    duplex.end();
  });

  // Convert the writable side
  const writable = Writable.toWeb(duplex);
  // Convert the readable side
  const readable = Readable.toWeb(duplex);

  return { readable, writable, close: ws.close };
}
