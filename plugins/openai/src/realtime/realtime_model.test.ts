// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIError, Future, Task, llm, stream } from '@livekit/agents';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type * as api_proto from './api_proto.js';
import {
  RealtimeModel,
  RealtimeSession,
  isFatalError,
  livekitItemToOpenAIItem,
  processBaseURL,
} from './realtime_model.js';

type RealtimeSessionInternals = {
  generateReply: RealtimeSession['generateReply'];
  updateInstructions: RealtimeSession['updateInstructions'];
  responseCreatedFutures: Record<string, unknown>;
  sendEvent: ReturnType<typeof vi.fn>;
  textModeRecoveryRetries: number;
  instructions?: string;
  _options: {
    isAzure?: boolean;
    apiVersion?: string;
  };
};

type ResponseDoneSessionInternals = {
  handleResponseDone: (event: api_proto.ResponseDoneEvent) => void;
  handleResponseDoneButNotComplete: (event: api_proto.ResponseDoneEvent) => void;
  handleError: (event: api_proto.ErrorEvent) => void;
  on: (event: 'error', listener: (error: llm.RealtimeModelError) => void) => void;
  currentGeneration: {
    messageChannel: stream.StreamChannel<llm.MessageGeneration>;
    functionChannel: stream.StreamChannel<llm.FunctionCall>;
    messages: Map<string, never>;
    _doneFut: Future;
    _createdTimestamp: number;
    _firstTokenTimestamp?: number;
  };
};

type ErrorSessionInternals = {
  handleError: (event: api_proto.ErrorEvent) => void;
  on: (event: 'error', listener: (error: llm.RealtimeModelError) => void) => void;
};

function createSessionForTest(): RealtimeSessionInternals {
  const session = Object.create(RealtimeSession.prototype) as RealtimeSessionInternals;
  session.responseCreatedFutures = {};
  session.sendEvent = vi.fn();
  session.textModeRecoveryRetries = 0;
  session._options = {};
  return session;
}

function stubTaskRuntime(): void {
  // Prevent background realtime tasks from opening network connections in unit tests.
  vi.spyOn(Task, 'from').mockReturnValue({
    cancel: vi.fn(),
    done: true,
    result: Promise.resolve(undefined),
  } as unknown as Task<void>);
}

describe('RealtimeSession.generateReply', () => {
  it('preserves session instructions when generating with per-response instructions', async () => {
    const session = createSessionForTest();
    await session.updateInstructions('Your name is Kelly. Always respond in English.');

    const abortController = new AbortController();
    const promise = session.generateReply('Tell the user what your name is.', {
      signal: abortController.signal,
    });
    abortController.abort();

    await expect(promise).rejects.toThrow('generateReply aborted');
    expect(session.instructions).toBe('Your name is Kelly. Always respond in English.');
    expect(session.sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session.update',
        session: expect.objectContaining({
          instructions: 'Your name is Kelly. Always respond in English.',
        }),
      }),
    );
    expect(session.sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'response.create',
        response: expect.objectContaining({
          instructions:
            'Your name is Kelly. Always respond in English.\nTell the user what your name is.',
        }),
      }),
    );
  });

  it('cancels an in-flight response when aborted before response.created', async () => {
    const session = createSessionForTest();
    const abortController = new AbortController();

    const promise = session.generateReply('say pineapple', { signal: abortController.signal });
    abortController.abort();

    await expect(promise).rejects.toThrow('generateReply aborted');
    expect(Object.keys(session.responseCreatedFutures)).toHaveLength(0);
    expect(session.sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'response.create' }),
    );
    expect(session.sendEvent).toHaveBeenCalledWith({ type: 'response.cancel' });
  });
});

