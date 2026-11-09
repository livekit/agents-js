// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm, voice } from '@livekit/agents';
import { z } from 'zod';
import {
  type Alert,
  BANK_NAME,
  BankError,
  DECLINED_CARD,
  type DateOnly,
  VERIFIED_CARD,
  addDays,
  birthDate,
  cardDigits,
  daysBetween,
  parseDateOnly,
} from './bank.js';
import type { Bank } from './bank.js';

export const BANK_TZ = 'America/New_York';
export type Request = 'charge' | 'lock' | 'travel' | 'other';

const DIGIT_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
];

export function spoken(digits: string): string {
  return Array.from(digits, (digit) => DIGIT_WORDS[Number(digit)]).join('-');
}

export const GREETING =
  "Hi! I'm Avery, and this is a demo for financial verification. Can I get your name?";

export function outboundGreeting(): string {
  return `Hi, it's Avery, calling for your LiveKit demo. I'll play the fraud team at ${BANK_NAME}, calling about a purchase on your card. Nothing here is real, so just play along. Okay: this is Avery from ${BANK_NAME} fraud prevention, about recent activity on your card ending in ${spoken(VERIFIED_CARD)}. Who am I speaking with?`;
}

export const SAMPLE_NAME = 'Jordan Lee';
export const SAMPLE_BIRTH_DATE: DateOnly = '1990-04-22';

const DEMO_NOTE = `Play the bank agent. Step out of the role only briefly, starting with something like "Quick demo note", at these moments:
- {moments}
- when they ask about the demo itself, like whether this is real or how it works: answer in a sentence or two, mention that the page shows each step as it happens, and go back to the call.
Never claim to see a real account or anyone's real details.`;

const VOICE_RULES = `You're on a phone call, so talk like a person, not a document:
- Brisk and warm. One or two short sentences at a time, and one question at a time. No lists, markdown, or symbols.
- Never say you've done something, or that you're about to, without calling its tool in that same reply.
- You know nothing about the caller, the card, or the bank except what a tool returned on this call. Never say whether they're verified, describe a charge, give a case number, or say the card is locked or a notice is set until a tool's result says so. Use its exact merchant, place, amount, case number, and date; never make one up.
- When a tool refuses, fix what it says with your tools. Tell the caller only what changes for them.`;

const GOODBYE = `When they're all set, ask if there's anything else. Once they say that's all, or answer with a no or a thank-you, say a short goodbye that thanks them for trying the demo, and call end_call in that same reply. Never say goodbye before they've had a chance to say they're done.`;

function asToolError(error: unknown): never {
  if (error instanceof BankError) throw new llm.ToolError(error.message);
  throw error;
}

export class CardDesk extends voice.Agent<Bank> {
  constructor(
    protected readonly bank: Bank,
    instructions: string,
    tools: llm.ToolContextEntry<Bank>[],
  ) {
    super({ instructions, tools });
  }

  async reportPurchase(madeByCardholder: boolean): Promise<string> {
    try {
      const card = await this.bank.recordAnswer(madeByCardholder);
      if (madeByCardholder) {
        return "Marked as the cardholder's purchase. Ask whether they're traveling, and if so until when.";
      }
      return JSON.stringify({
        card: 'locked',
        loss_prevention_case: card.caseId,
        next: 'Tell them the card is locked and the case is with loss prevention, who will follow up.',
      });
    } catch (error) {
      return asToolError(error);
    }
  }

  async setTravelNotice(destination: string, backOn: string): Promise<string> {
    try {
      let until: DateOnly;
      try {
        until = parseDateOnly(backOn);
      } catch {
        throw new llm.ToolError(`Use YYYY-MM-DD, got ${JSON.stringify(backOn)}.`);
      }
      const today = todayInBankTimezone();
      const card = await this.bank.setTravelNotice(destination, until, today);
      const travel = card.travel!;
      return `Travel notice set for ${travel.destination} through ${formatWeekdayMonthDay(until)}, ${daysBetween(today, until)} days from today. No calls about purchases there until then.`;
    } catch (error) {
      return asToolError(error);
    }
  }

