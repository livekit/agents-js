// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  llm,
  voice,
} from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const voices = {
  greeter: {
    id: '9BWtsMINqrJLrRacOk9x', // Aria - calm, professional female voice
    name: 'Aria',
    category: 'premade',
  },
  reservation: {
    id: 'EXAVITQu4vr4xnSDxMaL', // Sarah - warm, reassuring professional tone
    name: 'Sarah',
    category: 'premade',
  },
  takeaway: {
    id: 'CwhRBWXzGAHq8TQ4Fs17', // Roger - confident middle-aged male
    name: 'Roger',
    category: 'premade',
  },
  checkout: {
    id: '5Q0t7uMcjvnagumLfvZi', // Paul - authoritative middle-aged male
    name: 'Paul',
    category: 'premade',
  },
};

type UserData = {
  customer: Partial<{
    name: string;
    phone: string;
  }>;
  creditCard: Partial<{
    number: string;
    expiry: string;
    cvv: string;
  }>;
  reservationTime?: string;
  order?: string[];
  expense?: number;
  checkedOut?: boolean;
  agents: Record<string, voice.Agent<UserData>>;
  prevAgent?: voice.Agent<UserData>;
};

function createUserData(agents: Record<string, voice.Agent<UserData>>) {
  return {
    customer: {},
    creditCard: {},
    agents,
  };
}

function summarize({
  customer,
  reservationTime,
  order,
  creditCard,
  expense,
  checkedOut,
}: UserData) {
  return JSON.stringify(
    {
      customer: customer.name ?? 'unknown',
      customerPhone: customer.phone ?? 'unknown',
      reservationTime: reservationTime ?? 'unknown',
      order: order ?? 'unknown',
      creditCard: creditCard
        ? {
            number: creditCard.number ?? 'unknown',
            expiry: creditCard.expiry ?? 'unknown',
            cvv: creditCard.cvv ?? 'unknown',
          }
        : undefined,
      expense: expense ?? 'unknown',
      checkedOut: checkedOut ?? false,
    },
    null,
    2,
  );
}

const updateName = llm.tool({
  description:
    'Called when the user provides their name. Confirm the spelling with the user before calling the function.',
  parameters: z.object({
    name: z.string().describe('The customer name'),
  }),
  execute: async ({ name }, { ctx }: llm.ToolOptions<UserData>) => {
    ctx.userData.customer.name = name;
    return `The name is updated to ${name}`;
  },
});

const updatePhone = llm.tool({
  description:
    'Called when the user provides their phone number. Confirm the spelling with the user before calling the function.',
  parameters: z.object({
    phone: z.string().describe('The customer phone number'),
  }),
  execute: async ({ phone }, { ctx }: llm.ToolOptions<UserData>) => {
    ctx.userData.customer.phone = phone;
    return `The phone number is updated to ${phone}`;
  },
});

const toGreeter = llm.tool({
  description:
    'Called when user asks any unrelated questions or requests any other services not in your job description.',
  execute: async (_, { ctx }: llm.ToolOptions<UserData>) => {
    const currAgent = ctx.session.currentAgent as BaseAgent;
    return await currAgent.transferToAgent({
      name: 'greeter',
      ctx,
    });
  },
});

class BaseAgent extends voice.Agent<UserData> {
  name: string;

  constructor(options: voice.AgentOptions<UserData> & { name: string }) {
    const { name, ...opts } = options;
    super(opts);
    this.name = name;
  }

  async onEnter(): Promise<void> {
    const userdata = this.session.userData;
    const chatCtx = this.chatCtx.copy();

    // add the previous agent's chat history to the current agent
    if (userdata.prevAgent) {
      const truncatedChatCtx = userdata.prevAgent.chatCtx
        .copy({
          excludeInstructions: true,
          excludeFunctionCall: false,
        })
        .truncate(6);
      const existingIds = new Set(chatCtx.items.map((item) => item.id));
      const newItems = truncatedChatCtx.items.filter((item) => !existingIds.has(item.id));
      chatCtx.items.push(...newItems);
    }

    // add an instructions including the user data as system message
    chatCtx.addMessage({
      role: 'system',
      content: `You are ${this.name} agent. Current user data is ${summarize(userdata)}`,
    });

    await this.updateChatCtx(chatCtx);
    this.session.generateReply({ toolChoice: 'none' });
  }

