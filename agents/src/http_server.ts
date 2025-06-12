// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { log } from './log.js';

const healthCheck = async (res: ServerResponse) => {
  res.writeHead(200);
  res.end('OK');
};

interface WorkerResponse {
  agent_name: string;
  worker_type: string;
  active_jobs: number;
}

export class HTTPServer {
  host: string;
  port: number;
  app: Server;
  #logger = log();

  constructor(host: string, port: number, workerListener: () => WorkerResponse) {
    this.host = host;
    this.port = port;

    this.app = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/') {
        healthCheck(res);
      } else if (req.url === '/worker') {
        res.writeHead(200, { 'Contet-Type': 'application/json' });
        res.end(JSON.stringify(workerListener()));
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
        const address = this.app.address();
        if (typeof address! !== 'string') {
          this.#logger.info(`Server is listening on port ${address!.port}`);
        }
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
