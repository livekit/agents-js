// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Future, Task, type TimedString, llm, stream } from '@livekit/agents';
import { realtime } from '@livekit/agents-plugin-openai';
import type { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeModel } from './realtime_model.js';

type SessionInternals = {
  createSessionUpdateEvent: () => realtime.SessionUpdateEvent;
  createChatCtxUpdateEvents: (
    chatCtx: llm.ChatContext,
  ) => Promise<(realtime.ConversationItemCreateEvent | realtime.ConversationItemDeleteEvent)[]>;
  currentGeneration?: realtime.ResponseGeneration | realtime.DiscardedGeneration;
  handleConversationItemCreated: (event: realtime.ConversationItemCreatedEvent) => void;
  handleConversationItemInputAudioTranscriptionCompleted: (
    event: realtime.ConversationItemInputAudioTranscriptionCompletedEvent,
  ) => void;
  handleInputAudioBufferSpeechStarted: (event: realtime.InputAudioBufferSpeechStartedEvent) => void;
  handleResponseAudioDelta: (event: realtime.ResponseAudioDeltaEvent) => void;
  handleResponseCreated: (event: realtime.ResponseCreatedEvent) => void;
  handleResponseTextDelta: (event: realtime.ResponseTextDeltaEvent) => void;
  interrupt: () => Promise<void>;
  pendingTranscription?: realtime.ConversationItemInputAudioTranscriptionCompletedEvent;
  pendingSayEventIds: string[];
  discardedEventIds: Set<string>;
  responseCreatedFutures: Record<string, unknown>;
  remoteChatCtx: llm.RemoteChatContext;
  resetInputTurnState: () => void;
  responseSpoke: boolean;
  sendEvent: (event: realtime.ClientEvent) => void;
};

type EmittedTranscript = llm.InputTranscriptionCompleted;

