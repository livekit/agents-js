// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm, voice } from '@livekit/agents';
import { z } from 'zod';
import {
  type Allergen,
  CRUST,
  DRINK_SIZES,
  type EndedEarly,
  HOURS,
  type Ingredient,
  type ItemId,
  type ItemSpec,
  MENU,
  NEIGHBORHOOD,
  PIZZA_SIZES,
  PizzeriaError,
  RESTAURANT,
  SAUCES,
  SOLD_OUT_TODAY,
  type SauceId,
  TOPPINGS,
  type ToppingId,
  compared,
  money,
  sizeWords,
} from './pizzeria.js';
import type { Pizzeria } from './pizzeria.js';

export const PERSONA = 'Gabby';
export const GREETING = `Thanks for calling ${RESTAURANT}, this is ${PERSONA}. What can I get started for you?`;
const VOICE_RULES = `You're on a phone call, so talk like a person, not a document:
- One or two short sentences at a time, and one question at a time. No lists, markdown, or symbols.
- Say prices and times the way people say them ("nineteen ninety-nine", "about twenty minutes"). Never read out ids.
- Only state a price, total, or order number that a tool gave you.
- Never say you've done something, or that you're about to, without calling its tool in that same reply.
- When a tool refuses, fix what it says with your tools. Tell the caller only what changes for them.
- You handle everything yourself. There's nobody to transfer to, and no callbacks to promise.
- They pay in person, cash or card, never over the phone: never take card details. There are no discount codes.
- A tip only if they ask to add one: set_tip.
- When they're done, say a short goodbye and call end_call in that same reply. If they say goodbye with an order that isn't placed, ask whether to place it first.`;
const itemIds = [...MENU.keys()] as [ItemId, ...ItemId[]];
const toppingIds = [...TOPPINGS.keys()] as [ToppingId, ...ToppingId[]];
const sauceIds = [...SAUCES.keys()] as [SauceId, ...SauceId[]];
const ingredients = [...new Set([...MENU.values()].flatMap((item) => item.ingredients))].sort() as [
  Ingredient,
  ...Ingredient[],
];
const sizes = ['small', 'medium', 'large', 'half_dozen', 'dozen'] as const;
const itemSchema = z.object({
  itemId: z.enum(itemIds).describe('The menu id.'),
  size: z
    .enum(sizes)
    .nullish()
    .describe(
      'Required for pizzas, wings, and drinks that come in sizes, and only a size the caller said for this item.',
    ),
  quantity: z.number().int().default(1).describe('How many: "a dozen wings" is 1, size dozen.'),
  toppings: z.array(z.enum(toppingIds)).default([]).describe('Extra toppings on a whole pizza.'),
  sauce: z
    .enum(sauceIds)
    .nullish()
    .describe(
      "Wings only, and only a sauce the caller chose from ours. If they haven't chosen, or asked for one we don't have, leave it out: the wings still go on, and you ask.",
    ),
  without: z
    .array(z.enum(ingredients))
    .default([])
    .describe('What to leave off a pizza ("no olives"), from its ingredients.'),
  firstHalf: z
    .array(z.enum(toppingIds))
    .default([])
    .describe('Half-and-half only: the toppings on one half.'),
  secondHalf: z
    .array(z.enum(toppingIds))
    .default([])
    .describe('Half-and-half only: the toppings on the other half.'),
});
const facts = (fields: Record<string, unknown>): string => JSON.stringify(fields);
const protect = async <T>(fn: () => Promise<T> | T): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PizzeriaError) throw new llm.ToolError(e.message);
    throw e;
  }
};

