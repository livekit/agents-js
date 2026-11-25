// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  log,
  voice,
} from '@livekit/agents';
import { fileURLToPath } from 'node:url';

class MoodAgent extends voice.Agent {
  constructor() {
    super({ instructions: 'Have a friendly, concise conversation with the caller.' });
  }

  async onEnter(): Promise<void> {
    const live = this.duplexSession;
    if (!(live instanceof inference.DuplexSession)) throw new Error('Expected DuplexSession');
    live.on('decision_event', (envelope) => {
      if (envelope.event.type === 'decision.completed') {
        // Answers may contain customer information; handle them in the application.
        log().info({ eventId: envelope.event_id }, 'Mood evaluation completed');
      }
    });
    this.session.generateReply({ instructions: 'Greet the caller.' });
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const session = new voice.AgentSession({
      llm: new inference.DuplexModel({
        model: 'openai/gpt-live-1',
        modelOptions: {
          triggers: [
            {
              type: 'decisions',
              eventType: 'session.input_transcript.delta',
              decisions: {
                model: 'openai/gpt-6-luna-decisions',
                questions: [
                  {
                    type: 'choice',
                    name: 'mood',
                    instructions: "What is the caller's mood?",
                    choices: [{ value: 'happy' }, { value: 'sad' }],
                  },
                ],
              },
            },
          ],
        },
      }),
    });
    await session.start({ agent: new MoodAgent(), room: ctx.room });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