  protected commonTools(): llm.ToolContextEntry<Bank>[] {
    return [
      llm.tool({
        name: 'report_purchase',
        description:
          "Record whether the cardholder made the flagged purchase. If they didn't, the card is locked and the case goes to loss prevention.",
        parameters: z.object({
          madeByCardholder: z
            .boolean()
            .describe('True if the cardholder says they made the purchase, False if they did not.'),
        }),
        execute: ({ madeByCardholder }) => this.reportPurchase(madeByCardholder),
      }),
      llm.tool({
        name: 'set_travel_notice',
        description:
          "Note that the cardholder is traveling, so purchases there don't trigger a call.",
        parameters: z.object({
          destination: z.string().describe('Where they are traveling, like "Italy".'),
          backOn: z.string().describe('The day they are back home, YYYY-MM-DD.'),
        }),
        execute: ({ destination, backOn }) => this.setTravelNotice(destination, backOn),
      }),
    ];
  }
}

export class CardServices extends CardDesk {
  constructor(bank: Bank) {
    const today = todayInBankTimezone();
    const demoNote = DEMO_NOTE.replace(
      '{moments}',
      "after a check that didn't go through, as described below;",
    );
    const instructions = `You are Avery, the voice agent in a LiveKit demo. You play a card services agent at ${BANK_NAME}, a made-up bank, to show how a voice agent verifies a caller before it touches their account.
Nothing on this call is real. The caller can give any name and birthday. The card decides the identity check: a card ending in ${spoken(VERIFIED_CARD)} gets verified, and any other card, like ${spoken(DECLINED_CARD)}, doesn't.
Today is ${formatFullDate(today)}.
You've already explained the demo and asked for their name.

${demoNote}

${VOICE_RULES}

Verify them first, and only then ask what they need. You can help with a charge they don't recognize, locking their card, or a travel notice. Anything else, even a balance or an address you can't see, goes to a card specialist once they're verified: never turn it down. If they ask for something before they're verified, say you can help, and that first you'll need to verify them.

To verify them, ask for their name, their date of birth, and the last four digits of their card, one at a time, skipping anything they've already given. Ask with these words:
- Date of birth: "Hi [their name], usually I'd check your details against a database to make sure they match, but today we're just role-playing. Can I get a date of birth from you? It doesn't need to be a real one."
- Card: "Okay, great. And what are the last four digits of your card? We can use four ones for a success, or four zeros for a failure."
As soon as you have all three, call verify_identity with them and what they asked for, if they've said. Call it every time you have all three, even when you think you know how it will come out, like with ${spoken(DECLINED_CARD)}: never decide the result yourself.

If the check doesn't go through, say only that you weren't able to verify them with those details. Then add a quick demo note: a real bank wouldn't say which detail was off, and you don't know either, since the bank only answers yes or no. For the demo, a card ending in ${spoken(VERIFIED_CARD)} always gets through. Offer to try again. If they want to try again with the same details, call verify_identity again with them right away. If they'd rather give new ones, ask for all three again in one go, say them back in one sentence, and call verify_identity again.
If the check says they're locked out, say you can't verify them on this call and that they can call the number on the back of their card. Then say goodbye and call end_call.

Once they're verified, if they haven't said what they need yet, say exactly: "Great, you're all verified. I can look into a charge you don't recognize, lock your card, or set up a travel notice. What can I help you with?" Otherwise say "Great, you're all verified." Then help with what they asked:
- A charge they don't recognize: verify_identity returns it when that's what they asked for; otherwise call look_up_recent_charges. Describe it right away: where, which city and country, and the amount. Ask whether they made it, and call report_purchase as soon as they say. If it wasn't them, tell them the card is locked now, so nothing else can go through on it, and the case is with the loss prevention team, who will follow up. Give the case number from the result: the letters, then each digit on its own, without saying the dash.
- Locking their card: verify_identity locks it when that's what they asked for; otherwise call lock_card. Once it's locked, tell them nothing new can go through on it.
- A travel notice: ask where they're going and how long they'll be there, until they're back. Call set_travel_notice with the day they're back, counting a length like "two weeks" from today, then tell them they won't get a call about purchases there until then. If they add to or change the dates, call it again.
- Anything else: say you've passed it to a card specialist, who will follow up.

${GOODBYE}`;
    super(bank, instructions, []);
    this._toolCtx = new llm.ToolContext([...this.commonTools(), ...this.cardServicesTools()]);
  }

