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
import {
  COMMON_INSTRUCTIONS,
  FakeDB,
  type MenuItem,
  findItemsById,
  menuInstructions,
} from './database.js';
import {
  OrderState,
  createOrderedCombo,
  createOrderedHappy,
  createOrderedRegular,
} from './order.js';

export interface UserData {
  order: OrderState;
  drinkItems: MenuItem[];
  comboItems: MenuItem[];
  happyItems: MenuItem[];
  regularItems: MenuItem[];
  sauceItems: MenuItem[];
}

export class DriveThruAgent extends voice.Agent<UserData> {
  constructor(userdata: UserData) {
    const instructions =
      COMMON_INSTRUCTIONS +
      '\n\n' +
      menuInstructions('drink', userdata.drinkItems) +
      '\n\n' +
      menuInstructions('combo_meal', userdata.comboItems) +
      '\n\n' +
      menuInstructions('happy_meal', userdata.happyItems) +
      '\n\n' +
      menuInstructions('regular', userdata.regularItems) +
      '\n\n' +
      menuInstructions('sauce', userdata.sauceItems);

    super({
      instructions,
      tools: {
        orderComboMeal: DriveThruAgent.buildComboOrderTool(
          userdata.comboItems,
          userdata.drinkItems,
          userdata.sauceItems,
        ),
        orderHappyMeal: DriveThruAgent.buildHappyOrderTool(
          userdata.happyItems,
          userdata.drinkItems,
          userdata.sauceItems,
        ),
        orderRegularItem: DriveThruAgent.buildRegularOrderTool(
          userdata.regularItems,
          userdata.drinkItems,
          userdata.sauceItems,
        ),
        removeOrderItem: llm.tool({
          description: `Removes one or more items from the user's order using their \`orderId\`s.

Useful when the user asks to cancel or delete existing items (e.g., "Remove the cheeseburger").

If the \`orderId\`s are unknown, call \`listOrderItems\` first to retrieve them.`,
          parameters: z.object({
            orderIds: z
              .array(z.string())
              .describe(
                'A list of internal `orderId`s of the items to remove. Use `listOrderItems` to look it up if needed.',
              ),
          }),
          execute: async ({ orderIds }, { ctx }: llm.ToolOptions<UserData>) => {
            const notFound = orderIds.filter((oid) => !ctx.userData.order.items[oid]);
            if (notFound.length > 0) {
              throw new llm.ToolError(
                `error: no item(s) found with order_id(s): ${notFound.join(', ')}`,
              );
            }

            const removedItems = await Promise.all(
              orderIds.map((oid) => ctx.userData.order.remove(oid)),
            );
            return 'Removed items:\n' + removedItems.map((item) => JSON.stringify(item)).join('\n');
          },
        }),
        listOrderItems: llm.tool({
          description: `Retrieves the current list of items in the user's order, including each item's internal \`orderId\`.

Helpful when:
- An \`orderId\` is required before modifying or removing an existing item.
- Confirming details or contents of the current order.

Examples:
- User requests modifying an item, but the item's \`orderId\` is unknown (e.g., "Change the fries from small to large").
- User requests removing an item, but the item's \`orderId\` is unknown (e.g., "Remove the cheeseburger").
- User asks about current order details (e.g., "What's in my order so far?").`,
          execute: async (_, { ctx }: llm.ToolOptions<UserData>) => {
            const items = Object.values(ctx.userData.order.items);
            if (items.length === 0) {
              return 'The order is empty';
            }

            return items.map((item) => JSON.stringify(item)).join('\n');
          },
        }),
      },
    });
  }