type Review = { action: 'place' | 'cancel' | 'drop'; revision: number };
class OrderDesk extends voice.Agent<Pizzeria> {
  protected review: Review | null = null;
  constructor(
    protected readonly pos: Pizzeria,
    instructions: string,
    tools: llm.ToolContext<Pizzeria>,
  ) {
    const shared = [
      llm.tool({
        name: 'set_tip',
        description:
          'Add the tip the caller asks for, or change it; 0 takes it off. Only when they ask. Pass dollars or percent, one of the two.',
        parameters: z.object({ dollars: z.number().nullish(), percent: z.number().nullish() }),
        execute: async ({ dollars, percent }) => {
          const tip = await protect(() => pos.setTip(dollars, percent));
          return facts({ ...this.moneyFacts(), tip: money(tip), ...this.readBackStatus() });
        },
      }),
      llm.tool({
        name: 'cancel_order',
        description:
          'Cancel the whole order. Call it the moment they ask, before you ask them anything: the first call returns what to confirm with them. Call it again once they agree.',
        execute: async () => this.cancelOrder(),
      }),
    ];
    super({ instructions, tools: new llm.ToolContext([...tools.tools, ...shared]) });
  }
  private matches(action: Review['action']): boolean {
    return this.review?.action === action && this.review.revision === this.pos.revision;
  }
  protected readBackStatus(): Record<string, string> {
    const r = this.review;
    if (!r || r.action === 'drop' || r.revision === this.pos.revision) return {};
    return {
      readBack: `Out of date: this changed what you read back. Call ${r.action === 'place' ? 'place_order' : 'cancel_order'} for the new read-back and read it to them before they agree.`,
    };
  }
  protected moneyFacts(): Record<string, unknown> {
    return this.pos.quote()?.facts() ?? {};
  }
  private async cancelOrder(): Promise<string> {
    if (!this.pos.order) return this.dropUnplaced();
    if (this.matches('cancel')) {
      const order = await protect(() => this.pos.cancel());
      return facts({
        cancelled: `order ${order.number}`,
        due: money(this.pos.dueNow()),
        next: "Tell them it's cancelled and nothing is due, and ask if there's anything else.",
      });
    }
    const readBack = await protect(() => this.pos.cancelReadBack());
    this.review = { action: 'cancel', revision: this.pos.revision };
    return facts({
      cancelled: false,
      readBack,
      next: "It isn't cancelled: they haven't heard this in full yet. Ask them now, using this, whether to cancel the whole order, and wait for their answer. Call cancel_order again only once they agree.",
    });
  }
  private async dropUnplaced(): Promise<string> {
    if (!this.pos.lines.length)
      return facts({
        cancelled: false,
        placed: false,
        next: "Nothing was placed, so there's nothing to cancel and nothing is due. Tell them.",
      });
    if (this.matches('drop')) {
      await protect(() => this.pos.drop());
      return facts({
        dropped: true,
        due: money(this.pos.dueNow()),
        next: "Tell them it's dropped and nothing is due. If they've already said goodbye, say goodbye and end_call in this same reply; otherwise ask if there's anything else.",
      });
    }
    const readBack = await protect(() => this.pos.dropReadBack());
    this.review = { action: 'drop', revision: this.pos.revision };
    return facts({
      dropped: false,
      readBack,
      next: "Nothing's placed yet, and nothing comes off until they agree. If they might mean one item, or something about one item, ask which. Otherwise ask them now, using this, whether to drop the whole order, and wait for their answer. Call cancel_order again only once they agree to drop all of it.",
    });
  }
}

