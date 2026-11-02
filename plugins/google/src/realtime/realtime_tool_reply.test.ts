// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type * as genai from '@google/genai';
import { Behavior, FunctionResponseScheduling } from '@google/genai';
import { llm, log } from '@livekit/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealtimeModel, type RealtimeSession } from './realtime_api.js';

/** Tool responses the session sends, captured from the mocked live connection. */
const { sent } = vi.hoisted(() => ({
  sent: [] as genai.LiveSendToolResponseParameters[],
}));

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof genai>();
  return {
    ...actual,
    GoogleGenAI: class {
      live = {
        connect: async ({ callbacks }: { callbacks: { onopen: () => void } }) => {
          callbacks.onopen();
          return {
            sendClientContent: () => {},
            sendRealtimeInput: () => {},
            sendToolResponse: (params: genai.LiveSendToolResponseParameters) => sent.push(params),
            close: () => {},
          };
        },
      };
    },
  };
});

let session: RealtimeSession | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await session?.close();
  session = undefined;
  sent.length = 0;
});

async function openSession(toolBehavior: Behavior): Promise<RealtimeSession> {
  session = new RealtimeModel({
    model: 'gemini-2.0-flash-live-001',
    apiKey: 'test-key',
    toolBehavior,
  }).session();
  const internals = session as unknown as { activeSession?: unknown };
  await vi.waitFor(() => expect(internals.activeSession).toBeDefined());
  return session;
}

async function sendOutput(callId: string, name: string, replyRequired: boolean) {
  const chatCtx = session!.chatCtx.copy();
  chatCtx.insert(
    llm.FunctionCallOutput.create({ callId, name, output: '42', isError: false, replyRequired }),
  );
  await session!.updateChatCtx(chatCtx);
}

describe('Gemini realtime tool replies', () => {
  // Gemini blocks the turn until every call is answered, so a result that wants no reply is
  // still sent; SILENT records it without prompting speech.
  it.each([
    { replyRequired: false, scheduling: FunctionResponseScheduling.SILENT },
    { replyRequired: true, scheduling: undefined },
  ])(
    'schedules a NON_BLOCKING result with replyRequired=$replyRequired',
    async ({ replyRequired, scheduling }) => {
      await openSession(Behavior.NON_BLOCKING);

      await sendOutput('fc_1', 'lookup', replyRequired);

      await vi.waitFor(() => expect(sent).toHaveLength(1));
      const [response] = sent[0]!.functionResponses as genai.FunctionResponse[];
      expect(response?.id).toBe('fc_1');
      expect(response?.scheduling).toBe(scheduling);
    },
  );

  it('sends BLOCKING results that want no reply and warns for each update', async () => {
    const warn = vi.spyOn(log(), 'warn');
    await openSession(Behavior.BLOCKING);

    await sendOutput('fc_1', 'lookup', false);
    await sendOutput('fc_2', 'search', false);

    // Gemini ignores scheduling on BLOCKING declarations, so the reply cannot be prevented
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    for (const { functionResponses } of sent) {
      expect((functionResponses as genai.FunctionResponse[])[0]?.scheduling).toBeUndefined();
    }
    const warnings = warn.mock.calls.filter(([, message]) =>
      String(message).includes('wants no reply'),
    );
    expect(warnings.map(([fields]) => fields)).toEqual([
      { functions: ['lookup'] },
      { functions: ['search'] },
    ]);
  });
});