  static buildComboOrderTool(
    comboItems: MenuItem[],
    drinkItems: MenuItem[],
    sauceItems: MenuItem[],
  ) {
    const availableComboIds = [...new Set(comboItems.map((item) => item.id))];
    const availableDrinkIds = [...new Set(drinkItems.map((item) => item.id))];
    const availableSauceIds = [...new Set(sauceItems.map((item) => item.id))];

    return llm.tool({
      description: `Call this when the user orders a **Combo Meal**, like: "Number 4b with a large Sprite" or "I'll do a medium meal."

Do not call this tool unless the user clearly refers to a known combo meal by name or number.
Regular items like a single cheeseburger cannot be made into a meal unless such a combo explicitly exists.

Only call this function once the user has clearly specified both a drink and a sauce — always ask for them if they're missing.

A meal can only be Medium or Large; Small is not an available option.
Drink and fries sizes can differ (e.g., "large fries but a medium Coke").

If the user says just "a large meal," assume both drink and fries are that size.`,
      parameters: z.object({
        mealId: z
          .enum(availableComboIds as [string, ...string[]])
          .describe('The ID of the combo meal the user requested.'),
        drinkId: z
          .enum(availableDrinkIds as [string, ...string[]])
          .describe('The ID of the drink the user requested.'),
        drinkSize: z.enum(['M', 'L']).nullable().describe('The size of the drink'),
        friesSize: z.enum(['M', 'L']).describe('The size of the fries'),
        sauceId: z
          .enum(availableSauceIds as [string, ...string[]])
          .nullable()
          .describe('The ID of the sauce the user requested.'),
      }),
      execute: async (
        { mealId, drinkId, drinkSize, friesSize, sauceId },
        { ctx }: llm.ToolOptions<UserData>,
      ) => {
        if (!findItemsById(comboItems, mealId).length) {
          throw new llm.ToolError(`error: the meal ${mealId} was not found`);
        }

        const drinkSizes = findItemsById(drinkItems, drinkId);
        if (!drinkSizes.length) {
          throw new llm.ToolError(`error: the drink ${drinkId} was not found`);
        }

        let actualDrinkSize = drinkSize || undefined;
        const actualSauceId = sauceId || undefined;

        const availableSizes = [
          ...new Set(drinkSizes.map((item) => item.size).filter((size) => size !== undefined)),
        ];
        if (actualDrinkSize === undefined && availableSizes.length > 1) {
          throw new llm.ToolError(
            `error: ${drinkId} comes with multiple sizes: ${availableSizes.join(', ')}. Please clarify which size should be selected.`,
          );
        }

        if (actualDrinkSize !== undefined && !availableSizes.length) {
          throw new llm.ToolError(
            `error: size should not be specified for item ${drinkId} as it does not support sizing options.`,
          );
        }

        if (actualDrinkSize && !availableSizes.includes(actualDrinkSize)) {
          actualDrinkSize = undefined;
        }

        if (actualSauceId && !findItemsById(sauceItems, actualSauceId).length) {
          throw new llm.ToolError(`error: the sauce ${actualSauceId} was not found`);
        }

        const item = createOrderedCombo({
          mealId,
          drinkId,
          drinkSize: actualDrinkSize,
          sauceId: actualSauceId,
          friesSize,
        });

        await ctx.userData.order.add(item);
        return `The item was added: ${JSON.stringify(item)}`;
      },
    });
  }

  static buildHappyOrderTool(
    happyItems: MenuItem[],
    drinkItems: MenuItem[],
    sauceItems: MenuItem[],
  ) {
    const availableHappyIds = [...new Set(happyItems.map((item) => item.id))];
    const availableDrinkIds = [...new Set(drinkItems.map((item) => item.id))];
    const availableSauceIds = [...new Set(sauceItems.map((item) => item.id))];

    return llm.tool({
      description: `Call this when the user orders a **Happy Meal**, typically for children. These meals come with a main item, a drink, and a sauce.

The user must clearly specify a valid Happy Meal option (e.g., "Can I get a Happy Meal?").

Before calling this tool:
- Ensure the user has provided all required components: a valid meal, drink, drink size, and sauce.
- If any of these are missing, prompt the user for the missing part before proceeding.

Assume Small as default only if the user says "Happy Meal" and gives no size preference, but always ask for clarification if unsure.`,
      parameters: z.object({
        mealId: z
          .enum(availableHappyIds as [string, ...string[]])
          .describe('The ID of the happy meal the user requested.'),
        drinkId: z
          .enum(availableDrinkIds as [string, ...string[]])
          .describe('The ID of the drink the user requested.'),
        drinkSize: z.enum(['S', 'M', 'L']).nullable().describe('The size of the drink'),
        sauceId: z
          .enum(availableSauceIds as [string, ...string[]])
          .nullable()
          .describe('The ID of the sauce the user requested.'),
      }),
      execute: async (
        { mealId, drinkId, drinkSize, sauceId },
        { ctx }: llm.ToolOptions<UserData>,
      ) => {
        if (!findItemsById(happyItems, mealId).length) {
          throw new llm.ToolError(`error: the meal ${mealId} was not found`);
        }

        const drinkSizes = findItemsById(drinkItems, drinkId);
        if (!drinkSizes.length) {
          throw new llm.ToolError(`error: the drink ${drinkId} was not found`);
        }

        let actualDrinkSize = drinkSize || undefined;
        const actualSauceId = sauceId || undefined;

        const availableSizes = [
          ...new Set(drinkSizes.map((item) => item.size).filter((size) => size !== undefined)),
        ];
        if (actualDrinkSize === undefined && availableSizes.length > 1) {
          throw new llm.ToolError(
            `error: ${drinkId} comes with multiple sizes: ${availableSizes.join(', ')}. Please clarify which size should be selected.`,
          );
        }

        if (actualDrinkSize !== undefined && !availableSizes.length) {
          actualDrinkSize = undefined;
        }

        if (actualSauceId && !findItemsById(sauceItems, actualSauceId).length) {
          throw new llm.ToolError(`error: the sauce ${actualSauceId} was not found`);
        }

        const item = createOrderedHappy({
          mealId,
          drinkId,
          drinkSize: actualDrinkSize,
          sauceId: actualSauceId,
        });

        await ctx.userData.order.add(item);
        return `The item was added: ${JSON.stringify(item)}`;
      },
    });
  }