export class TakeOrder extends OrderDesk {
  constructor(pos: Pizzeria) {
    super(pos, orderInstructions(), new llm.ToolContext<Pizzeria>());
    this._toolCtx = new llm.ToolContext([
      ...this._toolCtx.tools,
      llm.tool({
        name: 'add_items',
        description:
          'Put what the caller orders on the order as soon as they say it: everything they just named, in one call. Anything that cannot go on yet comes back with what to ask.',
        parameters: z.object({ items: z.array(itemSchema) }),
        execute: async ({ items }) => {
          const [added, problems] = await protect(() => pos.addItems(items as ItemSpec[]));
          const noted = [...pos.allergies.keys()];
          return facts({
            added: added.map((l) => l.facts()),
            notAdded: problems,
            containsAllergyTheyMentioned: added
              .filter((l) => noted.some((a) => l.allergens.has(a)))
              .map((l) => ({
                item: l.label,
                contains: noted.filter((a) => l.allergens.has(a)).sort(),
              })),
            ...pos.cartFacts(),
            ...this.readBackStatus(),
          });
        },
      }),
      llm.tool({
        name: 'update_item',
        description:
          'Change one line on the order. Pass only what changes; everything else stays as it is. quantity is the new total.',
        parameters: z.object({
          lineId: z.string().describe('The line, e.g. "L1".'),
          itemId: z
            .enum(itemIds)
            .optional()
            .describe('A different menu item for this line ("make the Coke a Sprite").'),
          size: z.enum(sizes).optional().describe('The new size.'),
          quantity: z
            .number()
            .int()
            .optional()
            .describe('The new total for this line, not how many more.'),
          toppings: z
            .array(z.enum(toppingIds))
            .optional()
            .describe('The full new list of extra toppings; [] takes them all off.'),
          sauce: z.enum(sauceIds).optional().describe('The new wing sauce.'),
          without: z
            .array(z.enum(ingredients))
            .optional()
            .describe('The full new list of what to leave off; [] puts everything back.'),
          firstHalf: z
            .array(z.enum(toppingIds))
            .optional()
            .describe('The full new list for one half of a half-and-half.'),
          secondHalf: z
            .array(z.enum(toppingIds))
            .optional()
            .describe('The full new list for the other half.'),
        }),
        execute: async ({ lineId, ...changes }) => {
          const [line, changed] = await protect(() =>
            pos.updateItem(lineId, changes as Partial<ItemSpec>),
          );
          return facts({
            ...(changed
              ? { updated: line.facts() }
              : { nothingChanged: `${line.id} is already ${line.describe()}.` }),
            ...pos.cartFacts(),
            ...this.readBackStatus(),
          });
        },
      }),
      llm.tool({
        name: 'remove_item',
        description: 'Take one line off the order.',
        parameters: z.object({ lineId: z.string() }),
        execute: async ({ lineId }) => {
          const line = await protect(() => pos.removeItem(lineId));
          return facts({ removed: line.describe(), ...pos.cartFacts(), ...this.readBackStatus() });
        },
      }),
      llm.tool({
        name: 'check_allergen',
        description:
          'Look up which menu items contain an allergen, before answering any allergy question. One allergen per call. Lactose intolerance is dairy, celiac is gluten.',
        parameters: z.object({
          allergen: z.enum(['nuts', 'dairy', 'gluten', 'egg', 'fish']),
          severe: z.boolean().default(false),
        }),
        execute: async ({ allergen, severe }) =>
          facts({
            allergen,
            contains: await protect(() => pos.checkAllergen(allergen as Allergen, severe)),
            sharedKitchen: true,
            next: 'Say which items contain it. Everything is made in one kitchen, so never call anything safe or free of it.',
          }),
      }),
      llm.tool({
        name: 'set_pickup',
        description: 'The caller will pick the order up.',
        execute: async () => {
          await protect(() => pos.setFulfillment('pickup'));
          return facts({ pickup: true, ...this.moneyFacts(), ...this.readBackStatus() });
        },
      }),
      llm.tool({
        name: 'set_delivery',
        description:
          'Delivery: where to, and anything the driver should know. Pass only what they just told you, never a placeholder like "N/A"; what you leave out stays as it is.',
        parameters: z.object({
          address: z
            .string()
            .nullish()
            .describe('The street address to deliver to, as they said it.'),
          zipCode: z.string().nullish().describe('The five-digit ZIP code, only if they gave one.'),
          driverNote: z
            .string()
            .nullish()
            .describe(
              'Drop-off details for the driver ("leave it at the door"), in a few words, only if they gave some. It replaces the last note.',
            ),
        }),
        execute: async ({ address, zipCode, driverNote }) => {
          const f = await protect(() =>
            pos.setFulfillment('delivery', address, zipCode, driverNote),
          );
          return facts({
            deliveryTo: f.address,
            driverNote: f.driverNote,
            ...this.moneyFacts(),
            ...this.readBackStatus(),
          });
        },
      }),
      llm.tool({
        name: 'set_contact',
        description: 'The name for the order and a callback number. Pass what they just gave you.',
        parameters: z.object({
          name: z.string().nullish().describe('The name for the order.'),
          phone: z
            .string()
            .nullish()
            .describe('The callback number, all ten digits, written without spaces.'),
        }),
        execute: async ({ name, phone }) => {
          await protect(() => pos.setContact(name, phone));
          return facts({ name: pos.name, phone: pos.phone });
        },
      }),
      llm.tool({
        name: 'place_order',
        description:
          'Send the order to the kitchen. The first call checks it is ready and returns what to read back; call it again once the caller has said it is right. After any change it is read back again.',
        execute: async () => {
          if (this.review?.action === 'place' && this.review.revision === pos.revision) {
            const order = await protect(() => pos.place());
            return facts({
              orderNumber: order.number,
              readyIn: order.readyIn,
              next: "Tell them the order number and when it'll be ready, then ask if there's anything else.",
            });
          }
          const readBack = await protect(() => pos.orderReadBack());
          this.review = { action: 'place', revision: pos.revision };
          return facts({
            placed: false,
            readBack,
            next: "It isn't placed: they haven't heard this read-back in full yet. Read it to them now as a question (the items, how it gets to them, any note for the driver, and the total with what it includes) and wait for their answer. Call place_order again only once they agree.",
          });
        },
      }),
    ]);
  }
}