  async transferToAgent(options: { name: string; ctx: voice.RunContext<UserData> }) {
    const { name, ctx } = options;
    const userdata = ctx.userData;
    const currentAgent = ctx.session.currentAgent;
    const nextAgent = userdata.agents[name];
    if (!nextAgent) {
      throw new Error(`Agent ${name} not found`);
    }
    userdata.prevAgent = currentAgent;

    return llm.handoff({
      agent: nextAgent,
      returns: `Transferring to ${name}`,
    });
  }
}

function createGreeterAgent(menu: string) {
  const greeter = new BaseAgent({
    name: 'greeter',
    instructions: `You are a friendly restaurant receptionist. The menu is: ${menu}\nYour jobs are to greet the caller and understand if they want to make a reservation or order takeaway. Guide them to the right agent using tools.`,
    // TODO(brian): support parallel tool calls
    tts: new elevenlabs.TTS({ voice: voices.greeter }),
    tools: {
      toReservation: llm.tool({
        description: `Called when user wants to make or update a reservation.
        This function handles transitioning to the reservation agent
        who will collect the necessary details like reservation time,
        customer name and phone number.`,
        execute: async (_, { ctx }): Promise<llm.AgentHandoff> => {
          return await greeter.transferToAgent({
            name: 'reservation',
            ctx,
          });
        },
      }),
      toTakeaway: llm.tool({
        description: `Called when the user wants to place a takeaway order.
        This includes handling orders for pickup, delivery, or when the user wants to
        proceed to checkout with their existing order.`,
        execute: async (_, { ctx }): Promise<llm.AgentHandoff> => {
          return await greeter.transferToAgent({
            name: 'takeaway',
            ctx,
          });
        },
      }),
    },
  });

  return greeter;
}

function createReservationAgent() {
  const reservation = new BaseAgent({
    name: 'reservation',
    instructions: `You are a reservation agent at a restaurant. Your jobs are to ask for the reservation time, then customer's name, and phone number. Then confirm the reservation details with the customer.`,
    tts: new elevenlabs.TTS({ voice: voices.reservation }),
    tools: {
      updateName,
      updatePhone,
      toGreeter,
      updateReservationTime: llm.tool({
        description: `Called when the user provides their reservation time.
        Confirm the time with the user before calling the function.`,
        parameters: z.object({
          time: z.string().describe('The reservation time'),
        }),
        execute: async ({ time }, { ctx }) => {
          ctx.userData.reservationTime = time;
          return `The reservation time is updated to ${time}`;
        },
      }),
      confirmReservation: llm.tool({
        description: `Called when the user confirms the reservation.`,
        execute: async (_, { ctx }): Promise<llm.AgentHandoff | string> => {
          const userdata = ctx.userData;
          if (!userdata.customer.name || !userdata.customer.phone) {
            return 'Please provide your name and phone number first.';
          }
          if (!userdata.reservationTime) {
            return 'Please provide reservation time first.';
          }
          return await reservation.transferToAgent({
            name: 'greeter',
            ctx,
          });
        },
      }),
    },
  });

  return reservation;
}