describe('RealtimeSession response.done status handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createResponseDoneSession(): ResponseDoneSessionInternals {
    stubTaskRuntime();

    const model = new RealtimeModel({ apiKey: 'test-key' });
    const session = model.session() as unknown as ResponseDoneSessionInternals;
    session.currentGeneration = {
      messageChannel: stream.createStreamChannel<llm.MessageGeneration>(),
      functionChannel: stream.createStreamChannel<llm.FunctionCall>(),
      messages: new Map<string, never>(),
      _doneFut: new Future(),
      _createdTimestamp: Date.now(),
    };
    return session;
  }

  it('emits a recoverable APIError when response.done reports failed', () => {
    const session = createResponseDoneSession();
    const errors: llm.RealtimeModelError[] = [];
    session.on('error', (error) => errors.push(error));

    session.handleResponseDone({
      type: 'response.done',
      event_id: 'evt_response_failed',
      response: {
        id: 'resp_failed',
        object: 'realtime.response',
        status: 'failed',
        status_details: {
          type: 'failed',
          error: {
            code: 'rate_limit_exceeded',
            message: 'rate limited',
          },
        },
        output: [],
      },
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]!.recoverable).toBe(true);
    expect(errors[0]!.error).toBeInstanceOf(APIError);
    expect(errors[0]!.error.message).toBe(
      'OpenAI Realtime API response failed with error type: unknown',
    );
    expect((errors[0]!.error as APIError).body).toEqual({
      code: 'rate_limit_exceeded',
      message: 'rate limited',
    });
  });

  it('handles string response.done status details', () => {
    const session = createResponseDoneSession();

    expect(() =>
      session.handleResponseDone({
        type: 'response.done',
        event_id: 'evt_response_incomplete',
        response: {
          id: 'resp_incomplete',
          object: 'realtime.response',
          status: 'incomplete',
          status_details: 'incomplete',
          output: [],
        },
      }),
    ).not.toThrow();
  });
});

describe('RealtimeSession fatal error handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createErrorSession(): ErrorSessionInternals {
    stubTaskRuntime();

    const model = new RealtimeModel({ apiKey: 'test-key' });
    return model.session() as unknown as ErrorSessionInternals;
  }

  function createResponseDoneSession(): ResponseDoneSessionInternals {
    stubTaskRuntime();

    const model = new RealtimeModel({ apiKey: 'test-key' });
    return model.session() as unknown as ResponseDoneSessionInternals;
  }

  it('matches known fatal error codes', () => {
    expect(isFatalError({ code: 'insufficient_quota' })).toBe(true);
    expect(isFatalError({ code: undefined, type: 'invalid_api_key' })).toBe(true);
    expect(isFatalError({ code: '', type: 'invalid_api_key' })).toBe(true);
    expect(isFatalError({ code: 'server_error' })).toBe(false);
    expect(isFatalError({})).toBe(false);
    expect(isFatalError(null)).toBe(false);
  });

  it('stops the websocket session after a fatal server error', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');

    const address = server.address();
    if (typeof address === 'string' || address === null) {
      throw new Error('expected websocket server to listen on a TCP port');
    }

    let connectionCount = 0;
    server.on('connection', (socket) => {
      connectionCount++;
      socket.on('message', (data) => {
        const event = JSON.parse(data.toString()) as { type?: string };
        if (event.type !== 'response.create') return;

        socket.send(
          JSON.stringify({
            type: 'error',
            event_id: 'evt_quota',
            error: {
              type: 'invalid_request_error',
              code: 'insufficient_quota',
              message: 'quota exceeded',
              param: '',
            },
          }),
        );
      });
    });

    const model = new RealtimeModel({
      apiKey: 'test-key',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
    });
    const session = model.session();
    const errors: llm.RealtimeModelError[] = [];
    session.on('error', (error) => errors.push(error));

    try {
      await expect(session.generateReply()).rejects.toThrow('Realtime session closed');
      expect(errors).toHaveLength(1);
      expect(errors[0]!.recoverable).toBe(false);
      expect(errors[0]!.error).toBeInstanceOf(APIError);
      expect((errors[0]!.error as APIError).retryable).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(connectionCount).toBe(1);
    } finally {
      await session.close().catch(() => undefined);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('raises non-retryable APIError on fatal server error events', () => {
    const session = createErrorSession();
    const errors: llm.RealtimeModelError[] = [];
    session.on('error', (error) => errors.push(error));

    expect(() =>
      session.handleError({
        type: 'error',
        event_id: 'evt_quota',
        error: {
          type: 'invalid_request_error',
          code: 'insufficient_quota',
          message: 'quota exceeded',
          param: '',
          event_id: 'evt_quota',
        },
      }),
    ).toThrow(APIError);
    expect(errors).toHaveLength(0);
  });

  it('emits transient server error events as recoverable', () => {
    const session = createErrorSession();
    const errors: llm.RealtimeModelError[] = [];
    session.on('error', (error) => errors.push(error));

    session.handleError({
      type: 'error',
      event_id: 'evt_server_error',
      error: {
        type: 'server_error',
        code: 'server_error',
        message: 'server hiccup',
        param: '',
        event_id: 'evt_server_error',
      },
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]!.recoverable).toBe(true);
  });

  it('ignores cancellation failed server error events', () => {
    const session = createErrorSession();
    const errors: llm.RealtimeModelError[] = [];
    session.on('error', (error) => errors.push(error));

    session.handleError({
      type: 'error',
      event_id: 'evt_cancel_failed',
      error: {
        type: 'invalid_request_error',
        message: 'Cancellation failed: no response',
        param: '',
        event_id: 'evt_cancel_failed',
      },
    });

    expect(errors).toHaveLength(0);
  });

  it('raises non-retryable APIError on fatal response.done failures', () => {
    const session = createResponseDoneSession();
    const errors: llm.RealtimeModelError[] = [];
    session.on('error', (error) => errors.push(error));

    expect(() =>
      session.handleResponseDoneButNotComplete({
        type: 'response.done',
        event_id: 'evt_response_failed',
        response: {
          id: 'resp_failed',
          object: 'realtime.response',
          status: 'failed',
          status_details: {
            type: 'failed',
            error: {
              code: 'insufficient_quota',
              message: 'quota exceeded',
            },
          },
          output: [],
        },
      }),
    ).toThrow(APIError);
    expect(errors).toHaveLength(0);
  });

  it('emits transient response.done failures as recoverable', () => {
    const session = createResponseDoneSession();
    const errors: llm.RealtimeModelError[] = [];
    session.on('error', (error) => errors.push(error));

    session.handleResponseDoneButNotComplete({
      type: 'response.done',
      event_id: 'evt_response_failed',
      response: {
        id: 'resp_failed',
        object: 'realtime.response',
        status: 'failed',
        status_details: {
          type: 'failed',
          error: {
            code: 'rate_limit_exceeded',
            message: 'rate limited',
          },
        },
        output: [],
      },
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]!.recoverable).toBe(true);
  });
});