export class DeliveryUpdate extends OrderDesk {
  constructor(pos: Pizzeria) {
    super(pos, updateInstructions(pos), new llm.ToolContext<Pizzeria>());
    this._toolCtx = new llm.ToolContext([
      ...this._toolCtx.tools,
      llm.tool({
        name: 'swap_sold_out_item',
        description:
          'Replace the item that ran out with the one they choose, at the same price. Also when they change their mind, even after taking it off.',
        parameters: z.object({ itemId: z.enum(itemIds) }),
        execute: async ({ itemId }) => {
          const line = await protect(() => pos.swapSoldOutItem(itemId));
          return facts({ nowOnTheOrder: line.label, samePrice: true, ...this.moneyFacts() });
        },
      }),
      llm.tool({
        name: 'take_off_sold_out_item',
        description:
          "Take the item that ran out off the order, once they've said they'd rather not have a replacement.",
        execute: async () =>
          facts({
            lessAtTheDoor: money(await protect(() => pos.takeOffSoldOutItem())),
            ...this.moneyFacts(),
          }),
      }),
      llm.tool({
        name: 'set_breadsticks',
        description:
          'How many orders of breadsticks to add, the only thing that can still go on the order. The total they want; 0 takes them off.',
        parameters: z.object({ orders: z.number().int() }),
        execute: async ({ orders }) => {
          const change = await protect(() => pos.setBreadsticks(orders));
          return facts({
            breadsticks: orders,
            moreAtTheDoor: change >= 0 ? money(change) : null,
            lessAtTheDoor: change < 0 ? money(-change) : null,
            ...this.moneyFacts(),
          });
        },
      }),
      llm.tool({
        name: 'set_driver_note',
        description:
          "Save drop-off details for the driver. It replaces the last note. It can't change the address.",
        parameters: z.object({ note: z.string() }),
        execute: async ({ note }) => {
          await protect(() => pos.setDriverNote(note));
          return facts({ driverNote: pos.fulfillment.driverNote });
        },
      }),
      llm.tool({
        name: 'read_back_changes',
        description:
          "What changed on this call, what's due at the door, and when the driver gets there. Call once settled and after any later change.",
        execute: async () =>
          facts({
            ...(await protect(() => pos.readBackChanges())),
            next: "Say each change once (not the whole order), with any code or unit number in a note digit by digit; what's due at the door, and when the driver will be there, with how that compares to before. If they've already said that's all, that's your goodbye: end_call in this same reply. Otherwise ask if there's anything else.",
          }),
      }),
      llm.tool({
        name: 'end_without_update',
        description:
          "End the call without going through the update: a wrong number or someone else, a bad time, or they don't want to.",
        parameters: z.object({ reason: z.enum(['wrong_person', 'call_back_later', 'declined']) }),
        execute: async ({ reason }) => {
          await protect(() => pos.endEarly(reason as EndedEarly));
          return facts({
            next:
              reason === 'wrong_person'
                ? 'Apologize for the mix-up and say goodbye. Say nothing about the order, the address, or who it is for. Then end_call.'
                : 'The order goes on as it is. Say goodbye, then end_call.',
          });
        },
      }),
    ]);
  }
  protected override moneyFacts(): Record<string, unknown> {
    return {
      dueAtTheDoor: money(this.pos.dueNow()),
      comparedToBefore: compared(this.pos.balance()),
    };
  }
}

