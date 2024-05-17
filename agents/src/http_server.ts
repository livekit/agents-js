// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'http';

const healthCheck = async (res: ServerResponse) => {
  res.writeHead(200);
  res.end('OK');
};

export class HTTPServer {
  host: string;
  port: number;
  app: Server;

  constructor(host: string, port: number) {
    this.host = host;
    this.port = port;

    this.app = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/') {
        healthCheck(res);
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
  }

  async run(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.app.listen(this.port, this.host, (err?: Error) => {
        if (err) reject(err);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.app.close((err?: Error) => {
        if (err) reject(err);
        resolve();
      });
    });
  }
}