  static buildRegularOrderTool(
    regularItems: MenuItem[],
    drinkItems: MenuItem[],
    sauceItems: MenuItem[],
  ) {
    const allItems = [...regularItems, ...drinkItems, ...sauceItems];
    const availableIds = [...new Set(allItems.map((item) => item.id))];

    return llm.tool({
      description: `Call this when the user orders **a single item on its own**, not as part of a Combo Meal or Happy Meal.

The customer must provide clear and specific input. For example, item variants such as flavor must **always** be explicitly stated.

The user might say—for example:
- "Just the cheeseburger, no meal"
- "A medium Coke"
- "Can I get some ketchup?"
- "Can I get a McFlurry Oreo?"`,
      parameters: z.object({
        itemId: z
          .enum(availableIds as [string, ...string[]])
          .describe('The ID of the item the user requested.'),
        size: z
          .enum(['S', 'M', 'L'])
          .nullable()
          .describe('Size of the item, if applicable (e.g., "S", "M", "L").'),
      }),
      execute: async ({ itemId, size }, { ctx }: llm.ToolOptions<UserData>) => {
        const itemSizes = findItemsById(allItems, itemId);
        if (!itemSizes.length) {
          throw new llm.ToolError(`error: ${itemId} was not found.`);
        }

        let actualSize = size || undefined;

        const availableSizes = [
          ...new Set(itemSizes.map((item) => item.size).filter((size) => size !== undefined)),
        ];
        if (actualSize === undefined && availableSizes.length > 1) {
          throw new llm.ToolError(
            `${itemId} comes with multiple sizes: ${availableSizes.join(', ')}. Please clarify which size should be selected.`,
          );
        }

        if (actualSize !== undefined && !availableSizes.length) {
          actualSize = undefined;
        }

        if (actualSize && availableSizes.length && !availableSizes.includes(actualSize)) {
          throw new llm.ToolError(
            `error: unknown size ${actualSize} for ${itemId}. Available sizes: ${availableSizes.join(', ')}.`,
          );
        }

        const item = createOrderedRegular({
          itemId,
          size: actualSize,
        });

        await ctx.userData.order.add(item);
        return `The item was added: ${JSON.stringify(item)}`;
      },
    });
  }
}

export async function newUserData(): Promise<UserData> {
  const fakeDb = new FakeDB();
  const drinkItems = await fakeDb.listDrinks();
  const comboItems = await fakeDb.listComboMeals();
  const happyItems = await fakeDb.listHappyMeals();
  const regularItems = await fakeDb.listRegulars();
  const sauceItems = await fakeDb.listSauces();

  const orderState = new OrderState();
  return {
    order: orderState,
    drinkItems,
    comboItems,
    happyItems,
    regularItems,
    sauceItems,
  };
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const userdata = await newUserData();

    const vad = ctx.proc.userData.vad! as silero.VAD;
    const session = new voice.AgentSession({
      vad,
      stt: new deepgram.STT(),
      llm: new openai.LLM({ model: 'gpt-4.1', temperature: 0.45 }),
      tts: new elevenlabs.TTS(),
      turnDetection: new livekit.turnDetector.MultilingualModel(),
      userData: userdata,
      voiceOptions: {
        maxToolSteps: 10,
      },
    });

    await session.start({
      agent: new DriveThruAgent(userdata),
      room: ctx.room,
    });
  },
});

// Only run CLI when executed directly, not when imported for testing
// eslint-disable-next-line turbo/no-undeclared-env-vars
if (process.env.VITEST === undefined) {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
}
