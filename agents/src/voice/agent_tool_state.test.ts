// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FunctionCall } from '../llm/index.js';
import { AgentActivity } from './agent_activity.js';
import { AgentSession } from './agent_session.js';
import { type AgentState, createToolExecutionUpdatedEvent } from './events.js';

function finishSpeechWithBackgroundTool(backgroundToolRunning: boolean): AgentState[] {
  const states: AgentState[] = [];
  const fakeActivity = {
    speechQueue: { peek: () => undefined },
    _currentSpeech: { done: () => true },
    _backgroundSpeeches: new Set(backgroundToolRunning ? [{}] : []),
    audioRecognition: undefined,
    isInterruptionDetectionEnabled: false,
    agentSession: {
      _updateAgentState: (state: AgentState) => states.push(state),
    },
  };
  const onPipelineReplyDone = (AgentActivity.prototype as unknown as Record<string, unknown>)
    .onPipelineReplyDone as (this: typeof fakeActivity) => void;
  onPipelineReplyDone.call(fakeActivity);
  return states;
}

function toolStarted(callId: string) {
  return createToolExecutionUpdatedEvent({
    type: 'tool_call_started',
    functionCall: FunctionCall.create({ callId, name: 'lookup_order', args: '{}' }),
  });
}

function toolEnded(callId: string, message: string | null) {
  return createToolExecutionUpdatedEvent({
    type: 'tool_call_ended',
    id: callId,
    callId,
    message,
    status: 'done',
  });
}

describe('agent and user state while tools run', () => {
  afterEach(() => vi.useRealTimers());

  it('slow tool keeps agent thinking after filler', () => {
    expect(finishSpeechWithBackgroundTool(true)).toEqual(['thinking']);
    expect(finishSpeechWithBackgroundTool(true)).toEqual(['thinking']);
    expect(finishSpeechWithBackgroundTool(false)).toEqual(['listening']);
  });

  it('tool without a reply returns the agent to listening', () => {
    expect(finishSpeechWithBackgroundTool(true)).toEqual(['thinking']);
    expect(finishSpeechWithBackgroundTool(false)).toEqual(['listening']);
  });

  it('async tool defers user away until its reply lands', async () => {
    vi.useFakeTimers();
    const session = new AgentSession({ userAwayTimeout: 3 });
    const awayStates: string[] = [];
    session.on('user_state_changed', (event) => awayStates.push(event.newState));

    session._updateAgentState('listening');
    session._toolExecutionUpdated(toolStarted('call-1'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(awayStates).not.toContain('away');

    session._toolExecutionUpdated(toolEnded('call-1', 'order 42 shipped'));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(awayStates).not.toContain('away');
    await vi.advanceTimersByTimeAsync(1);
    expect(awayStates).toContain('away');
  });

  it('async tool without a reply still restarts the away window', async () => {
    vi.useFakeTimers();
    const session = new AgentSession({ userAwayTimeout: 3 });
    const awayStates: string[] = [];
    session.on('user_state_changed', (event) => awayStates.push(event.newState));

    session._toolExecutionUpdated(toolStarted('call-2'));
    session._updateAgentState('listening');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(awayStates).not.toContain('away');

    session._toolExecutionUpdated(toolEnded('call-2', null));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(awayStates).toContain('away');
  });
});