describe('RealtimeSession input_audio_transcription delta handling', () => {
  type TranscriptionInternals = {
    handleConversationItemInputAudioTranscriptionDelta: (
      ev: api_proto.ConversationItemInputAudioTranscriptionDeltaEvent,
    ) => void;
    handleConversationItemInputAudioTranscriptionCompleted: (
      ev: api_proto.ConversationItemInputAudioTranscriptionCompletedEvent,
    ) => void;
    finalizePartialOnTranscriptionFailure: (itemId: string, contentIndex: number) => void;
    handleConversationItemDeleted: (ev: api_proto.ConversationItemDeletedEvent) => void;
    inputTranscriptAccumulators: Map<string, Map<number, string>>;
    audioCapableItemIds: Set<string>;
    itemDeleteFutures: Record<string, never>;
    remoteChatCtx: {
      get: (id: string) => { item: llm.ChatMessage } | undefined;
      delete: (id: string) => void;
    };
    on: (event: string, listener: (payload: llm.InputTranscriptionCompleted) => void) => void;
  };

  function createTranscriptSession(opts?: {
    chatItems?: Record<string, llm.ChatMessage>;
  }): TranscriptionInternals {
    const session = Object.create(RealtimeSession.prototype) as TranscriptionInternals;
    session.inputTranscriptAccumulators = new Map<string, Map<number, string>>();
    session.audioCapableItemIds = new Set<string>();
    session.itemDeleteFutures = {};
    const chatItems = new Map<string, llm.ChatMessage>(Object.entries(opts?.chatItems ?? {}));
    session.remoteChatCtx = {
      get: (id) => {
        const item = chatItems.get(id);
        return item ? { item } : undefined;
      },
      delete: (id) => {
        chatItems.delete(id);
      },
    };
    return session;
  }

  function delta(
    item_id: string,
    delta: string,
    content_index = 0,
  ): api_proto.ConversationItemInputAudioTranscriptionDeltaEvent {
    return {
      type: 'conversation.item.input_audio_transcription.delta',
      event_id: `evt_${item_id}_${delta}_${content_index}`,
      item_id,
      content_index,
      delta,
    };
  }

  function completed(
    item_id: string,
    transcript: string,
    content_index = 0,
  ): api_proto.ConversationItemInputAudioTranscriptionCompletedEvent {
    return {
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: `evt_${item_id}_done`,
      item_id,
      content_index,
      transcript,
    };
  }

  it('accumulates partial transcripts across delta events for the same item_id', () => {
    const session = createTranscriptSession();
    const emissions: llm.InputTranscriptionCompleted[] = [];
    session.on('input_audio_transcription_completed', (ev) => emissions.push(ev));

    session.handleConversationItemInputAudioTranscriptionDelta(delta('item_a', 'Hello'));
    session.handleConversationItemInputAudioTranscriptionDelta(delta('item_a', ', world'));
    session.handleConversationItemInputAudioTranscriptionDelta(delta('item_a', '!'));

    expect(emissions).toEqual([
      { itemId: 'item_a', transcript: 'Hello', isFinal: false },
      { itemId: 'item_a', transcript: 'Hello, world', isFinal: false },
      { itemId: 'item_a', transcript: 'Hello, world!', isFinal: false },
    ]);
  });

  it('keeps accumulators isolated across concurrent item_ids', () => {
    const session = createTranscriptSession();
    const emissions: llm.InputTranscriptionCompleted[] = [];
    session.on('input_audio_transcription_completed', (ev) => emissions.push(ev));

    session.handleConversationItemInputAudioTranscriptionDelta(delta('item_a', 'Aaa'));
    session.handleConversationItemInputAudioTranscriptionDelta(delta('item_b', 'Bbb'));
    session.handleConversationItemInputAudioTranscriptionDelta(delta('item_a', 'Aaa'));

    expect(emissions).toEqual([
      { itemId: 'item_a', transcript: 'Aaa', isFinal: false },
      { itemId: 'item_b', transcript: 'Bbb', isFinal: false },
      { itemId: 'item_a', transcript: 'AaaAaa', isFinal: false },
    ]);
  });

  it('keeps accumulators isolated across content_index within the same item_id', () => {
    const session = createTranscriptSession();
    const emissions: llm.InputTranscriptionCompleted[] = [];
    session.on('input_audio_transcription_completed', (ev) => emissions.push(ev));

    session.handleConversationItemInputAudioTranscriptionDelta(delta('item_a', 'idx0-', 0));
    session.handleConversationItemInputAudioTranscriptionDelta(delta('item_a', 'idx1-', 1));
    session.handleConversationItemInputAudioTranscriptionDelta(delta('item_a', 'more0', 0));

    expect(emissions).toEqual([
      { itemId: 'item_a', transcript: 'idx0-', isFinal: false },
      { itemId: 'item_a', transcript: 'idx1-', isFinal: false },
      { itemId: 'item_a', transcript: 'idx0-more0', isFinal: false },
    ]);
  });

  it('clears the accumulator on .completed so a subsequent delta does not inherit prior state', () => {
    const session = createTranscriptSession({
      chatItems: { item_a: new llm.ChatMessage({ role: 'user', content: '', id: 'item_a' }) },
    });
    const emissions: llm.InputTranscriptionCompleted[] = [];
    session.on('input_audio_transcription_completed', (ev) => emissions.push(ev));

    session.handleConversationItemInputAudioTranscriptionDelta(delta('item_a', 'first turn '));
    session.handleConversationItemInputAudioTranscriptionCompleted(
      completed('item_a', 'first turn complete.'),
    );
    session.handleConversationItemInputAudioTranscriptionDelta(delta('item_a', 'second'));

    expect(session.inputTranscriptAccumulators.get('item_a')?.get(0)).toBe('second');
    expect(emissions).toEqual([
      { itemId: 'item_a', transcript: 'first turn ', isFinal: false },
      { itemId: 'item_a', transcript: 'first turn complete.', isFinal: true },
      { itemId: 'item_a', transcript: 'second', isFinal: false },
    ]);
  });

  it('pushes the final transcript onto the matching ChatMessage exactly once on .completed', () => {
    const chatMessage = new llm.ChatMessage({ role: 'user', content: '', id: 'item_a' });
    const session = createTranscriptSession({ chatItems: { item_a: chatMessage } });

    session.handleConversationItemInputAudioTranscriptionDelta(delta('item_a', 'partial-only'));
    expect(chatMessage.content).toEqual(['']);

    session.handleConversationItemInputAudioTranscriptionCompleted(completed('item_a', 'final.'));
    expect(chatMessage.content).toEqual(['', 'final.']);
  });

  it('emits isFinal:true on .completed even when remoteChatCtx has no matching item', () => {
    const session = createTranscriptSession();
    const emissions: llm.InputTranscriptionCompleted[] = [];
    session.on('input_audio_transcription_completed', (ev) => emissions.push(ev));

    session.handleConversationItemInputAudioTranscriptionDelta(delta('item_a', 'partial'));
    session.handleConversationItemInputAudioTranscriptionCompleted(completed('item_a', 'final.'));

    expect(emissions).toEqual([
      { itemId: 'item_a', transcript: 'partial', isFinal: false },
      { itemId: 'item_a', transcript: 'final.', isFinal: true },
    ]);
    expect(session.inputTranscriptAccumulators.size).toBe(0);
  });

  it('treats .completed as a no-op cleanup when no deltas preceded it (non-streaming STT model)', () => {
    const session = createTranscriptSession({
      chatItems: { item_a: new llm.ChatMessage({ role: 'user', content: '', id: 'item_a' }) },
    });
    const emissions: llm.InputTranscriptionCompleted[] = [];
    session.on('input_audio_transcription_completed', (ev) => emissions.push(ev));

    session.handleConversationItemInputAudioTranscriptionCompleted(
      completed('item_a', 'one-shot whisper-1 transcript'),
    );

    expect(session.inputTranscriptAccumulators.size).toBe(0);
    expect(emissions).toEqual([
      { itemId: 'item_a', transcript: 'one-shot whisper-1 transcript', isFinal: true },
    ]);
  });

  it('skips emission for empty or missing deltas and does not create an accumulator', () => {
    const session = createTranscriptSession();
    const emissions: llm.InputTranscriptionCompleted[] = [];
    session.on('input_audio_transcription_completed', (ev) => emissions.push(ev));

    session.handleConversationItemInputAudioTranscriptionDelta(delta('item_a', ''));
    session.handleConversationItemInputAudioTranscriptionDelta({
      type: 'conversation.item.input_audio_transcription.delta',
      event_id: 'evt_no_delta',
      item_id: 'item_a',
    });
    session.handleConversationItemInputAudioTranscriptionDelta(delta('item_a', 'real'));

    expect(session.inputTranscriptAccumulators.get('item_a')?.get(0)).toBe('real');
    expect(emissions).toEqual([{ itemId: 'item_a', transcript: 'real', isFinal: false }]);
  });

  it('clears the accumulator and emits a closing isFinal:true on transcription failure when partials had streamed', () => {
    const session = createTranscriptSession();
    const emissions: llm.InputTranscriptionCompleted[] = [];
    session.on('input_audio_transcription_completed', (ev) => emissions.push(ev));

    session.handleConversationItemInputAudioTranscriptionDelta(delta('item_a', 'partial '));
    session.handleConversationItemInputAudioTranscriptionDelta(delta('item_a', 'text'));
    session.finalizePartialOnTranscriptionFailure('item_a', 0);

    expect(session.inputTranscriptAccumulators.size).toBe(0);
    expect(emissions).toEqual([
      { itemId: 'item_a', transcript: 'partial ', isFinal: false },
      { itemId: 'item_a', transcript: 'partial text', isFinal: false },
      { itemId: 'item_a', transcript: 'partial text', isFinal: true },
    ]);
  });

  it('emits nothing on transcription failure when no partials had streamed for that item', () => {
    const session = createTranscriptSession();
    const emissions: llm.InputTranscriptionCompleted[] = [];
    session.on('input_audio_transcription_completed', (ev) => emissions.push(ev));

    session.finalizePartialOnTranscriptionFailure('item_a', 0);

    expect(emissions).toEqual([]);
    expect(session.inputTranscriptAccumulators.size).toBe(0);
  });

  it('clears the accumulator when the conversation item is deleted', () => {
    const session = createTranscriptSession();

    session.handleConversationItemInputAudioTranscriptionDelta(delta('item_a', 'partial '));
    session.handleConversationItemInputAudioTranscriptionDelta(delta('item_a', 'more', 1));
    expect(session.inputTranscriptAccumulators.get('item_a')?.size).toBe(2);

    session.handleConversationItemDeleted({
      type: 'conversation.item.deleted',
      event_id: 'evt_del',
      item_id: 'item_a',
    });

    expect(session.inputTranscriptAccumulators.has('item_a')).toBe(false);
  });
});

