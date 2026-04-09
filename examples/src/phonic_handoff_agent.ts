// For testing only!
import { type JobContext, ServerOptions, cli, defineAgent, llm, voice } from '@livekit/agents';
import * as phonic from '@livekit/agents-plugin-phonic';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

type UserData = {
  name?: string;
  email?: string;
  address?: string;
};

class NameAgent extends voice.Agent<UserData> {
  async onEnter() {
    this.session.generateReply();
  }

  static create() {
    return new NameAgent({
      instructions:
        'You are Alex, a friendly interviewer. You just started the call. ' +
        'Greet the user, then ask for their full name. ' +
        'Once you have it, thank the user and call record_name.',
      tools: {
        record_name: llm.tool({
          description: "Record the user's name and move on.",
          parameters: z.object({
            name: z.string().describe("The user's full name"),
          }),
          execute: async ({ name }, { ctx }) => {
            console.log(`Got name: ${name}`);
            ctx.userData.name = name;
            return llm.handoff({ agent: EmailAgent.create() });
          },
        }),
      },
    });
  }
}

class EmailAgent extends voice.Agent<UserData> {
  async onEnter() {
    this.session.generateReply({
      instructions: 'Transition naturally and ask for their email address.',
    });
  }

  static create() {
    return new EmailAgent({
      instructions:
        'You are Alex, continuing an interview. ' +
        'Ask the user for their email address. Be conversational. ' +
        'Once you have it, thank the user and call record_email.',
      tools: {
        record_email: llm.tool({
          description: "Record the user's email and move on.",
          parameters: z.object({
            email: z.string().describe("The user's email address"),
          }),
          execute: async ({ email }, { ctx }) => {
            console.log(`Got email: ${email}`);
            ctx.userData.email = email;
            return llm.handoff({ agent: AddressAgent.create() });
          },
        }),
      },
    });
  }
}

class AddressAgent extends voice.Agent<UserData> {
  async onEnter() {
    this.session.generateReply({
      instructions: 'Transition naturally and ask for their mailing address.',
    });
  }

  static create() {
    return new AddressAgent({
      instructions:
        'You are Alex, wrapping up an interview. ' +
        'Ask the user for their mailing address (city and state is fine). ' +
        'Once you have it, thank the user and call record_address.',
      tools: {
        record_address: llm.tool({
          description: "Record the user's address and finish.",
          parameters: z.object({
            address: z.string().describe("The user's mailing address"),
          }),
          execute: async ({ address }, { ctx }) => {
            console.log(`Got address: ${address}`);
            ctx.userData.address = address;
            const { name, email } = ctx.userData;
            console.log(`All collected: name=${name}, email=${email}, address=${address}`);
            return 'Thank the user for their time. Let them know they are all set.';
          },
        }),
      },
    });
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const session = new voice.AgentSession({
      llm: new phonic.realtime.RealtimeModel({
        voice: 'sabrina',
        audioSpeed: 1.2,
      }),
      userData: { name: undefined, email: undefined, address: undefined } as UserData,
    });

    await session.start({
      agent: NameAgent.create(),
      room: ctx.room,
    });

    await ctx.connect();
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
