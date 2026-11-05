// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger, llm, voice } from '@livekit/agents';
import { afterEach, expect, it, vi } from 'vitest';
import { RealtimeModel } from './realtime_model.js';
import { PrismPeer, TestAudioOutput } from './test_helpers.js';

initializeLogger({ pretty: false, level: 'silent' });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(strict = false) {
  const peer = await new PrismPeer().start();
  cleanup.push(() => peer.close());
  const model = new RealtimeModel({
    apiKey: 'test',
    endpoint: peer.endpoint,
    contextMode: strict ? 'strict' : 'shared',
    requestTimeout: 500,
  });
  cleanup.push(() => model.close());
  const session = model.session();
  const errors: llm.RealtimeModelError[] = [];
  session.on('error', (error) => errors.push(error));
  await session.updateInstructions('Test');
  return { peer, model, session, errors };
}
function pair(id: string, createdAt = Date.now()): [llm.FunctionCall, llm.FunctionCallOutput] {
  return [
    new llm.FunctionCall({
      id,
      callId: id,
      name: 'lookup',
      args: '{}',
      createdAt,
      extra: { __livekit_agents_tool_non_blocking: true },
    }),
    new llm.FunctionCallOutput({
      id: `result-${id}`,
      callId: id,
      name: 'lookup',
      output: id,
      isError: false,
      createdAt,
    }),
  ];
}
async function generated(
  peer: PrismPeer,
  session: ReturnType<RealtimeModel['session']>,
  id: string,
) {
  peer.accepted(undefined, id);
  peer.message(id);
  peer.text('Working', id, true);
  peer.ended(id);
  peer.history.push({ id: `message-${id}`, type: 'message', role: 'assistant', text: 'Working' });
  await vi.waitFor(() =>
    expect(session.chatCtx.items.some((i) => i.id === `message-${id}`)).toBe(true),
  );
}
async function liveCall(peer: PrismPeer, session: ReturnType<RealtimeModel['session']>) {
  peer.accepted(undefined, 'tool-reply');
  peer.tool('tool-reply', 'progress');
  peer.ended('tool-reply');
  await vi.waitFor(() =>
    expect(session.chatCtx.items.some((item) => item.type === 'function_call')).toBe(true),
  );
  const call = session.chatCtx.items.find(
    (item) => item.type === 'function_call',
  )! as llm.FunctionCall;
  call.extra.__livekit_agents_tool_non_blocking = true;
  return [call, pair('progress')[1]] as const;
}
// A filler ends while the first progress write awaits acknowledgment. The repair
// read restores Prism's message-before-call order, unlike core's playout order.
async function repairedFillerProgress(strict = false) {
  const context = await setup(strict);
  const { peer, session } = context;
  peer.accepted(undefined, 'tool-reply');
  peer.message('tool-reply');
  peer.text('Working', 'tool-reply', true);
  peer.history.push({
    id: 'message-tool-reply',
    type: 'message',
    role: 'assistant',
    text: 'Working',
  });
  peer.tool('tool-reply', 'progress');
  await vi.waitFor(() => expect(session.chatCtx.items).toHaveLength(1));
  const call = session.chatCtx.items[0]! as llm.FunctionCall;
  call.extra.__livekit_agents_tool_non_blocking = true;
  const output = pair('progress')[1];
  let acknowledge: (() => void) | undefined;
  peer.onRequest = (request) => {
    if (request.type !== 'conversation.item.create') return;
    acknowledge = () => {
      const item = { ...request.item!, id: 'saved-progress' };
      peer.history.push(item);
      peer.emit('conversation.item.created', {
        prism_request_event_id: request.event_id,
        item,
      });
    };
    return true;
  };
  const pending = session.updateChatCtx(new llm.ChatContext([call, output]));
  await vi.waitFor(() => expect(acknowledge).toBeDefined());
  peer.ended('tool-reply');
  await vi.waitFor(() => expect(session.chatCtx.items).toHaveLength(2));
  acknowledge!();
  await pending;
  peer.onRequest = undefined;
  expect(session.chatCtx.items.map((item) => item.id)).toEqual([
    'message-tool-reply',
    call.id,
    output.id,
  ]);
  const message = session.chatCtx.items[0]! as llm.ChatMessage;
  return { ...context, call, output, message };
}
it('accepts a shared handoff with the same response filler after its tool call', async () => {
  const { peer, session, call, output, message, errors } = await repairedFillerProgress();
  const before = session.chatCtx.toJSON();
  const requests = peer.requests.length;
  await session.updateChatCtx(new llm.ChatContext([call, output, message]));
  await session.updateChatCtx(new llm.ChatContext([call, output, message]));
  expect(session.chatCtx.toJSON()).toEqual(before);
  expect(peer.requests).toHaveLength(requests);
  expect(errors).toEqual([]);
});
it.each(['message', 'call', 'output'])(
  'rejects changed %s in a reordered handoff',
  async (kind) => {
    const { peer, session, call, output, message } = await repairedFillerProgress();
    if (kind === 'message') message.content = ['Changed'];
    if (kind === 'call') call.args = '{"changed":true}';
    if (kind === 'output') output.output = 'Changed';
    const requests = peer.requests.length;
    await expect(
      session.updateChatCtx(new llm.ChatContext([call, output, message])),
    ).rejects.toThrow();
    expect(peer.requests).toHaveLength(requests);
  },
);
it('does not normalize a call across a message from another response', async () => {
  const { peer, session } = await setup();
  const [call, output] = await liveCall(peer, session);
  await generated(peer, session, 'unrelated');
  const ctx = session.chatCtx;
  ctx.items.push(output);
  await session.updateChatCtx(ctx);
  const message = session.chatCtx.items.find((item) => item.type === 'message')!;
  const requests = peer.requests.length;
  await expect(session.updateChatCtx(new llm.ChatContext([message, call, output]))).rejects.toThrow(
    'append order',
  );
  expect(peer.requests).toHaveLength(requests);
});
it('does not reorder tool calls within the same response', async () => {
  const { peer, session } = await setup();
  peer.accepted(undefined, 'multiple');
  peer.tool('multiple', 'first');
  peer.tool('multiple', 'second');
  peer.ended('multiple');
  await vi.waitFor(() => expect(session.chatCtx.items).toHaveLength(2));
  const calls = session.chatCtx.items as llm.FunctionCall[];
  for (const call of calls) call.extra.__livekit_agents_tool_non_blocking = true;
  const requests = peer.requests.length;
  await expect(session.updateChatCtx(new llm.ChatContext(calls.reverse()))).rejects.toThrow(
    'append order',
  );
  expect(peer.requests).toHaveLength(requests);
});
it('does not reorder messages within the same response', async () => {
  const { peer, session } = await setup();
  peer.accepted(undefined, 'multiple');
  for (const id of ['first', 'second']) {
    peer.message('multiple', id);
    peer.emit('response.text.done', {
      response_id: 'multiple',
      item_id: id,
      output_index: 0,
      content_index: 0,
      text: id,
    });
  }
  peer.ended('multiple');
  await vi.waitFor(() => expect(session.chatCtx.items).toHaveLength(2));
  const requests = peer.requests.length;
  await expect(
    session.updateChatCtx(new llm.ChatContext(session.chatCtx.items.reverse())),
  ).rejects.toThrow('append order');
  expect(peer.requests).toHaveLength(requests);
});
it('keeps strict edits of same-response filler order explicit', async () => {
  const { peer, session, call, output, message } = await repairedFillerProgress(true);
  await session.updateChatCtx(new llm.ChatContext([call, output, message]));
  expect(session.chatCtx.items.map((item) => item.id)).toEqual([call.id, output.id, message.id]);
  expect(peer.requests.some((request) => request.type === 'conversation.item.delete')).toBe(true);
});
it.each([false, true])('normalizes unchanged interleaved progress in strict=%s', async (strict) => {
  const { peer, session } = await setup(strict);
  const [call, output] = await liveCall(peer, session);
  await generated(peer, session, 'filler');
  const before = session.chatCtx;
  before.items.push(output);
  await session.updateChatCtx(before);
  const writes = peer.requests.filter((q) => q.type === 'conversation.item.create').length;
  const current = session.chatCtx;
  const message = current.items.find((i) => i.type === 'message')!;
  await session.updateChatCtx(new llm.ChatContext([call, output, message, ...pair('next')]));
  expect(session.chatCtx.items.map((i) => i.id)).toEqual([
    call.id,
    message.id,
    output.id,
    'next',
    'result-next',
  ]);
  expect(peer.requests.filter((q) => q.type === 'conversation.item.create')).toHaveLength(
    writes + 2,
  );
});
it('preserves late generated messages omitted by a stale strict progress append', async () => {
  const { peer, session } = await setup(true);
  const initial = pair('initial');
  await session.updateChatCtx(new llm.ChatContext(initial));
  const next = pair('next', Date.now() - 1000);
  await generated(peer, session, 'late');
  await session.updateChatCtx(new llm.ChatContext([...initial, ...next]));
  expect(session.chatCtx.items.map((i) => i.id)).toEqual([
    'initial',
    'result-initial',
    'message-late',
    'next',
    'result-next',
  ]);
  expect(peer.requests.some((q) => q.type === 'conversation.item.delete')).toBe(false);
});
it('does not move progress results across omitted user messages', async () => {
  const { peer, session } = await setup();
  const [call, output] = await liveCall(peer, session);
  const user = llm.ChatMessage.create({ role: 'user', content: 'barrier' });
  await generated(peer, session, 'filler');
  const withUser = session.chatCtx;
  withUser.items.push(user);
  await session.updateChatCtx(withUser);
  const before = session.chatCtx;
  before.items.push(output);
  await session.updateChatCtx(before);
  const message = session.chatCtx.items.find((i) => i.id === 'message-filler')!;
  await expect(session.updateChatCtx(new llm.ChatContext([call, output, message]))).rejects.toThrow(
    'append order',
  );
});
it('rejects changed progress content before writing', async () => {
  const { peer, session } = await setup();
  const initial = pair('initial');
  await session.updateChatCtx(new llm.ChatContext(initial));
  const writes = peer.requests.length;
  initial[1].output = 'changed';
  await expect(session.updateChatCtx(new llm.ChatContext(initial))).rejects.toThrow('conflicts');
  expect(peer.requests).toHaveLength(writes);
});
it('preserves inactive filler configuration across tool removal and clears explicitly', async () => {
  const { peer, model, session } = await setup();
  const fillers = {
    lookup: { type: 'text' as const, text: 'Checking' },
    future: { type: 'text' as const, text: 'Later' },
  };
  model.updateOptions({ toolFillers: fillers });
  fillers.lookup.text = 'mutated';
  const tools = new llm.ToolContext({
    lookup: llm.tool({ description: 'Lookup', execute: async () => 'done' }),
  });
  await session.updateTools(tools);
  expect(peer.settings.tools).toMatchObject([
    { function: { name: 'lookup' }, prism_filler: { text: 'Checking' } },
  ]);
  await session.updateTools(llm.ToolContext.empty());
  await session.updateTools(tools);
  expect(peer.settings.tools).toMatchObject([
    { function: { name: 'lookup' }, prism_filler: { text: 'Checking' } },
  ]);
  session.updateOptions({ toolFillers: {} });
  await session.updateTools(tools);
  expect(peer.settings.tools).toEqual(
    expect.arrayContaining([expect.not.objectContaining({ prism_filler: expect.anything() })]),
  );
});
it('queues option snapshots before subsequent replies and recovers after refusal', async () => {
  const { peer, model, session, errors } = await setup();
  peer.onRequest = (q) => {
    if (q.session?.voice === 'refused') {
      peer.fault(q, 'invalid_voice');
      return true;
    }
    if (q.type === 'response.create') {
      peer.reply(q);
      return true;
    }
  };
  expect(model.updateOptions({ voice: 'first' })).toBeUndefined();
  model.updateOptions({ voice: 'refused' });
  model.updateOptions({ voice: 'last' });
  await session.generateReply();
  expect(model.sessionInfo?.voice).toBe('last');
  expect(errors).toHaveLength(1);
  expect(errors[0]?.recoverable).toBe(true);
  expect(peer.requests.filter((q) => q.session?.voice).map((q) => q.session?.voice)).toEqual([
    'first',
    'refused',
    'last',
  ]);
  expect(peer.requests.at(-1)?.type).toBe('response.create');
  await session.commitAudio();
  expect(session.isClosed).toBe(false);
  await session.close();
  expect(() => session.updateOptions({ voice: 'after-close' })).toThrow('closed');
});
it('configures copied options before the first session opens', async () => {
  const peer = await new PrismPeer().start();
  cleanup.push(() => peer.close());
  const model = new RealtimeModel({ apiKey: 'test', endpoint: peer.endpoint });
  cleanup.push(() => model.close());
  const options = { voice: 'before-open', responseMetadata: { stage: 'initial' } };
  model.updateOptions(options);
  options.responseMetadata.stage = 'mutated';
  await model.session().updateInstructions('Test');
  expect(peer.settings).toMatchObject({
    voice: 'before-open',
    prism_response_metadata: { stage: 'initial' },
  });
});
it.each([false, true])(
  'supports repeated standard RunContext updates with final error=%s',
  async (fail) => {
    const peer = await new PrismPeer().start();
    cleanup.push(() => peer.close());
    const model = new RealtimeModel({
      apiKey: 'test',
      endpoint: peer.endpoint,
      contextMode: 'strict',
    });
    cleanup.push(() => model.close());
    const session = new voice.AgentSession({
      llm: model,
      vad: null,
      aecWarmupDuration: null,
      turnHandling: { turnDetection: 'realtime_llm' },
    });
    session.output.audio = new TestAudioOutput();
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const execute = vi.fn(async (_: unknown, { ctx }: { ctx: voice.RunContext }) => {
      await ctx.update('first progress');
      await ctx.update('silent progress', { silent: true });
      await ctx.update('second progress');
      finish();
      if (fail) throw new llm.ToolError('lookup failed');
      return 'final result';
    });
    await session.start({
      agent: new voice.Agent({
        instructions: 'Test',
        tools: {
          lookup: llm.tool({ description: 'Lookup', execute }),
        },
      }),
    });
    cleanup.push(() => session.close());
    let count = 0;
    peer.onRequest = (q) => {
      if (q.type !== 'response.create') return;
      const id = `reply-${++count}`;
      if (count === 1) {
        peer.accepted(q, id);
        peer.tool(id);
        peer.ended(id);
      } else {
        peer.reply(q, id);
        peer.history.push({
          id: `message-${id}`,
          type: 'message',
          role: 'assistant',
          text: 'Hello',
        });
      }
      return true;
    };
    const speech = session.generateReply({ userInput: 'Check' });
    await completed;
    await speech.waitForPlayout();
    await vi.waitFor(() =>
      expect(peer.history.filter((item) => item.type === 'function_call_output')).toHaveLength(4),
    );
    expect(execute).toHaveBeenCalledOnce();
    const outputs = peer.history
      .filter((item) => item.type === 'function_call_output')
      .map((item) => item.output);
    for (const text of [
      'first progress',
      'silent progress',
      'second progress',
      fail ? 'lookup failed' : 'final result',
    ])
      expect(outputs.filter((output) => output?.includes(text))).toHaveLength(1);
  },
);