export function deliveryOpener(pos: Pizzeria): string {
  const d = pos.delivery!,
    first = pos.name?.split(' ')[0],
    hi = first ? `Hi ${first},` : 'Hi,';
  return `${hi} this is ${PERSONA} from ${RESTAURANT}, calling about your delivery order. ${d.driver} was packing it up to head out and realized there's no ${pos.ranOutLine().item.name} left. Would a ${pos.samePriceSwaps()[0]} at the same price work instead, or should I take it off?`;
}
function menuText(): string {
  return [...MENU.values()]
    .map((m) => {
      const prices = Object.entries(m.prices)
        .map(([s, p]) => `${sizeWords(s)} ${money(p)}`.trim())
        .join(', ');
      return `- ${m.id}: ${m.name} ${m.category}, ${prices}${m.ingredients.length ? `; ${m.ingredients.join(', ')}` : ''}${m.details ? `; ${m.details}` : ''}${SOLD_OUT_TODAY.has(m.id) ? ' (sold out today)' : ''}`;
    })
    .join('\n');
}
function orderInstructions(): string {
  return `You're ${PERSONA}, answering the phone at ${RESTAURANT}, ${NEIGHBORHOOD}. Warm, quick, and lightly upbeat, like someone good at the counter on a busy night; calm and plain about allergies, complaints, or cancelling.
We're open ${HOURS} Anything else about the restaurant that isn't here, like the address or parking, you don't know.

${VOICE_RULES}

The menu (ids are for your tools):
${menuText()}
Pizza sizes: ${Object.entries(PIZZA_SIZES)
    .map(([s, a]) => `${s}, ${a}`)
    .join('; ')}. Crust: ${CRUST}. Drink sizes: ${Object.entries(DRINK_SIZES)
    .map(([s, a]) => `${s} ${a}`)
    .join(', ')}.
Extra toppings on a pizza, $2 each, $1 on half: ${[...TOPPINGS.values()].map((t) => t.name).join(', ')}. Wing sauces: ${[...SAUCES.values()].map((s) => s.name).join(', ')}.

Take the order the way they give it:
- Put what they order on the order right away with add_items, everything they just named in one call, and ask only for what's missing, like a size or a wing sauce. A size they gave for one item is never another item's size.
- Never choose for them. For something we don't have, like a sauce, a crust, or a topping, say so and offer what we do have. Wings go on without a sauce until they pick one of ours, and "no sauce" is plain.
- An item they name again that's already on the order is the same item, not another one. A change is to one line: update_item or remove_item.
- Half-and-half is one pizza, a cheese pizza unless they name another, with first_half and second_half. "No olives" goes in without, at the same price.
- Allergies: check_allergen for each one, then say which items the menu lists it in.
- Once, when the order sounds complete and has no breadsticks, offer breadsticks. That's the only thing you suggest.

Then:
1. Pickup or delivery: set_pickup, or set_delivery. We deliver anywhere with a street address, for $4.99. Anything for the driver goes in driver_note.
2. A name for the order, then a callback number: set_contact.
3. place_order, without summing up the order yourself first. It returns the order to read back: read it as a question. When they agree, call place_order again, then give them the order number and when it'll be ready, and ask if there's anything else. Anything short of agreeing (a change, a question, "almost") gets sorted out and read back again first.
Orders under $15 have a $2.99 small-order fee: say it once in the read-back, and never push them to add items.
To cancel: call cancel_order before asking anything, confirm with them what it returns, and call it again once they agree.`;
}
function updateInstructions(pos: Pizzeria): string {
  const d = pos.delivery!,
    items = [...d.ordered.values()].map((l) => l.describe()).join('; '),
    to = pos.name ?? "the customer, whose name you don't have: never say or guess one";
  return `You're ${PERSONA} from ${RESTAURANT}, calling ${to} about their delivery order, number ${pos.order!.number}: ${items}. It's going to ${pos.fulfillment.address}. ${d.driver}, the driver, is about to head out with it, about ${d.etaMinutes} minutes to their door, and ${money(d.due)} is due at the door, cash or card. Packing it up, ${d.driver} found the ${pos.ranOutLine().item.name} ran out after the order went in.
Polite, clear, and brief; calm and plain about money, a complaint, or cancelling.

${VOICE_RULES}

You've already said who you are and why you're calling, that ${d.driver} is about to head out, and that the ${pos.ranOutLine().item.name} ran out, and asked whether a ${pos.samePriceSwaps()[0]} at the same price works instead or to take it off. Whoever picked up is the customer: never ask who they are.
- Their choice: swap_sold_out_item (same-price options: ${pos.samePriceSwaps().join(', ')}), or take_off_sold_out_item. They can change their mind.
- Then ask once if there's anything ${d.driver} should know, like a gate code or the unit: set_driver_note. The address can't change; if it needs to go somewhere else, they can cancel.
- Only breadsticks can be added, since they're ready to go: set_breadsticks. Nothing else can go on without holding ${d.driver} up.
- A complaint: apologize sincerely, and offer only what you can do: the swap, taking it off, or cancelling. No discounts, credits, refunds, or free items.
- Cancelling the whole order: call cancel_order before asking anything, confirm with them what it returns, and call it again once they agree. The order doesn't go out and nothing is due.
- A wrong number, a bad time, or they'd rather not: end_without_update, before sharing anything more.
- Once the swap and the note for ${d.driver} are settled: read_back_changes, say what it gives you, and ask if there's anything else. After any later change, read_back_changes again. Once they have nothing else, goodbye and end_call.`;
}

