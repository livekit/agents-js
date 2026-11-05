// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { voice } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { type WebSocket, WebSocketServer } from 'ws';

export interface Request {
  type: string;
  event_id: string;
  session?: Record<string, unknown>;
  item?: Record<string, string>;
  response?: { metadata?: Record<string, string> };
  response_id?: string;
  item_id?: string;
  audio_end_ms?: number;
  audio?: string;
}

/** A local protocol peer. Tests use the real published SDK on the other end. */
export class PrismPeer {
  private server!: WebSocketServer;
  socket!: WebSocket;
  endpoint = '';
  requests: Request[] = [];
  history: Record<string, string>[] = [];
  revision = 0;
  settings: Record<string, unknown> = {};
  autoInitialize = true;
  autoReady = true;
  onRequest?: (request: Request) => boolean | void;
  private count = 0;

  async start(): Promise<this> {
    this.server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    this.server.on('connection', (socket) => {
      this.socket = socket;
      socket.on('message', (data) => {
        const request = JSON.parse(data.toString()) as Request;
        this.requests.push(request);
        if (this.onRequest?.(request)) return;
        if (request.type === 'session.update' && this.autoInitialize) {
          this.settings = { ...this.settings, ...request.session };
          this.emit('session.updated', {
            prism_request_event_id: request.event_id,
            session: {
              id: 'session-1',
              voice: this.settings.voice ?? 'test',
              prism_settings_revision: ++this.revision,
              prism_effective_interrupt_response: true,
              prism_response_metadata: this.settings.prism_response_metadata ?? {},
              truncation: this.settings.truncation ?? 'auto',
            },
          });
          if (this.autoReady) this.ready();
        } else if (request.type === 'conversation.item.create') {
          const item = { ...request.item!, id: `history-${++this.count}` };
          this.history.push(item);
          this.emit('conversation.item.created', {
            prism_request_event_id: request.event_id,
            item,
          });
        } else if (request.type === 'prism.conversation.get') {
          this.emit('prism.conversation', {
            prism_request_event_id: request.event_id,
            items: this.history,
          });
        } else if (request.type === 'conversation.item.delete') {
          const item = this.history.find((value) => value.id === request.item_id);
          this.history = this.history.filter(
            (value) =>
              value.id !== request.item_id && (!item?.call_id || value.call_id !== item.call_id),
          );
          this.emit('conversation.item.deleted', {
            prism_request_event_id: request.event_id,
            item_id: request.item_id,
          });
        } else if (request.type === 'response.cancel') {
          this.emit('response.done', {
            prism_request_event_id: request.event_id,
            response: { id: request.response_id, status: 'cancelled' },
          });
          this.ready();
        } else if (request.type === 'conversation.item.truncate') {
          this.emit('conversation.item.truncated', {
            prism_request_event_id: request.event_id,
            item_id: request.item_id,
            content_index: 0,
            audio_end_ms: request.audio_end_ms,
          });
        } else if (request.type === 'input_audio_buffer.clear') {
          this.emit('input_audio_buffer.cleared', { prism_request_event_id: request.event_id });
        }
      });
      this.emit('session.created', { session: { id: 'session-1' } });
    });
    await once(this.server, 'listening');
    this.endpoint = `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1/realtime`;
    return this;
  }
  emit(type: string, body: Record<string, unknown> = {}): void {
    this.socket.send(JSON.stringify({ type, event_id: `server-${++this.count}`, ...body }));
  }
  ready(): void {
    this.emit('prism.typed_input.ready');
  }
  accepted(request?: Request, id = 'reply-1', revision = this.revision): void {
    this.emit('response.created', {
      ...(request ? { prism_request_event_id: request.event_id } : {}),
      response: {
        id,
        prism_settings_revision: revision,
        metadata: request?.response?.metadata ?? {},
      },
    });
  }
  message(id = 'reply-1', itemId = `message-${id}`): void {
    this.emit('response.output_item.added', {
      response_id: id,
      output_index: 0,
      item: { type: 'message', id: itemId },
    });
  }
  text(text = 'Hello', id = 'reply-1', done = false): void {
    this.emit(done ? 'response.text.done' : 'response.text.delta', {
      response_id: id,
      item_id: `message-${id}`,
      output_index: 0,
      content_index: 0,
      ...(done ? { text } : { delta: text }),
    });
  }
  audio(id = 'reply-1'): void {
    this.emit('response.audio.delta', {
      response_id: id,
      item_id: `message-${id}`,
      output_index: 0,
      content_index: 0,
      delta: Buffer.alloc(4800, 1).toString('base64'),
    });
  }
  tool(id = 'reply-1', callId = 'call-1', name = 'lookup'): void {
    this.emit('response.function_call_arguments.done', {
      response_id: id,
      item_id: `item-${callId}`,
      call_id: callId,
      name,
      arguments: '{}',
    });
    this.history.push({
      id: `item-${callId}`,
      type: 'function_call',
      call_id: callId,
      name,
      arguments: '{}',
    });
  }
  ended(id = 'reply-1', status = 'completed'): void {
    this.emit('response.done', {
      response: { id, status, metadata: { prism_drain_token: `drain-${id}` } },
    });
    this.ready();
  }
  reply(request: Request, id = 'reply-1', audio = true): void {
    this.accepted(request, id);
    this.message(id);
    this.text('Hello', id);
    if (audio) this.audio(id);
    this.ended(id);
  }
  fault(request: Request, code: string, scope = 'event'): void {
    this.emit('error', {
      error: {
        code,
        scope,
        message: 'unsafe secret provider text',
        owner: { event_id: request.event_id },
      },
    });
  }
  async close(): Promise<void> {
    for (const socket of this.server.clients) socket.terminate();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

export class TestAudioOutput extends voice.AudioOutput {
  frames: AudioFrame[] = [];
  hold = false;
  constructor() {
    super(24000);
  }
  override async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    this.frames.push(frame);
    this.onPlaybackStarted(Date.now());
  }
  override flush(): void {
    super.flush();
    if (!this.hold)
      this.onPlaybackFinished({ playbackPosition: this.frames.length * 0.1, interrupted: false });
  }
  override clearBuffer(): void {
    this.onPlaybackFinished({ playbackPosition: this.frames.length * 0.1, interrupted: true });
  }
}