describe('livekitItemToOpenAIItem', () => {
  describe('message items', () => {
    it('should use output_text type for assistant messages', async () => {
      const assistantMessage = new llm.ChatMessage({
        role: 'assistant',
        content: 'Hello, how can I help you?',
        id: 'test-assistant-msg',
      });

      const result = (await livekitItemToOpenAIItem(assistantMessage)) as api_proto.AssistantItem;

      expect(result.type).toBe('message');
      expect(result.role).toBe('assistant');
      expect(result.content).toHaveLength(1);
      const content = result.content[0]!;
      expect(content.type).toBe('output_text');
      expect((content as api_proto.OutputTextContent).text).toBe('Hello, how can I help you?');
    });

    it('should use input_text type for user messages', async () => {
      const userMessage = new llm.ChatMessage({
        role: 'user',
        content: 'What is the weather like?',
        id: 'test-user-msg',
      });

      const result = (await livekitItemToOpenAIItem(userMessage)) as api_proto.UserItem;

      expect(result.type).toBe('message');
      expect(result.role).toBe('user');
      expect(result.content).toHaveLength(1);
      const content = result.content[0]!;
      expect(content.type).toBe('input_text');
      expect((content as api_proto.InputTextContent).text).toBe('What is the weather like?');
    });

    it('should use input_text type for system messages', async () => {
      const systemMessage = new llm.ChatMessage({
        role: 'system',
        content: 'You are a helpful assistant.',
        id: 'test-system-msg',
      });

      const result = (await livekitItemToOpenAIItem(systemMessage)) as api_proto.UserItem;

      expect(result.type).toBe('message');
      expect(result.role).toBe('system');
      expect(result.content).toHaveLength(1);
      const content = result.content[0]!;
      expect(content.type).toBe('input_text');
    });

    it('should convert developer role to system role', async () => {
      const developerMessage = new llm.ChatMessage({
        role: 'developer',
        content: 'System instructions.',
        id: 'test-developer-msg',
      });

      const result = (await livekitItemToOpenAIItem(developerMessage)) as api_proto.UserItem;

      expect(result.type).toBe('message');
      expect(result.role).toBe('system');
      const content = result.content[0]!;
      expect(content.type).toBe('input_text');
    });

    it('should handle multiple content items for assistant', async () => {
      const multiContentMessage = new llm.ChatMessage({
        role: 'assistant',
        content: ['First part.', 'Second part.'],
        id: 'test-multi-msg',
      });

      const result = (await livekitItemToOpenAIItem(
        multiContentMessage,
      )) as api_proto.AssistantItem;

      expect(result.content).toHaveLength(2);
      const content0 = result.content[0]!;
      const content1 = result.content[1]!;
      expect(content0.type).toBe('output_text');
      expect(content1.type).toBe('output_text');
    });

    it('should convert image content to input_image for user messages', async () => {
      const base64Data =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      const imageContent = llm.createImageContent({
        image: `data:image/png;base64,${base64Data}`,
        mimeType: 'image/png',
      });

      const userMessage = new llm.ChatMessage({
        role: 'user',
        content: [imageContent],
        id: 'test-image-msg',
      });

      const result = (await livekitItemToOpenAIItem(userMessage)) as api_proto.UserItem;

      expect(result.type).toBe('message');
      expect(result.role).toBe('user');
      expect(result.content).toHaveLength(1);
      const content = result.content[0]!;
      expect(content.type).toBe('input_image');
      expect((content as api_proto.InputImageContent).image_url).toBe(
        `data:image/png;base64,${base64Data}`,
      );
    });

    it('should ignore image content for assistant messages', async () => {
      const base64Data =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      const imageContent = llm.createImageContent({
        image: `data:image/png;base64,${base64Data}`,
        mimeType: 'image/png',
      });

      const assistantMessage = new llm.ChatMessage({
        role: 'assistant',
        content: [imageContent],
        id: 'test-assistant-image-msg',
      });

      const result = (await livekitItemToOpenAIItem(assistantMessage)) as api_proto.AssistantItem;

      expect(result.type).toBe('message');
      expect(result.role).toBe('assistant');
      expect(result.content).toHaveLength(0);
    });

    it('should ignore image content for system messages', async () => {
      const base64Data =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      const imageContent = llm.createImageContent({
        image: `data:image/png;base64,${base64Data}`,
        mimeType: 'image/png',
      });

      const systemMessage = new llm.ChatMessage({
        role: 'system',
        content: [imageContent],
        id: 'test-system-image-msg',
      });

      const result = (await livekitItemToOpenAIItem(systemMessage)) as api_proto.SystemItem;

      expect(result.type).toBe('message');
      expect(result.role).toBe('system');
      expect(result.content).toHaveLength(0);
    });

    it('should ignore image content for developer messages mapped to system', async () => {
      const base64Data =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      const imageContent = llm.createImageContent({
        image: `data:image/png;base64,${base64Data}`,
        mimeType: 'image/png',
      });

      const developerMessage = new llm.ChatMessage({
        role: 'developer',
        content: [imageContent],
        id: 'test-developer-image-msg',
      });

      const result = (await livekitItemToOpenAIItem(developerMessage)) as api_proto.SystemItem;

      expect(result.type).toBe('message');
      expect(result.role).toBe('system');
      expect(result.content).toHaveLength(0);
    });

    it('should handle mixed text and image content', async () => {
      const base64Data =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      const imageContent = llm.createImageContent({
        image: `data:image/png;base64,${base64Data}`,
        mimeType: 'image/png',
      });

      const userMessage = new llm.ChatMessage({
        role: 'user',
        content: ['Describe this image:', imageContent],
        id: 'test-mixed-msg',
      });

      const result = (await livekitItemToOpenAIItem(userMessage)) as api_proto.UserItem;

      expect(result.type).toBe('message');
      expect(result.content).toHaveLength(2);
      expect(result.content[0]!.type).toBe('input_text');
      expect(result.content[1]!.type).toBe('input_image');
    });
  });

  describe('function_call items', () => {
    it('should convert function call items correctly', async () => {
      const functionCall = new llm.FunctionCall({
        callId: 'call-123',
        name: 'get_weather',
        args: '{"location": "San Francisco"}',
        id: 'test-func-call',
      });

      const result = (await livekitItemToOpenAIItem(functionCall)) as api_proto.FunctionCallItem;

      expect(result.type).toBe('function_call');
      expect(result.id).toBe('test-func-call');
      expect(result.call_id).toBe('call-123');
      expect(result.name).toBe('get_weather');
      expect(result.arguments).toBe('{"location": "San Francisco"}');
    });
  });

  describe('function_call_output items', () => {
    it('should convert function call output items correctly', async () => {
      const functionOutput = new llm.FunctionCallOutput({
        callId: 'call-123',
        output: 'The weather in San Francisco is sunny.',
        isError: false,
        id: 'test-func-output',
      });

      const result = (await livekitItemToOpenAIItem(
        functionOutput,
      )) as api_proto.FunctionCallOutputItem;

      expect(result.type).toBe('function_call_output');
      expect(result.id).toBe('test-func-output');
      expect(result.call_id).toBe('call-123');
      expect(result.output).toBe('The weather in San Francisco is sunny.');
    });
  });
});