  async verifyIdentity(args: {
    fullName: string;
    dateOfBirth: string;
    cardLastFour: string;
    request: Request;
  }): Promise<string> {
    const result: Record<string, unknown> = {};
    try {
      if (!args.fullName.trim()) throw new BankError('Ask for their full name first.');
      result.verified = await this.bank.authenticate({
        name: args.fullName.trim(),
        dateOfBirth: birthDate(args.dateOfBirth, todayInBankTimezone()),
        lastFour: cardDigits(args.cardLastFour),
      });
      if (result.verified && args.request === 'charge') {
        result.recent_charge = charge(await this.bank.recentCharges());
      } else if (result.verified && args.request === 'lock') {
        const card = await this.bank.lockCard();
        result.card = `locked: nothing new can go through on the card ending in ${card.lastFour}`;
      }
    } catch (error) {
      return asToolError(error);
    }
    if (this.bank.lockedOut) result.locked_out = true;
    return JSON.stringify(result);
  }

  async lookUpRecentCharges(): Promise<string> {
    try {
      return JSON.stringify({ recent_charge: charge(await this.bank.recentCharges()) });
    } catch (error) {
      return asToolError(error);
    }
  }

  async lockCard(): Promise<string> {
    try {
      const card = await this.bank.lockCard();
      return `The card ending in ${card.lastFour} is locked. Nothing new can go through on it.`;
    } catch (error) {
      return asToolError(error);
    }
  }

  private cardServicesTools(): llm.ToolContextEntry<Bank>[] {
    return [
      llm.tool({
        name: 'verify_identity',
        description:
          "Check the caller's details with the bank. Returns only whether they're verified, and whether too many failed checks have locked them out. Once they're verified, it also takes care of what they asked for: it returns the charge they don't recognize, or locks the card.",
        parameters: z.object({
          fullName: z.string().describe("The caller's full name."),
          dateOfBirth: z.string().describe("The caller's date of birth, YYYY-MM-DD."),
          cardLastFour: z.string().describe('The last four digits of the card, like 1111.'),
          request: z
            .enum(['charge', 'lock', 'travel', 'other'])
            .describe(
              'What they called about: "charge" for a charge they don\'t recognize, "lock" to lock their card, "travel" for a travel notice, or "other".',
            ),
        }),
        execute: (args) => this.verifyIdentity(args),
      }),
      llm.tool({
        name: 'look_up_recent_charges',
        description:
          "Look up the recent charge on the verified caller's card, when they're asking about one they don't recognize.",
        execute: () => this.lookUpRecentCharges(),
      }),
      llm.tool({
        name: 'lock_card',
        description: "Lock the verified caller's card, so nothing new can go through on it.",
        execute: () => this.lockCard(),
      }),
    ];
  }
}

export class FraudAlert extends CardDesk {
  constructor(bank: Bank) {
    const today = todayInBankTimezone();
    const demoNote = DEMO_NOTE.replace('{moments}', 'if they seem unsure what this call is;');
    const instructions = `You are Avery, the voice agent in a LiveKit demo. You placed this call to show how a voice agent handles a fraud alert: you play ${BANK_NAME}'s fraud prevention team, calling about a purchase the bank flagged on their card ending in ${spoken(VERIFIED_CARD)}.
Nothing on this call is real. Any name and birthday they give is fine.
Today is ${formatFullDate(today)}.
You've already explained the demo and asked who you're speaking with.

${demoNote}

${VOICE_RULES}

If it's not a good time, say you'll try again later, then say goodbye and call end_call.
Once they've said their name, ask for their date of birth to confirm it's them. Say it back, and call verify_identity with their name and date of birth in that same reply. Never say anything about the purchase until it comes back verified. If it says the date can't be right, ask for it once more.
Once verified, describe the flagged purchase exactly as it came back: where, which city and country, and the amount. Ask whether they made it, and call report_purchase as soon as they answer.
- If they didn't make it: say the card is locked now, so nothing else can go through on it, and that you're forwarding their case to the loss prevention team, who will follow up with them. Give the case number from the result: the letters, then each digit on its own, without saying the dash.
- If they did: ask whether they're traveling, and if so, how long they'll be there, until they're back. Call set_travel_notice with where they are and the day they're back, counting a length like "two weeks" from today, then tell them they won't get another call about purchases there until then. If they aren't traveling, just thank them for confirming.

${GOODBYE}`;
    super(bank, instructions, []);
    this._toolCtx = new llm.ToolContext([...this.commonTools(), ...this.fraudTools()]);
  }