export function callerScript(pos: Pizzeria): string {
  if (pos.delivery) {
    const facts = `Gabby from Zappi's Pizzeria called the caller about their delivery order, which is about to go out. The only details to use:\n- A large Coke at the same price is fine instead of the Sprite that ran out.\n- The driver should know the gate code is four five one two.\n- Nothing else to add.`;
    return `${facts}\n${pos.soldOutUnresolved() ? 'When Gabby asks about the Sprite, a Coke is fine.' : !pos.fulfillment.driverNote ? 'When Gabby asks about anything for the driver, the gate code is four five one two.' : "That's all. When Gabby reads back the changes and what's due, thanks, goodbye."}`;
  }
  const facts = `The caller is Sam Carter, ordering from Zappi's Pizzeria by phone. The only details to use:\n- The order: a large pepperoni pizza and a dozen bone-in wings with hot sauce, for pickup. No breadsticks or anything else.\n- Name: Sam Carter. Callback number: four one five, five five five, zero one four two.`;
  const stage = pos.order
    ? "The order is in. When Gabby asks if there's anything else, that's all, thanks, goodbye."
    : pos.name && pos.phone
      ? "When Gabby reads the order back, yes, that's right."
      : pos.fulfillment.mode
        ? 'Give the name when Gabby asks for it, then the callback number.'
        : pos.lines.length
          ? "If Gabby asks about the wing sauce, it's hot. No breadsticks, thanks. That's everything, for pickup."
          : 'Order the large pepperoni and the dozen hot wings, in one line.';
  return `${facts}\n${stage}`;
}
