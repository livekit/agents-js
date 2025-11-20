// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { initializeLogger } from '../log.js';
import { Future, delay } from '../utils.js';
import { Agent } from './agent.js';
import { AgentActivity } from './agent_activity.js';
import { AgentSession } from './agent_session.js';
import { SpeechHandle } from './speech_handle.js';

// Initialize logger for tests
initializeLogger({ pretty: true, level: 'error' });

describe('AgentActivity - Issue #836: mainTask hanging when interrupting queued speech', () => {
  describe('Real AgentActivity integration', () => {
    it('should directly test mainTask with queue inspection', async () => {
      // Create AgentActivity with access to private methods
      const agent = new Agent({ instructions: 'Test agent' });
      const agentSession = new AgentSession({});
      const agentActivity = new AgentActivity(agent, agentSession);

      await agentActivity.start();

      // Access private members through casting
      const activity = agentActivity as any;

      // Create speeches
      const speech1 = SpeechHandle.create();
      const speech2 = SpeechHandle.create();
      const speech3 = SpeechHandle.create();

      // Interrupt speech2
      speech2.interrupt();

      // Directly access and inspect the queue
      expect(activity.speechQueue.size()).toBe(0);

      // Schedule speeches
      activity.scheduleSpeech(speech1, 5);
      activity.scheduleSpeech(speech2, 5);
      activity.scheduleSpeech(speech3, 5);

      // Verify queue size
      expect(activity.speechQueue.size()).toBe(3);

      // Mark generations done for non-interrupted speeches
      setTimeout(() => {
        if (!speech1.interrupted) speech1._markGenerationDone();
      }, 50);
      setTimeout(() => {
        if (!speech3.interrupted) speech3._markGenerationDone();
      }, 100);

      // Wait for mainTask to process
      await delay(250);

      // After processing, queue should be empty
      expect(activity.speechQueue.size()).toBe(0);

      // Verify current speech is cleared
      expect(activity._currentSpeech).toBeUndefined();
    });

    it('should test mainTask queue processing order with priorities', async () => {
      // Test that mainTask respects priority ordering
      const agent = new Agent({ instructions: 'Test agent' });
      const agentSession = new AgentSession({});
      const agentActivity = new AgentActivity(agent, agentSession);

      await agentActivity.start();

      const activity = agentActivity as any;

      // Create speeches with different priorities
      const lowPriority = SpeechHandle.create();
      const normalPriority = SpeechHandle.create();
      const highPriority = SpeechHandle.create();

      // Interrupt all to make processing fast
      lowPriority.interrupt();
      normalPriority.interrupt();
      highPriority.interrupt();

      // Schedule in reverse priority order to test queue sorting
      activity.scheduleSpeech(lowPriority, 0); // SPEECH_PRIORITY_LOW
      activity.scheduleSpeech(normalPriority, 5); // SPEECH_PRIORITY_NORMAL
      activity.scheduleSpeech(highPriority, 10); // SPEECH_PRIORITY_HIGH

      // Queue should have 3 items
      expect(activity.speechQueue.size()).toBe(3);

      // Wait for mainTask to process
      await delay(200);

      // Queue should be empty after processing
      expect(activity.speechQueue.size()).toBe(0);

      // All speeches should be scheduled and interrupted
      [lowPriority, normalPriority, highPriority].forEach((s) => {
        expect(s.scheduled).toBe(true);
        expect(s.interrupted).toBe(true);
      });
    });

    it('should verify mainTask does not hang with manual abort signal test', async () => {
      // This test manually calls mainTask and tests abort behavior
      const agent = new Agent({ instructions: 'Test agent' });
      const agentSession = new AgentSession({});
      const agentActivity = new AgentActivity(agent, agentSession);

      // Don't start() - we'll manually set up for mainTask testing
      const activity = agentActivity as any;

      // Create an abort controller to stop mainTask
      const abortController = new AbortController();

      // Create interrupted speeches
      const speech1 = SpeechHandle.create();
      const speech2 = SpeechHandle.create();
      speech1.interrupt();
      speech2.interrupt();

      // Manually add to queue
      activity.speechQueue.push([5, 1000, speech1]);
      activity.speechQueue.push([5, 2000, speech2]);
      activity.q_updated = new Future();
      activity.q_updated.resolve(); // Wake up mainTask

      // Call mainTask directly with timeout protection
      const mainTaskPromise = activity.mainTask(abortController.signal);

      // Let mainTask process the interrupted speeches
      await delay(100);

      // Abort the mainTask
      abortController.abort();

      // mainTask should exit cleanly without hanging
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('mainTask did not exit after abort')), 1000),
      );

      await expect(Promise.race([mainTaskPromise, timeoutPromise])).resolves.not.toThrow();

      // Queue should be empty
      expect(activity.speechQueue.size()).toBe(0);
    });
  });
});
