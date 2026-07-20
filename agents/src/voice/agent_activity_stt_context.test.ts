// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { STT as InferenceSTT } from '../inference/stt.js';
import { ChatMessage } from '../llm/index.js';
import { initializeLogger } from '../log.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AgentSessionEventTypes, createConversationItemAddedEvent } from './events.js';

describe('AgentActivity STT conversation-context lifecycle', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('forwards assistant context by default and removes listeners on close', async () => {
    const stt = new InferenceSTT({
      model: 'assemblyai/universal-3-5-pro',
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      baseURL: 'https://example.livekit.cloud',
    });
    const pushSpy = vi.spyOn(stt, '_pushConversationItem');
    const session = new AgentSession({ stt });
    const event = createConversationItemAddedEvent(
      ChatMessage.create({ role: 'assistant', content: ['hello'] }),
    );

    await session.start({ agent: new Agent({ instructions: 'test' }) });
    expect(session.listenerCount(AgentSessionEventTypes.ConversationItemAdded)).toBe(1);

    session.emit(AgentSessionEventTypes.ConversationItemAdded, event);
    expect(pushSpy).toHaveBeenCalledTimes(1);

    await session.close();
    expect(session.listenerCount(AgentSessionEventTypes.ConversationItemAdded)).toBe(0);
    expect(stt.listenerCount('capabilities_changed')).toBe(0);
  });

  it('does not forward context when the session opts out', async () => {
    const stt = new InferenceSTT({
      model: 'assemblyai/universal-3-5-pro',
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      baseURL: 'https://example.livekit.cloud',
    });
    const pushSpy = vi.spyOn(stt, '_pushConversationItem');
    const session = new AgentSession({
      stt,
      sttContextOptions: { forwardChatContext: false },
    });

    await session.start({ agent: new Agent({ instructions: 'test' }) });
    session.emit(
      AgentSessionEventTypes.ConversationItemAdded,
      createConversationItemAddedEvent(
        ChatMessage.create({ role: 'assistant', content: ['hello'] }),
      ),
    );

    expect(pushSpy).not.toHaveBeenCalled();
    expect(session.listenerCount(AgentSessionEventTypes.ConversationItemAdded)).toBe(0);
    await session.close();
  });

  it('stops forwarding when previous_context_n_turns disables carryover', async () => {
    const stt = new InferenceSTT({
      model: 'assemblyai/universal-streaming',
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      baseURL: 'https://example.livekit.cloud',
    });
    const pushSpy = vi.spyOn(stt, '_pushConversationItem');
    const session = new AgentSession({ stt });
    const event = createConversationItemAddedEvent(
      ChatMessage.create({ role: 'assistant', content: ['hello'] }),
    );

    await session.start({ agent: new Agent({ instructions: 'test' }) });
    expect(stt.listenerCount('capabilities_changed')).toBe(1);

    session.emit(AgentSessionEventTypes.ConversationItemAdded, event);
    expect(pushSpy).not.toHaveBeenCalled();

    stt.updateOptions({ model: 'assemblyai/universal-3-5-pro' });
    session.emit(AgentSessionEventTypes.ConversationItemAdded, event);
    expect(pushSpy).toHaveBeenCalledTimes(1);

    stt.updateOptions({ modelOptions: { previous_context_n_turns: 0 } });
    expect(stt.capabilities.chatContext).toBe(false);
    session.emit(AgentSessionEventTypes.ConversationItemAdded, event);
    expect(pushSpy).toHaveBeenCalledTimes(1);

    await session.close();
    expect(stt.listenerCount('capabilities_changed')).toBe(0);
  });
});