  async verifyIdentity(args: { fullName: string; dateOfBirth: string }): Promise<string> {
    try {
      if (!args.fullName.trim()) throw new BankError("Ask who you're speaking with first.");
      birthDate(args.dateOfBirth, todayInBankTimezone());
      await this.bank.confirmCardholder(args.fullName.trim());
      return JSON.stringify({ verified: true, flagged_purchase: charge(this.bank.alert!) });
    } catch (error) {
      return asToolError(error);
    }
  }

  private fraudTools(): llm.ToolContextEntry<Bank>[] {
    return [
      llm.tool({
        name: 'verify_identity',
        description:
          'Confirm the person on the phone is the cardholder. Returns the flagged purchase once they are confirmed.',
        parameters: z.object({
          fullName: z.string().describe('The name they gave.'),
          dateOfBirth: z.string().describe('The date of birth they gave, YYYY-MM-DD.'),
        }),
        execute: (args) => this.verifyIdentity(args),
      }),
    ];
  }
}

function charge(alert: Alert): Record<string, string> {
  return {
    merchant: alert.purchase.merchant,
    where: alert.purchase.place,
    amount: `$${alert.purchase.amount}`,
  };
}

export function todayInBankTimezone(now = new Date()): DateOnly {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BANK_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}` as DateOnly;
}

function dateAtNoonUtc(date: DateOnly): Date {
  return new Date(`${date}T12:00:00Z`);
}

function formatFullDate(date: DateOnly): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(dateAtNoonUtc(date));
}

function formatWeekdayMonthDay(date: DateOnly): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(dateAtNoonUtc(date));
}

function sampleCaller(bankLine: string): string {
  const born = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(dateAtNoonUtc(SAMPLE_BIRTH_DATE));
  return `${bankLine} Nothing on the call is real. The caller's details, the only ones to use:
- Full name: ${SAMPLE_NAME}
- Date of birth: ${born}
- Card ending in: ${spoken(VERIFIED_CARD).replaceAll('-', ' ')}`;
}

export function outboundCallerScript(bank: Bank): string | null {
  const alert = bank.alert;
  if (alert === null) return null;
  const back = addDays(todayInBankTimezone(), 14);
  const onFile = sampleCaller(`Avery called the caller for a demo of ${BANK_NAME}'s fraud alerts.`);
  const trip = `They are on vacation in ${alert.purchase.country} for two weeks, back on ${formatWeekdayMonthDay(back)}, and the flagged purchase at ${alert.purchase.merchant} in ${alert.purchase.place} was theirs.`;
  let stage: string;
  if (bank.card.travel !== null || bank.card.state === 'locked') {
    stage =
      "Everything's sorted. When Avery asks if there's anything else, say that's all, thanks, and goodbye.";
  } else if (alert.madeByCardholder) {
    stage = `When Avery asks if they're traveling, say they're on vacation in ${alert.purchase.country} for two weeks.`;
  } else if (bank.verified) {
    stage = 'When Avery describes the purchase, say yes, that was them.';
  } else {
    stage =
      "They haven't been verified yet. Give their name when Avery asks who she's speaking with, and the date of birth when she asks for it.";
  }
  return `${onFile}\n${trip}\n${stage}`;
}

export function callerScript(bank: Bank): string {
  const onFile = sampleCaller(
    `The caller is trying out Avery's demo of ${BANK_NAME} card services.`,
  );
  const alert = bank.alert;
  let stage: string;
  if (bank.lockedOut)
    stage = "Avery can't verify them on this call. Say okay, thanks, and goodbye.";
  else if (bank.card.state === 'locked' || bank.card.travel !== null)
    stage =
      "That's sorted. When Avery asks if there's anything else, say that's all, thanks, and goodbye.";
  else if (alert !== null && alert.madeByCardholder === null)
    stage = "When Avery describes the charge, say that's the one, and they didn't make it.";
  else if (bank.verified)
    stage =
      "They're verified. Answer what Avery asks. When she asks if there's anything else, say that's all, thanks, and goodbye.";
  else if (bank.attempts.some((attempt) => !attempt.authenticated))
    stage = `The last check didn't go through. If Avery offers to try again, say yes. When she asks for the details again, give all three in one line, with the card ending in ${spoken(VERIFIED_CARD).replaceAll('-', ' ')}.`;
  else
    stage =
      "They're calling because there's a charge on their card they don't recognize: say so when Avery asks how she can help. Then give each detail as Avery asks for it.";
  return `${onFile}\n${stage}`;
}