describe('RealtimeSession chat context update events', () => {
  type ChatCtxUpdateInternals = {
    remoteChatCtx: llm.RemoteChatContext;
    chatCtx: llm.ChatContext;
    createChatCtxUpdateEvents: (
      chatCtx: llm.ChatContext,
    ) => Promise<(api_proto.ConversationItemCreateEvent | api_proto.ConversationItemDeleteEvent)[]>;
  };

  function createChatCtxUpdateSession(remoteItem: llm.ChatMessage): ChatCtxUpdateInternals {
    const session = Object.create(RealtimeSession.prototype) as ChatCtxUpdateInternals;
    session.remoteChatCtx = new llm.RemoteChatContext();
    session.remoteChatCtx.insert(undefined, remoteItem);
    Object.defineProperty(session, 'chatCtx', {
      get() {
        return session.remoteChatCtx.toChatCtx();
      },
    });
    return session;
  }

  it('does not replace updated remote items with empty content', async () => {
    const session = createChatCtxUpdateSession(
      llm.ChatMessage.create({ id: 'item_1', role: 'assistant', content: [] }),
    );

    const events = await session.createChatCtxUpdateEvents(
      new llm.ChatContext([
        llm.ChatMessage.create({ id: 'item_1', role: 'assistant', content: ['hello'] }),
      ]),
    );

    expect(events).toEqual([]);
  });

  it('replaces updated remote text items', async () => {
    const session = createChatCtxUpdateSession(
      llm.ChatMessage.create({ id: 'item_1', role: 'assistant', content: ['old'] }),
    );

    const events = await session.createChatCtxUpdateEvents(
      new llm.ChatContext([
        llm.ChatMessage.create({ id: 'item_1', role: 'assistant', content: ['new'] }),
      ]),
    );

    expect(events.map((event) => event.type)).toEqual([
      'conversation.item.delete',
      'conversation.item.create',
    ]);
    expect((events[0] as api_proto.ConversationItemDeleteEvent).item_id).toBe('item_1');
    expect((events[1] as api_proto.ConversationItemCreateEvent).item.id).toBe('item_1');
  });
});

