// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { HealthServiceAgent, type HealthServiceUserData } from './health_service_agent.js';

initializeLogger({ pretty: false, level: 'warn' });

function createOpenAILLM(): openai.LLM {
  return new openai.LLM({
    model: 'gpt-4.1',
    temperature: 0.2,
  });
}

describe('HealthService Agent (mock task group)', { timeout: 60_000 }, () => {
  let session: voice.AgentSession;
  let userData: HealthServiceUserData;

  beforeEach(async () => {
    userData = {};
    session = new voice.AgentSession({
      llm: createOpenAILLM(),
      userData,
    });
  });

  afterEach(async () => {
    if (session) {
      await session.close().catch(() => undefined);
    }
  });

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it.skipIf(!process.env.OPENAI_API_KEY)(
    'starts task group on enter and completes verify-intent step',
    async () => {
      await session.start({
        agent: new HealthServiceAgent(),
      });

      const verifyIntentTurn = session.run({
        userInput: 'Yes, plz!',
      });
      await verifyIntentTurn.wait();

      verifyIntentTurn.expect.containsFunctionCall({ name: 'verifyIntent' });

      const identifyPatientTurn = session.run({
        userInput: 'My name is Brian Yin and my date of birth is 1900-08-06',
      });
      await identifyPatientTurn.wait();

      identifyPatientTurn.expect.containsFunctionCall({ name: 'identifyPatient' });

      const schedulePatientVisitTurn = session.run({
        userInput: 'My preferred date and time is 2026-08-06 at 10:00 AM',
      });
      await schedulePatientVisitTurn.wait();

      schedulePatientVisitTurn.expect.containsFunctionCall({ name: 'schedulePatientVisit' });
    },
  );
});