it('accepts progress from two concurrent tools without repeating either execution', async () => {
  const peer = await new PrismPeer().start();
  cleanup.push(() => peer.close());
  const model = new RealtimeModel({
    apiKey: 'test',
    endpoint: peer.endpoint,
    contextMode: 'strict',
  });
  cleanup.push(() => model.close());
  const session = new voice.AgentSession({
    llm: model,
    vad: null,
    aecWarmupDuration: null,
    turnHandling: { turnDetection: 'realtime_llm' },
  });
  session.output.audio = new TestAudioOutput();
  const errors: llm.RealtimeModelError[] = [];
  const open = model.session.bind(model);
  vi.spyOn(model, 'session').mockImplementation((...args) => {
    const provider = open(...args);
    provider.on('error', (error) => errors.push(error));
    return provider;
  });
  let started = 0;
  let release!: () => void;
  const bothStarted = new Promise<void>((resolve) => {
    release = resolve;
  });
  const executions = new Map<string, number>();
  const tools = Object.fromEntries(
    ['one', 'two'].map((name) => [
      name,
      llm.tool({
        description: name,
        execute: async (_: unknown, { ctx }: { ctx: voice.RunContext }) => {
          executions.set(name, (executions.get(name) ?? 0) + 1);
          await ctx.update(`${name} started`);
          if (++started === 2) release();
          await bothStarted;
          await ctx.update(`${name} silent`, { silent: true });
          return `${name} completed`;
        },
      }),
    ]),
  );
  await session.start({ agent: new voice.Agent({ instructions: 'Test', tools }) });
  cleanup.push(() => session.close());
  let count = 0;
  peer.onRequest = (q) => {
    if (q.type !== 'response.create') return;
    const id = `concurrent-${++count}`;
    if (count === 1) {
      peer.accepted(q, id);
      peer.tool(id, 'call-one', 'one');
      peer.tool(id, 'call-two', 'two');
      peer.ended(id);
    } else {
      peer.reply(q, id);
      peer.history.push({ id: `message-${id}`, type: 'message', role: 'assistant', text: 'Hello' });
    }
    return true;
  };
  await session.generateReply({ userInput: 'Run both tools' }).waitForPlayout();
  await vi.waitFor(() =>
    expect(peer.history.filter((item) => item.type === 'function_call_output')).toHaveLength(6),
  );
  expect([...executions.values()]).toEqual([1, 1]);
  for (const name of ['one', 'two'])
    for (const stage of ['started', 'silent', 'completed'])
      expect(peer.history.filter((item) => item.output?.includes(`${name} ${stage}`))).toHaveLength(
        1,
      );
  expect(errors).toEqual([]);
});

it.each(['resource', 'input', 'admission'] as const)(
  'keeps the session usable after a local %s option refusal',
  async (kind) => {
    const { session, model, errors } = await setup();
    const types = await import('@rimelabs/sdk');
    const sdk = (session as unknown as { sdk: import('@rimelabs/sdk').RealtimeSession }).sdk;
    const error =
      kind === 'resource'
        ? new types.RimeResourceLimitError('local limit')
        : kind === 'input'
          ? new types.RimeInputError('bad input')
          : new types.RealtimeAdmissionTimeout('not ready');
    vi.spyOn(sdk, 'update').mockRejectedValueOnce(error);
    session.updateOptions({ voice: 'refused' });
    session.updateOptions({ voice: 'accepted' });
    await session.updateInstructions('After options');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.recoverable).toBe(true);
    expect(model.sessionInfo?.voice).toBe('accepted');
    expect(session.isClosed).toBe(false);
  },
);