function createTakeawayAgent(menu: string) {
  const takeaway = new BaseAgent({
    name: 'takeaway',
    instructions: `Your are a takeaway agent that takes orders from the customer. Our menu is: ${menu}\nClarify special requests and confirm the order with the customer.`,
    tts: new elevenlabs.TTS({ voice: voices.takeaway }),
    tools: {
      toGreeter,
      updateOrder: llm.tool({
        description: `Called when the user provides their order.`,
        parameters: z.object({
          items: z.array(z.string()).describe('The items of the full order'),
        }),
        execute: async ({ items }, { ctx }) => {
          ctx.userData.order = items;
          return `The order is updated to ${items}`;
        },
      }),
      toCheckout: llm.tool({
        description: `Called when the user confirms the order.`,
        execute: async (_, { ctx }): Promise<llm.AgentHandoff | string> => {
          const userdata = ctx.userData;
          if (!userdata.order) {
            return 'No takeaway order found. Please make an order first.';
          }
          return await takeaway.transferToAgent({
            name: 'checkout',
            ctx,
          });
        },
      }),
    },
  });

  return takeaway;
}

function createCheckoutAgent(menu: string) {
  const checkout = new BaseAgent({
    name: 'checkout',
    instructions: `You are a checkout agent at a restaurant. The menu is: ${menu}\nYour are responsible for confirming the expense of the order and then collecting customer's name, phone number and credit card information, including the card number, expiry date, and CVV step by step.`,
    tts: new elevenlabs.TTS({ voice: voices.checkout }),
    tools: {
      updateName,
      updatePhone,
      toGreeter,
      confirmExpense: llm.tool({
        description: `Called when the user confirms the expense.`,
        parameters: z.object({
          expense: z.number().describe('The expense of the order'),
        }),
        execute: async ({ expense }, { ctx }) => {
          ctx.userData.expense = expense;
          return `The expense is confirmed to be ${expense}`;
        },
      }),
      updateCreditCard: llm.tool({
        description: `Called when the user provides their credit card number, expiry date, and CVV.
        Confirm the spelling with the user before calling the function.`,
        parameters: z.object({
          number: z.string().describe('The credit card number'),
          expiry: z.string().describe('The expiry date of the credit card'),
          cvv: z.string().describe('The CVV of the credit card'),
        }),
        execute: async ({ number, expiry, cvv }, { ctx }) => {
          ctx.userData.creditCard = { number, expiry, cvv };
          return `The credit card number is updated to ${number}`;
        },
      }),
      confirmCheckout: llm.tool({
        description: `Called when the user confirms the checkout.`,
        execute: async (_, { ctx }): Promise<llm.AgentHandoff | string> => {
          const userdata = ctx.userData;
          if (!userdata.expense) {
            return 'Please confirm the expense first.';
          }
          if (
            !userdata.creditCard.number ||
            !userdata.creditCard.expiry ||
            !userdata.creditCard.cvv
          ) {
            return 'Please provide the credit card information first.';
          }
          userdata.checkedOut = true;
          return await checkout.transferToAgent({
            name: 'greeter',
            ctx,
          });
        },
      }),
      toTakeaway: llm.tool({
        description: `Called when the user wants to update their order.`,
        execute: async (_, { ctx }): Promise<llm.AgentHandoff> => {
          return await checkout.transferToAgent({
            name: 'takeaway',
            ctx,
          });
        },
      }),
    },
  });

  return checkout;
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const menu = 'Pizza: $10, Salad: $5, Ice Cream: $3, Coffee: $2';
    const userData = createUserData({
      greeter: createGreeterAgent(menu),
      reservation: createReservationAgent(),
      takeaway: createTakeawayAgent(menu),
      checkout: createCheckoutAgent(menu),
    });

    const vad = ctx.proc.userData.vad! as silero.VAD;
    const session = new voice.AgentSession({
      vad,
      stt: new deepgram.STT(),
      tts: new elevenlabs.TTS(),
      llm: new openai.LLM(),
      // to use realtime model, replace the stt, llm, tts and vad with the following
      // llm: new openai.realtime.RealtimeModel(),
      turnDetection: new livekit.turnDetector.EnglishModel(),
      userData,
      voiceOptions: {
        maxToolSteps: 5,
      },
    });

    await session.start({
      agent: userData.agents.greeter!,
      room: ctx.room,
    });
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