describe('RealtimeSession.updateOptions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits session.update when toolChoice changes', () => {
    stubTaskRuntime();

    const model = new RealtimeModel({ apiKey: 'test-key' });
    const session = model.session() as unknown as {
      updateOptions: (opts: { toolChoice?: llm.ToolChoice }) => void;
      sendEvent: (event: api_proto.ClientEvent) => void;
    };
    const sendEventSpy = vi.spyOn(session, 'sendEvent');
    sendEventSpy.mockClear();

    session.updateOptions({ toolChoice: 'required' });

    expect(sendEventSpy).toHaveBeenCalledTimes(1);
    expect(sendEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session.update',
        session: expect.objectContaining({
          type: 'realtime',
          tool_choice: 'required',
        }),
      }),
    );
  });

  it('does not emit session.update when toolChoice is unchanged', () => {
    stubTaskRuntime();

    const model = new RealtimeModel({ apiKey: 'test-key' });
    const session = model.session() as unknown as {
      updateOptions: (opts: { toolChoice?: llm.ToolChoice }) => void;
      sendEvent: (event: api_proto.ClientEvent) => void;
    };
    const sendEventSpy = vi.spyOn(session, 'sendEvent');
    sendEventSpy.mockClear();

    session.updateOptions({ toolChoice: 'auto' });

    expect(sendEventSpy).not.toHaveBeenCalled();
  });

  it('keeps toolChoice state isolated across sessions from same model', () => {
    stubTaskRuntime();

    const model = new RealtimeModel({ apiKey: 'test-key' });
    const sessionA = model.session() as unknown as {
      updateOptions: (opts: { toolChoice?: llm.ToolChoice }) => void;
      sendEvent: (event: api_proto.ClientEvent) => void;
      _options: { toolChoice?: llm.ToolChoice };
    };
    const sessionB = model.session() as unknown as {
      updateOptions: (opts: { toolChoice?: llm.ToolChoice }) => void;
      sendEvent: (event: api_proto.ClientEvent) => void;
      _options: { toolChoice?: llm.ToolChoice };
    };

    const sendEventSpyA = vi.spyOn(sessionA, 'sendEvent');
    const sendEventSpyB = vi.spyOn(sessionB, 'sendEvent');
    sendEventSpyA.mockClear();
    sendEventSpyB.mockClear();

    sessionA.updateOptions({ toolChoice: 'required' });

    expect(sessionA._options.toolChoice).toBe('required');
    expect(sessionB._options.toolChoice).toBe('auto');
    expect(sendEventSpyA).toHaveBeenCalledTimes(1);
    expect(sendEventSpyB).toHaveBeenCalledTimes(0);

    sessionB.updateOptions({ toolChoice: 'required' });
    expect(sendEventSpyB).toHaveBeenCalledTimes(1);
  });
});