describe('xAI realtime turn state', () => {
  beforeEach(() => {
    vi.spyOn(Task, 'from').mockReturnValue({
      cancel: vi.fn(),
      done: true,
      result: Promise.resolve(undefined),
    } as unknown as Task<void>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeSession(): { session: SessionInternals; emitted: EmittedTranscript[] } {
    const realtimeSession = new RealtimeModel({ apiKey: 'test-key' }).session();
    const session = realtimeSession as unknown as SessionInternals;
    session.currentGeneration = new realtime.DiscardedGeneration();
    const emitted: EmittedTranscript[] = [];
    realtimeSession.on('input_audio_transcription_completed', (event) => emitted.push(event));
    return { session, emitted };
  }

  function finals(emitted: EmittedTranscript[]): [string, string][] {
    return emitted
      .filter((event) => event.isFinal)
      .map((event) => [event.itemId, event.transcript]);
  }

  function transcript(
    session: SessionInternals,
    itemId: string,
    text: string,
    status?: string,
  ): void {
    session.handleConversationItemInputAudioTranscriptionCompleted({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'evt',
      item_id: itemId,
      content_index: 0,
      transcript: text,
      ...(status === undefined ? {} : { status }),
    });
  }

  function commit(session: SessionInternals, itemId: string, text: string): void {
    transcript(session, itemId, text, 'completed');
  }

  function speechStarted(session: SessionInternals, itemId: string): void {
    session.handleInputAudioBufferSpeechStarted({
      type: 'input_audio_buffer.speech_started',
      event_id: 'evt',
      item_id: itemId,
      audio_start_ms: 0,
    });
  }

  function agentSpeaks(session: SessionInternals): void {
    session.handleResponseAudioDelta({
      type: 'response.audio.delta',
      event_id: 'evt',
      item_id: 'reply',
      response_id: 'resp',
      output_index: 0,
      content_index: 0,
      delta: '',
    });
  }

  function mirror(
    session: SessionInternals,
    ...items: [string, 'user' | 'assistant' | 'system', string][]
  ): void {
    let previous: string | undefined;
    for (const [itemId, role, text] of items) {
      session.remoteChatCtx.insert(
        previous,
        new llm.ChatMessage({ id: itemId, role, content: [text] }),
      );
      previous = itemId;
    }
  }

  function remoteMessage(session: SessionInternals, itemId: string): llm.ChatMessage {
    const item = session.remoteChatCtx.get(itemId)?.item;
    if (!(item instanceof llm.ChatMessage)) {
      throw new Error(`Remote item ${itemId} is not a chat message`);
    }
    return item;
  }

  function itemAdded(session: SessionInternals, itemId: string, after?: string): void {
    session.handleConversationItemCreated({
      type: 'conversation.item.added',
      event_id: 'evt',
      previous_item_id: after ?? '',
      item: {
        id: itemId,
        object: 'realtime.item',
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    } as unknown as realtime.ConversationItemCreatedEvent);
  }

  function responseCreated(session: SessionInternals): void {
    session.handleResponseCreated({
      type: 'response.created',
      event_id: 'evt',
      response: {
        id: 'resp',
        object: 'realtime.response',
        status: 'in_progress',
        status_details: 'in_progress',
        output: [],
      },
    });
  }

  it('uses current voice and transcription defaults', () => {
    const model = new RealtimeModel({ apiKey: 'test-key' });
    const options = model._options;

    expect(model.model).toBe('grok-voice-latest');
    expect(model.capabilities.supportsSay).toBe(true);
    expect(options.inputAudioTranscription).toEqual({ model: 'grok-transcribe' });
  });

  it('lifts voice and turn detection in session updates', () => {
    const model = new RealtimeModel({
      apiKey: 'test-key',
      reasoning: { effort: 'high' },
      speed: 1.2,
    });
    const session = model.session() as unknown as SessionInternals;

    const event = session.createSessionUpdateEvent();

    expect(event.session.voice).toBe('ara');
    expect(event.session.turn_detection).toEqual({
      type: 'server_vad',
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 200,
      create_response: true,
      interrupt_response: true,
    });
    expect(event.session.reasoning).toEqual({ effort: 'high' });
    expect(event.session.audio?.output?.voice).toBeUndefined();
    expect(event.session.audio?.input?.turn_detection).toBeUndefined();
    expect(event.session.audio?.output?.speed).toBe(1.2);
  });

  it('emits transcription.updated as a non-final caption', () => {
    const model = new RealtimeModel({ apiKey: 'test-key' });
    const realtimeSession = model.session();
    const emitted: EmittedTranscript[] = [];
    realtimeSession.on('input_audio_transcription_completed', (event) => emitted.push(event));

    realtimeSession.emit('openai_server_event_received', {
      type: 'conversation.item.input_audio_transcription.updated',
      item_id: 'item_1',
      transcript: 'hello there',
    });

    expect(emitted).toEqual([{ itemId: 'item_1', transcript: 'hello there', isFinal: false }]);
  });

  it('sends force_message and resolves say from response.created', async () => {
    const model = new RealtimeModel({ apiKey: 'test-key' });
    const realtimeSession = model.session();
    const session = realtimeSession as unknown as SessionInternals;
    const sent: realtime.ClientEvent[] = [];
    session.sendEvent = (event) => sent.push(event);

    const generationPromise = realtimeSession.say('Hello from force message.');
    await Promise.resolve();
    responseCreated(session);
    const generation = await generationPromise;

    expect(generation.userInitiated).toBe(true);
    expect(sent[0]).toMatchObject({
      type: 'conversation.item.create',
      item: {
        type: 'force_message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello from force message.' }],
      },
    });
  });

  it('keeps an aborted say tag so a late response is discarded', async () => {
    const model = new RealtimeModel({ apiKey: 'test-key' });
    const realtimeSession = model.session();
    const session = realtimeSession as unknown as SessionInternals;
    const sent: realtime.ClientEvent[] = [];
    session.sendEvent = (event) => sent.push(event);
    const controller = new AbortController();

    const generationPromise = realtimeSession.say('hello', { signal: controller.signal });
    await Promise.resolve();
    const sayId = session.pendingSayEventIds[0];
    controller.abort();
    await expect(generationPromise).rejects.toThrow('say aborted');

    expect(session.pendingSayEventIds).toEqual([sayId]);
    expect(session.discardedEventIds).toContain(sayId);
    expect(sent).toContainEqual({ type: 'response.cancel' });

    responseCreated(session);
    expect(session.currentGeneration).toBeInstanceOf(realtime.DiscardedGeneration);
    expect(session.pendingSayEventIds).toEqual([]);
    expect(session.discardedEventIds).not.toContain(sayId);
  });

  it('does not cancel another response when say is aborted before send', async () => {
    const model = new RealtimeModel({ apiKey: 'test-key' });
    const realtimeSession = model.session();
    const session = realtimeSession as unknown as SessionInternals;
    const sent: realtime.ClientEvent[] = [];
    session.sendEvent = (event) => sent.push(event);
    const controller = new AbortController();
    const text = new ReadableStream<string>({
      async pull(streamController) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        streamController.enqueue('too late');
        streamController.close();
      },
    });

    const generationPromise = realtimeSession.say(text, { signal: controller.signal });
    controller.abort();
    await expect(generationPromise).rejects.toThrow('say aborted');

    expect(session.pendingSayEventIds).toEqual([]);
    expect(session.discardedEventIds.size).toBe(0);
    expect(sent).toEqual([]);
  });

  it('settles a pending say when the session closes', async () => {
    const model = new RealtimeModel({ apiKey: 'test-key' });
    const realtimeSession = model.session();
    const session = realtimeSession as unknown as SessionInternals;
    session.sendEvent = () => {};

    const generationPromise = realtimeSession.say('still speaking');
    await Promise.resolve();
    await realtimeSession.close();

    await expect(generationPromise).rejects.toThrow('say aborted');
    expect(session.responseCreatedFutures).toEqual({});
  });

  it('matches overlapping say responses FIFO', async () => {
    const model = new RealtimeModel({ apiKey: 'test-key' });
    const realtimeSession = model.session();
    const session = realtimeSession as unknown as SessionInternals;
    session.sendEvent = () => {};

    const first = realtimeSession.say('first');
    const second = realtimeSession.say('second');
    await Promise.resolve();
    const pending = [...session.pendingSayEventIds];
    responseCreated(session);
    responseCreated(session);

    await expect(first).resolves.toMatchObject({ userInitiated: true });
    await expect(second).resolves.toMatchObject({ userInitiated: true });
    expect(pending).toHaveLength(2);
    expect(session.pendingSayEventIds).toEqual([]);
  });

  function replyItemAnnounced(session: SessionInternals, itemId: string, after: string): void {
    session.remoteChatCtx.insert(
      after,
      new llm.ChatMessage({ id: itemId, role: 'assistant', content: [] }),
    );
    const generation = session.currentGeneration as realtime.ResponseGeneration;
    generation.messages.set(itemId, {
      messageId: itemId,
      textChannel: stream.createStreamChannel<string | TimedString>(),
      audioChannel: stream.createStreamChannel<AudioFrame>(),
      audioTranscript: '',
      modalities: new Future<('text' | 'audio')[]>(),
    });
  }

  it('never marks in-progress transcripts final', () => {
    const { session, emitted } = makeSession();

    for (const partial of ['what is', 'what is my', 'what is my name']) {
      transcript(session, 'item_1', partial, 'in_progress');
    }

    expect(finals(emitted)).toEqual([]);
    expect(emitted.map((event) => event.transcript)).toEqual([
      'what is',
      'what is my',
      'what is my name',
    ]);
  });

  it('marks a committed transcript final once the agent answers', () => {
    const { session, emitted } = makeSession();

    commit(session, 'item_1', 'what is my name');
    expect(finals(emitted)).toEqual([]);
    agentSpeaks(session);

    expect(finals(emitted)).toEqual([['item_1', 'what is my name']]);
  });

  it('treats a missing status as committed', () => {
    const { session, emitted } = makeSession();

    transcript(session, 'item_1', 'what is my name');
    agentSpeaks(session);

    expect(finals(emitted)).toEqual([['item_1', 'what is my name']]);
  });

  it('ends the turn on a text-only response', () => {
    const { session, emitted } = makeSession();

    commit(session, 'item_1', 'what is my name');
    session.handleResponseTextDelta({
      type: 'response.text.delta',
      event_id: 'evt',
      item_id: 'reply',
      response_id: 'resp',
      output_index: 0,
      content_index: 0,
      delta: 'your',
    });

    expect(finals(emitted)).toEqual([['item_1', 'what is my name']]);
  });

  it('yields one final transcript across a pause within a turn', () => {
    const { session, emitted } = makeSession();

    commit(session, 'item_1', 'Hello, how are you? Last ones.');
    commit(session, 'item_1', 'Hello, how are you? Last once. I paid twice.');
    agentSpeaks(session);

    expect(finals(emitted)).toEqual([['item_1', 'Hello, how are you? Last once. I paid twice.']]);
  });

  it('does not end the turn for an abandoned response', () => {
    const { session, emitted } = makeSession();

    commit(session, 'item_1', 'hello');
    commit(session, 'item_1', 'hello and one more thing');
    expect(finals(emitted)).toEqual([]);
    agentSpeaks(session);

    expect(finals(emitted)).toEqual([['item_1', 'hello and one more thing']]);
  });

  it('finalizes an unanswered turn when the next turn starts', () => {
    const { session, emitted } = makeSession();

    commit(session, 'item_1', 'are you there');
    speechStarted(session, 'item_1');
    expect(finals(emitted)).toEqual([]);
    speechStarted(session, 'item_2');

    expect(finals(emitted)).toEqual([['item_1', 'are you there']]);
  });

  it('finalizes the previous turn when a new item transcript arrives', () => {
    const { session, emitted } = makeSession();

    commit(session, 'item_1', 'hello');
    commit(session, 'item_2', 'are you there');

    expect(finals(emitted)).toEqual([['item_1', 'hello']]);
  });

  it('delivers the held transcript when input state resets for reconnect', () => {
    const { session, emitted } = makeSession();
    mirror(session, ['item_1', 'user', '']);

    commit(session, 'item_1', 'are you still there');
    session.resetInputTurnState();

    expect(finals(emitted)).toEqual([['item_1', 'are you still there']]);
    expect(session.pendingTranscription).toBeUndefined();
    expect(remoteMessage(session, 'item_1').content).toEqual(['are you still there']);
  });

  it('keeps a resumed turn pending across repeated speech starts', () => {
    const { session, emitted } = makeSession();
    commit(session, 'item_1', 'still speaking');

    speechStarted(session, 'item_1');
    speechStarted(session, 'item_1');

    expect(finals(emitted)).toEqual([]);
    expect(session.pendingTranscription?.item_id).toBe('item_1');
  });

  it('stores the final transcript on the remote item once', () => {
    const { session } = makeSession();
    mirror(session, ['item_1', 'user', '']);

    commit(session, 'item_1', 'Hello, how are you? Last ones.');
    commit(session, 'item_1', 'Hello, how are you? Last once. I paid twice.');
    agentSpeaks(session);

    expect(remoteMessage(session, 'item_1').content).toEqual([
      'Hello, how are you? Last once. I paid twice.',
    ]);
  });

  it('does not delete a held turn from the server', async () => {
    const { session } = makeSession();
    mirror(session, ['item_1', 'user', ''], ['stale', 'assistant', 'dropped']);
    commit(session, 'item_1', 'are you there');

    const events = await session.createChatCtxUpdateEvents(llm.ChatContext.empty());
    const deleted = events
      .filter(
        (event): event is realtime.ConversationItemDeleteEvent =>
          event.type === 'conversation.item.delete',
      )
      .map((event) => event.item_id);

    expect(deleted).not.toContain('item_1');
    expect(deleted).toContain('stale');
  });

  it('keeps a reply anchored behind the held turn', async () => {
    const { session } = makeSession();
    mirror(
      session,
      ['earlier', 'assistant', 'hi'],
      ['item_1', 'user', ''],
      ['reply', 'assistant', 'the full reply'],
    );
    commit(session, 'item_1', 'are you there');
    const agentCtx = new llm.ChatContext([
      new llm.ChatMessage({ id: 'earlier', role: 'assistant', content: ['hi'] }),
      new llm.ChatMessage({ id: 'reply', role: 'assistant', content: ['the trunc'] }),
    ]);

    const events = await session.createChatCtxUpdateEvents(agentCtx);
    const created = Object.fromEntries(
      events
        .filter(
          (event): event is realtime.ConversationItemCreateEvent =>
            event.type === 'conversation.item.create',
        )
        .map((event) => [event.item.id, event.previous_item_id]),
    );

    expect(created).toEqual({ reply: 'item_1' });
  });

  it('appends an item anchored to an unannounced item', () => {
    const { session } = makeSession();
    mirror(session, ['item_1', 'user', 'hello']);

    itemAdded(session, 'item_2', 'never_announced');
    itemAdded(session, 'reply', 'item_2');

    expect(session.remoteChatCtx.toChatCtx().items.map((item) => item.id)).toEqual([
      'item_1',
      'item_2',
      'reply',
    ]);
  });

  it('discards an interrupted response that never spoke', async () => {
    const { session } = makeSession();
    mirror(session, ['item_1', 'user', 'hello']);
    responseCreated(session);
    replyItemAnnounced(session, 'phantom', 'item_1');
    const generation = session.currentGeneration as realtime.ResponseGeneration;

    await session.interrupt();

    expect(generation._doneFut.done).toBe(true);
    expect(session.remoteChatCtx.get('phantom')).not.toBeNull();
  });

  it('leaves a speaking response alone when interrupted', async () => {
    const { session } = makeSession();
    mirror(session, ['item_1', 'user', 'hello']);
    responseCreated(session);
    replyItemAnnounced(session, 'real', 'item_1');
    session.responseSpoke = true;
    const generation = session.currentGeneration as realtime.ResponseGeneration;

    await session.interrupt();

    expect(generation._doneFut.done).toBe(false);
  });

  it('keeps a silent response alive when the user speaks over it', () => {
    const { session } = makeSession();
    mirror(session, ['item_1', 'user', 'hello']);
    responseCreated(session);
    replyItemAnnounced(session, 'thinking', 'item_1');
    const generation = session.currentGeneration as realtime.ResponseGeneration;

    speechStarted(session, 'item_1');

    expect(generation._doneFut.done).toBe(false);
  });
});