describe('processBaseURL', () => {
  it('upgrades https baseURL to wss and appends /realtime with model', () => {
    const url = new URL(
      processBaseURL({
        baseURL: 'https://gateway.example.com/v1',
        model: 'gpt-4o-realtime-preview',
        isAzure: false,
      }),
    );

    expect(url.protocol).toBe('wss:');
    expect(url.host).toBe('gateway.example.com');
    expect(url.pathname).toBe('/v1/realtime');
    expect(url.searchParams.get('model')).toBe('gpt-4o-realtime-preview');
  });

  it('downgrades http baseURL to ws (not wss)', () => {
    const url = new URL(
      processBaseURL({
        baseURL: 'http://gateway.example.com/v1',
        model: 'gpt-4o-realtime-preview',
        isAzure: false,
      }),
    );

    expect(url.protocol).toBe('ws:');
    expect(url.host).toBe('gateway.example.com');
    expect(url.pathname).toBe('/v1/realtime');
    expect(url.searchParams.get('model')).toBe('gpt-4o-realtime-preview');
  });

  it('passes through an already-wss baseURL unchanged', () => {
    const url = new URL(
      processBaseURL({
        baseURL: 'wss://gateway.example.com/v1',
        model: 'gpt-4o-realtime-preview',
        isAzure: false,
      }),
    );

    expect(url.protocol).toBe('wss:');
    expect(url.pathname).toBe('/v1/realtime');
  });

  it('passes through an already-ws baseURL unchanged', () => {
    const url = new URL(
      processBaseURL({
        baseURL: 'ws://gateway.example.com/v1',
        model: 'gpt-4o-realtime-preview',
        isAzure: false,
      }),
    );

    expect(url.protocol).toBe('ws:');
    expect(url.pathname).toBe('/v1/realtime');
  });
});
