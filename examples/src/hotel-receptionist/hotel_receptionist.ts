// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  llm,
  voice,
} from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  FOLLOWUP_KINDS,
  GROUP_SHARE_TYPES,
  HotelDB,
  MAX_PARTY_SIZE,
  PRICING,
  ROOM_EXTRAS,
  ROOM_TYPES,
  type RoomBooking,
  TODAY,
  TOUR_IDS,
  Unavailable,
  formatUsd,
  normalizeCode,
  speakCode,
  speakTime,
  speakUsd,
} from './hotel_db.js';
import { buildLookupPolicyTool } from './policies.js';

type UserData = {
  db: HotelDB;
  verifiedBooking?: RoomBooking;
};

type CardResult = {
  cardholderName: string;
  issuer: string;
  cardNumber: string;
  securityCode: string;
  expirationDate: string;
};

const ISSUERS: Record<string, string> = {
  '3': 'American Express',
  '4': 'Visa',
  '5': 'Mastercard',
  '6': 'Discover',
};

const commonInstructions = `You're a receptionist at The LiveKit Hotel, a small boutique property with an on-site restaurant. Speak naturally, not from a customer-service script. Today is ${TODAY}. You're on a phone call with a guest.

# What you can help with
- Room bookings: check availability, book, modify, cancel, and replace the card on file after verification.
- Restaurant table reservations: check availability, book, look up, and cancel.
- Invoice lookup and charge disputes on existing bookings.
- Taking a privacy-safe message for a guest without confirming whether that guest is staying here.
- Wake-up calls, sightseeing tours, flight reconfirmation through concierge, and hotel cars to SFO.
- Group room blocks for 15 or more guests: record the inquiry; never confirm the block on this call.

# Quick facts
- Check-in is 3 PM, check-out is 11 AM. Late checkout until 2 PM is ${formatUsd(PRICING.lateCheckout)}, subject to availability.
- Pets are allowed in pet-friendly rooms only, ${formatUsd(PRICING.petFee)} per stay. Service animals are always welcome at no charge.
- Self-parking is free; valet is ${formatUsd(PRICING.valetPerNight)} per night.
- Wi-Fi is free. Pool, gym, and sauna are open 6 AM to 10 PM.
- Cancellation is free up to ${PRICING.cancellationWindowHours} hours before check-in; inside that window, one night is forfeited.
- Breakfast buffet is 6:30 to 10:30 AM and costs ${formatUsd(PRICING.breakfastPerNight)} per night as a room extra.
- The restaurant is dinner only, 5:30 to 9 PM last seating.

# Routing
- Emergency first: get the room number, call dispatchEmergency, then tell the caller to hang up and dial 911 themselves. Never give medical instructions.
- Caller wants a room: use checkRoomAvailability, then bookRoom only after the caller has agreed to the full read-back including total and card last four.
- Caller asks for group of 15 or more guests: lookupPolicy(topic="group_bookings"), then recordGroupInquiry; do not use individual booking.
- Card on file is not going through or replacement card is offered: verify with verifyBookingByCode or verifyBookingByCard, then call startCardUpdate on this call. Say the card "isn't going through at the moment, possibly a technical issue"; never say declined or rejected.
- Caller asks about another guest: never confirm or deny whether anyone is staying here, never give room numbers, never connect calls. Offer takeGuestMessage only.
- Detail beyond quick facts: call lookupPolicy before answering.

# Conversation style
- One sentence per reply, almost always. One question per turn.
- Plain prose only. No markdown or bullets out loud.
- Spell out money, dates, and confirmation codes naturally. Never read full card numbers or security codes back; last four only.
- Never invent or default a value the caller did not give. If a tool needs a missing value, ask before calling it.
- When a caller spells a name, email, or code, the spelled letters are the truth.
- Resolve relative dates against today and say the concrete date before acting.
- A booking, cancellation, refund, message, or followup is real only if the corresponding tool returned success in this turn.`;

function parseDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new llm.ToolError('date must be YYYY-MM-DD');
  return value;
}

function parseTime(value: string): string {
  const match = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!match) throw new llm.ToolError('time must be HH:MM in 24-hour time');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new llm.ToolError('time must be HH:MM in 24-hour time');
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function validateStay(checkIn: string, checkOut: string, guests: number) {
  if (checkOut <= checkIn) throw new llm.ToolError('check-out must be after check-in');
  const stayNights = Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000);
  if (stayNights > 30) throw new llm.ToolError('the max stay is 30 nights');
  if (checkIn < TODAY) throw new llm.ToolError("check-in can't be in the past");
  if (guests < 1 || guests > MAX_PARTY_SIZE)
    throw new llm.ToolError(`party size must be 1-${MAX_PARTY_SIZE}`);
}

function bookingSummary(db: HotelDB, booking: RoomBooking): string {
  const room = db.getRoom(booking.roomId);
  const extras = booking.extras.length ? booking.extras.join(', ') : 'no extras';
  return `${booking.firstName} ${booking.lastName}, ${room.type.replace('_', ' ')} ${room.view} view, ${booking.checkIn} to ${booking.checkOut}, ${booking.guests} guest${booking.guests === 1 ? '' : 's'}, extras: ${extras}, total ${speakUsd(booking.total)}, card ending ${booking.cardLast4}, code ${speakCode(booking.code)}.`;
}

function luhnOk(cardNumber: string): boolean {
  let total = 0;
  for (const [index, digit] of [...cardNumber].reverse().entries()) {
    let n = Number(digit);
    if (index % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    total += n;
  }
  return total % 10 === 0;
}

class GetCardTask extends voice.AgentTask<CardResult, UserData> {
  private cardNumber = '';
  private expiration = '';
  private securityCode = '';
  private firstName = '';
  private lastName = '';

  constructor() {
    super({
      instructions: `${commonInstructions}\n\nYou're collecting the caller's credit card: number, expiration date, security code, and the name on the card. Take details in whatever order the caller offers them, recording each with its tool. Never read the full card number or security code back; refer to the card by its last four digits only. If a value is rejected, ask for just that detail again. If the caller refuses to provide the card, call declineCardCapture.`,
      tools: [
        llm.tool({
          name: 'recordCardNumber',
          description: 'Record the complete card number after the caller gives all digits.',
          parameters: z.object({
            cardNumber: z.string().describe('All digits, no spaces or dashes.'),
          }),
          execute: async ({ cardNumber }) => {
            const digits = cardNumber.replace(/\D/g, '');
            if (digits.length < 13 || digits.length > 19)
              throw new llm.ToolError('that card number has the wrong number of digits');
            if (!luhnOk(digits))
              throw new llm.ToolError(
                'that number fails the card check; ask the caller to read it again slowly',
              );
            this.cardNumber = digits;
            return `card number recorded (ending ${digits.slice(-4)}) | ${this.status()}`;
          },
        }),
        llm.tool({
          name: 'recordExpiration',
          description: "Record the card's expiration date.",
          parameters: z.object({
            month: z.number().int().min(1).max(12),
            year: z.number().int().min(0).max(99),
          }),
          execute: async ({ month, year }) => {
            const today = new Date(`${TODAY}T00:00:00Z`);
            if (
              2000 + year < today.getUTCFullYear() ||
              (2000 + year === today.getUTCFullYear() && month < today.getUTCMonth() + 1)
            ) {
              throw new llm.ToolError('that date is in the past; ask for another card');
            }
            this.expiration = `${String(month).padStart(2, '0')}/${String(year).padStart(2, '0')}`;
            return `expiration recorded | ${this.status()}`;
          },
        }),
        llm.tool({
          name: 'recordSecurityCode',
          description: "Record the card's 3 or 4 digit security code.",
          parameters: z.object({ securityCode: z.string() }),
          execute: async ({ securityCode }) => {
            const code = securityCode.trim();
            if (!/^\d{3,4}$/.test(code))
              throw new llm.ToolError('the security code should be 3 or 4 digits');
            this.securityCode = code;
            return `security code recorded | ${this.status()}`;
          },
        }),
        llm.tool({
          name: 'recordCardholder',
          description: 'Record the name as it appears on the card.',
          parameters: z.object({ firstName: z.string(), lastName: z.string() }),
          execute: async ({ firstName, lastName }) => {
            if (!/[a-z]/i.test(firstName) || !/[a-z]/i.test(lastName))
              throw new llm.ToolError("that doesn't look like a cardholder name");
            this.firstName = firstName.trim();
            this.lastName = lastName.trim();
            return `cardholder recorded: ${this.firstName} ${this.lastName} | ${this.status()}`;
          },
        }),
        llm.tool({
          name: 'confirmCard',
          description:
            'Finalize card capture after the caller agrees to the last-four and expiration read-back.',
          execute: async () => {
            if (
              !(
                this.cardNumber &&
                this.expiration &&
                this.securityCode &&
                this.firstName &&
                this.lastName
              )
            )
              throw new llm.ToolError(this.status());
            const result = {
              cardholderName: `${this.firstName} ${this.lastName}`,
              issuer: ISSUERS[this.cardNumber[0]!] ?? 'Other',
              cardNumber: this.cardNumber,
              securityCode: this.securityCode,
              expirationDate: this.expiration,
            };
            this.complete(result);
            return `card confirmed ending ${this.cardNumber.slice(-4)}`;
          },
        }),
        llm.tool({
          name: 'declineCardCapture',
          description: 'Call when the caller explicitly refuses to provide card details.',
          parameters: z.object({ reason: z.string() }),
          execute: async ({ reason }) => {
            throw new llm.ToolError(`couldn't get card details: ${reason}`);
          },
        }),
      ],
    });
  }

  async onEnter() {
    await this.session.generateReply({
      instructions: 'Ask for the card number, unless the caller already gave it.',
    });
  }

  private status(): string {
    if (!this.cardNumber) return 'next: ask for the card number, then call recordCardNumber';
    if (!this.expiration) return 'next: ask for the expiration date, then call recordExpiration';
    if (!this.securityCode) return 'next: ask for the security code, then call recordSecurityCode';
    if (!(this.firstName && this.lastName))
      return 'next: confirm the name on the card, then call recordCardholder';
    return 'all card details captured - read back last four and expiration only, then call confirmCard once the caller agrees';
  }
}

class HotelReceptionistAgent extends voice.Agent<UserData> {
  constructor() {
    super({
      instructions: commonInstructions,
      tools: [
        buildLookupPolicyTool(),
        llm.tool({
          name: 'checkRoomAvailability',
          description: 'Check available room types and rates. This does not book anything.',
          parameters: z.object({
            checkIn: z.string().describe('Check-in date, YYYY-MM-DD'),
            checkOut: z.string().describe('Check-out date, YYYY-MM-DD'),
            guests: z.number().int().min(1).max(MAX_PARTY_SIZE),
            smokingRoom: z.boolean().optional(),
          }),
          execute: async (
            { checkIn, checkOut, guests, smokingRoom },
            { ctx }: llm.ToolOptions<UserData>,
          ) => {
            checkIn = parseDate(checkIn);
            checkOut = parseDate(checkOut);
            validateStay(checkIn, checkOut, guests);
            const availability = ctx.userData.db.listRoomTypesAvailable({
              checkIn,
              checkOut,
              guests,
              smoking: smokingRoom,
            });
            if (!availability.length)
              return 'sold out for those dates; offer adjacent dates or another party configuration';
            return availability
              .map(
                (item) =>
                  `${item.type.replace('_', ' ')}: ${speakUsd(item.nightlyRate)} per night, ${item.views.join(' or ')} view`,
              )
              .join('\n');
          },
        }),
        llm.tool({
          name: 'bookRoom',
          description:
            'Create a room booking after the caller has agreed to a read-back including dates, room, total, and card last four.',
          parameters: z.object({
            roomType: z.enum(ROOM_TYPES),
            smokingRoom: z.boolean().default(false),
            guests: z.number().int().min(1).max(MAX_PARTY_SIZE),
            checkIn: z.string(),
            checkOut: z.string(),
            firstName: z.string(),
            lastName: z.string(),
            email: z.string(),
            phone: z.string(),
            cardNumber: z
              .string()
              .describe('Full card number from the caller; only the last four are stored.'),
            extras: z.array(z.enum(ROOM_EXTRAS)).default([]),
            view: z.string().optional(),
          }),
          execute: async (args, { ctx }: llm.ToolOptions<UserData>) => {
            const checkIn = parseDate(args.checkIn);
            const checkOut = parseDate(args.checkOut);
            validateStay(checkIn, checkOut, args.guests);
            const cardDigits = args.cardNumber.replace(/\D/g, '');
            if (!luhnOk(cardDigits))
              throw new llm.ToolError(
                'card number failed validation; ask the caller to repeat it slowly',
              );
            try {
              const booking = ctx.userData.db.bookRoom({
                ...args,
                checkIn,
                checkOut,
                smoking: args.smokingRoom,
                cardLast4: cardDigits.slice(-4),
              });
              return `room booked: ${bookingSummary(ctx.userData.db, booking)}`;
            } catch (error) {
              if (error instanceof Unavailable)
                throw new llm.ToolError(`${error.message}; pick another room or dates`);
              throw error;
            }
          },
        }),
        llm.tool({
          name: 'verifyBookingByCode',
          description: 'Verify a confirmed booking by last name and confirmation code.',
          parameters: z.object({ lastName: z.string(), code: z.string() }),
          execute: async ({ lastName, code }, { ctx }: llm.ToolOptions<UserData>) => {
            const booking = ctx.userData.db.findBooking({ lastName, confirmationCode: code });
            if (!booking)
              throw new llm.ToolError(
                'no confirmed booking found via code; ask to repeat or use last four of card',
              );
            if (booking.status !== 'confirmed')
              throw new llm.ToolError('that booking is already cancelled');
            ctx.userData.verifiedBooking = booking;
            const warning = booking.doubleBooked
              ? ' WARNING: this booking has a room conflict; use resolveRoomConflict before reassuring the caller.'
              : '';
            return `verified: ${bookingSummary(ctx.userData.db, booking)}${warning}`;
          },
        }),
        llm.tool({
          name: 'verifyBookingByCard',
          description:
            'Verify a confirmed booking by last name and last four digits of the card on file.',
          parameters: z.object({ lastName: z.string(), cardLast4: z.string() }),
          execute: async ({ lastName, cardLast4 }, { ctx }: llm.ToolOptions<UserData>) => {
            const digits = cardLast4.replace(/\D/g, '');
            if (digits.length !== 4)
              throw new llm.ToolError('the last four digits should be exactly four digits');
            const booking = ctx.userData.db.findBooking({ lastName, cardLast4: digits });
            if (!booking)
              throw new llm.ToolError(
                'no confirmed booking found via card; ask to repeat or use confirmation code',
              );
            if (booking.status !== 'confirmed')
              throw new llm.ToolError('that booking is already cancelled');
            ctx.userData.verifiedBooking = booking;
            const warning = booking.doubleBooked
              ? ' WARNING: this booking has a room conflict; use resolveRoomConflict before reassuring the caller.'
              : '';
            return `verified: ${bookingSummary(ctx.userData.db, booking)}${warning}`;
          },
        }),
        llm.tool({
          name: 'startCardUpdate',
          description:
            'After booking verification, collect a replacement card and update the card on file.',
          execute: async (_, { ctx }: llm.ToolOptions<UserData>) => {
            const booking = this.verifiedBooking(ctx);
            const card = await new GetCardTask().run();
            ctx.userData.db.updateBookingCard({
              bookingCode: booking.code,
              cardLast4: card.cardNumber.slice(-4),
            });
            return `card updated on booking ${speakCode(booking.code)} to ${card.issuer} ending ${card.cardNumber.slice(-4)}.`;
          },
        }),
        llm.tool({
          name: 'modifyRoomBooking',
          description:
            'After verification, modify dates, party size, room type, smoking preference, or extras on a room booking.',
          parameters: z.object({
            checkIn: z.string(),
            checkOut: z.string(),
            guests: z.number().int().min(1).max(MAX_PARTY_SIZE),
            roomType: z.enum(ROOM_TYPES),
            smokingRoom: z.boolean().default(false),
            extras: z.array(z.enum(ROOM_EXTRAS)).default([]),
          }),
          execute: async (args, { ctx }: llm.ToolOptions<UserData>) => {
            const booking = this.verifiedBooking(ctx);
            const checkIn = parseDate(args.checkIn);
            const checkOut = parseDate(args.checkOut);
            validateStay(checkIn, checkOut, args.guests);
            try {
              const updated = ctx.userData.db.updateBooking({
                ...args,
                bookingCode: booking.code,
                checkIn,
                checkOut,
                smoking: args.smokingRoom,
              });
              ctx.userData.verifiedBooking = updated;
              return `booking updated: ${bookingSummary(ctx.userData.db, updated)}`;
            } catch (error) {
              if (error instanceof Unavailable)
                throw new llm.ToolError(`${error.message}; offer another room or dates`);
              throw error;
            }
          },
        }),
        llm.tool({
          name: 'cancelRoomBooking',
          description: 'After verification, cancel the room booking and return the refund outcome.',
          execute: async (_, { ctx }: llm.ToolOptions<UserData>) => {
            const booking = this.verifiedBooking(ctx);
            const refund = ctx.userData.db.cancelRoomBooking(booking.code);
            ctx.userData.verifiedBooking = undefined;
            return `booking ${speakCode(booking.code)} cancelled; refund amount ${speakUsd(refund)}.`;
          },
        }),
        llm.tool({
          name: 'flagLateArrival',
          description: 'After verification, add a late-arrival note to a confirmed booking.',
          parameters: z.object({ note: z.string() }),
          execute: async ({ note }, { ctx }: llm.ToolOptions<UserData>) => {
            const booking = this.verifiedBooking(ctx);
            ctx.userData.db.flagLateArrival({ bookingCode: booking.code, note });
            return `noted on the booking - we'll hold the room. See you at ${note}.`;
          },
        }),
        llm.tool({
          name: 'lookupInvoice',
          description: 'After verification, return the itemized invoice for the loaded booking.',
          execute: async (_, { ctx }: llm.ToolOptions<UserData>) => {
            const booking = this.verifiedBooking(ctx);
            const invoice = ctx.userData.db.getInvoice(booking.code);
            const lines = invoice.lineItems
              .map((item) => `${item.label}: ${formatUsd(item.amountCents)}`)
              .join('\n');
            return `${lines}\nTotal: ${formatUsd(invoice.total)}`;
          },
        }),
        llm.tool({
          name: 'disputeCharge',
          description:
            'Record the outcome for an invoice charge dispute after verification and invoice lookup.',
          parameters: z.object({
            category: z.enum([
              'minibar',
              'room_service_restaurant',
              'damage_cleaning',
              'late_checkout_fee',
              'cancellation_fee',
              'double_charge_billing_error',
              'other',
            ]),
            acceptedGoodwillResolution: z.boolean().default(false),
          }),
          execute: async ({ category, acceptedGoodwillResolution }) => {
            if (category === 'late_checkout_fee' && acceptedGoodwillResolution)
              return `goodwill waiver applied for ${speakUsd(PRICING.lateCheckout)}; confirm the updated folio will be emailed.`;
            if (category === 'double_charge_billing_error')
              return 'duplicate charge will be corrected immediately if visible; otherwise accounting opens a ticket and emails within two business days.';
            return 'dispute recorded for manager review; explain the relevant policy and offer followup without promising an unauthorized refund.';
          },
        }),
        llm.tool({
          name: 'checkRestaurantAvailability',
          description: 'Check restaurant availability. This does not reserve a table.',
          parameters: z.object({
            date: z.string(),
            partySize: z.number().int().min(1).max(MAX_PARTY_SIZE),
          }),
          execute: async ({ date, partySize }, { ctx }: llm.ToolOptions<UserData>) => {
            date = parseDate(date);
            if (date < TODAY) throw new llm.ToolError("the date can't be in the past");
            const slots = ctx.userData.db
              .listRestaurantAvailability({ date, partySize })
              .filter((slot) => slot.availableTableIds.length > 0);
            return slots.length
              ? slots.map((slot) => speakTime(slot.time)).join(', ')
              : 'fully booked for that party size; ask for another date';
          },
        }),
        llm.tool({
          name: 'bookRestaurant',
          description: 'Reserve a restaurant table after the caller agrees to the read-back.',
          parameters: z.object({
            firstName: z.string(),
            lastName: z.string(),
            phone: z.string(),
            partySize: z.number().int().min(1).max(MAX_PARTY_SIZE),
            date: z.string(),
            time: z.string(),
            notes: z.string().optional(),
          }),
          execute: async (args, { ctx }: llm.ToolOptions<UserData>) => {
            try {
              const reservation = ctx.userData.db.bookRestaurant({
                ...args,
                date: parseDate(args.date),
                time: parseTime(args.time),
              });
              return `restaurant reservation confirmed for ${reservation.firstName} ${reservation.lastName}, ${reservation.partySize} at ${speakTime(reservation.time)}, code ${speakCode(reservation.code)}.`;
            } catch (error) {
              if (error instanceof Unavailable)
                throw new llm.ToolError('that table time just filled; offer another time');
              throw error;
            }
          },
        }),
        llm.tool({
          name: 'lookupRestaurantReservation',
          description:
            'Look up a restaurant reservation by last name plus reservation code or date.',
          parameters: z.object({
            lastName: z.string(),
            code: z.string().optional(),
            date: z.string().optional(),
          }),
          execute: async ({ lastName, code, date }, { ctx }: llm.ToolOptions<UserData>) => {
            const reservation = ctx.userData.db.findRestaurantReservation({
              lastName,
              confirmationCode: code,
              date: date ? parseDate(date) : undefined,
            });
            if (!reservation)
              throw new llm.ToolError(
                'no restaurant reservation found; ask for the code or date again',
              );
            return `${reservation.firstName} ${reservation.lastName}, ${reservation.partySize} guests, ${reservation.date} at ${speakTime(reservation.time)}, status ${reservation.status}, code ${speakCode(reservation.code)}.`;
          },
        }),
        llm.tool({
          name: 'cancelRestaurantReservation',
          description:
            'Cancel a restaurant reservation by reservation code after confirming caller intent.',
          parameters: z.object({ code: z.string() }),
          execute: async ({ code }, { ctx }: llm.ToolOptions<UserData>) => {
            ctx.userData.db.cancelRestaurantReservation(code);
            return `restaurant reservation ${speakCode(normalizeCode(code))} cancelled.`;
          },
        }),
        llm.tool({
          name: 'recordFollowup',
          description:
            'Record a request for a human followup. Always use this instead of only saying someone will follow up.',
          parameters: z.object({
            kind: z.enum(FOLLOWUP_KINDS),
            callerName: z.string(),
            callerPhone: z.string(),
            summary: z.string(),
          }),
          execute: async (args, { ctx }: llm.ToolOptions<UserData>) => {
            const code = ctx.userData.db.recordFollowup(args);
            return `recorded; reference ${speakCode(code)}. The right team will follow up.`;
          },
        }),
        llm.tool({
          name: 'recordGroupInquiry',
          description:
            'Open a room-block inquiry for 15 or more guests. This does not confirm or hold rooms.',
          parameters: z.object({
            company: z.string(),
            contactName: z.string(),
            contactPhone: z.string(),
            partySize: z.number().int().min(15),
            shareType: z.enum(GROUP_SHARE_TYPES),
            checkIn: z.string(),
            nights: z.number().int().min(1),
          }),
          execute: async (args, { ctx }: llm.ToolOptions<UserData>) => {
            const code = ctx.userData.db.recordGroupInquiry({
              ...args,
              checkIn: parseDate(args.checkIn),
            });
            return `group inquiry recorded; reference ${speakCode(code)}. Nothing is confirmed yet; the group desk will call back within two business days after credit review.`;
          },
        }),
        llm.tool({
          name: 'scheduleWakeupCall',
          description:
            'Schedule a wake-up call to a guest room. Do not record wake-up calls as generic followups.',
          parameters: z.object({
            room: z.string(),
            guestName: z.string(),
            date: z.string(),
            time: z.string(),
          }),
          execute: async (args, { ctx }: llm.ToolOptions<UserData>) => {
            const code = ctx.userData.db.scheduleWakeupCall({
              ...args,
              date: parseDate(args.date),
              time: parseTime(args.time),
            });
            return `wake-up call set for room ${args.room}, ${args.date} at ${speakTime(args.time)}; reference ${speakCode(code)}. If they worry about sleeping through, explain the second call and in-person room check.`;
          },
        }),
        llm.tool({
          name: 'dispatchEmergency',
          description:
            'Dispatch hotel manager and staff to an emergency. Then direct the caller to hang up and dial 911 themselves.',
          parameters: z.object({ room: z.string(), situation: z.string() }),
          execute: async (args, { ctx }: llm.ToolOptions<UserData>) => {
            const code = ctx.userData.db.dispatchEmergency(args);
            return `emergency dispatch logged for room ${args.room}; reference ${speakCode(code)}. Tell the caller hotel help is on the way and to hang up and call 911 now.`;
          },
        }),
        llm.tool({
          name: 'takeGuestMessage',
          description:
            'Take a privacy-safe message for a guest without confirming or denying that the recipient is staying here.',
          parameters: z.object({
            recipient: z.string(),
            callerName: z.string(),
            callerPhone: z.string(),
            message: z.string(),
          }),
          execute: async (args, { ctx }: llm.ToolOptions<UserData>) => {
            const code = ctx.userData.db.takeGuestMessage(args);
            return `message logged; reference ${speakCode(code)}. Say it will be passed along if we can, without confirming whether ${args.recipient} is staying here.`;
          },
        }),
        llm.tool({
          name: 'bookTour',
          description: 'Book a sightseeing tour after narrowing tour type, date, and party size.',
          parameters: z.object({
            tourId: z.enum(TOUR_IDS),
            guestName: z.string(),
            guestPhone: z.string(),
            date: z.string(),
            partySize: z.number().int().min(1),
          }),
          execute: async (args, { ctx }: llm.ToolOptions<UserData>) => {
            const result = ctx.userData.db.bookTour({ ...args, date: parseDate(args.date) });
            return `tour booked; reference ${speakCode(result.code)}, pickup ${speakTime(result.pickupTime)} in the hotel lobby, total ${speakUsd(result.total)}.`;
          },
        }),
        llm.tool({
          name: 'requestFlightReconfirmation',
          description:
            'Log a concierge request to reconfirm a flight. Never claim the flight is already confirmed.',
          parameters: z.object({
            room: z.string(),
            airline: z.string(),
            flightNumber: z.string(),
            flightDate: z.string(),
            bookingReference: z.string(),
            seatCheck: z.boolean().default(false),
          }),
          execute: async (args, { ctx }: llm.ToolOptions<UserData>) => {
            const code = ctx.userData.db.requestFlightReconfirmation({
              ...args,
              flightDate: parseDate(args.flightDate),
            });
            return `flight reconfirmation request logged; reference ${speakCode(code)}. Concierge will call the carrier and ring the room with the result.`;
          },
        }),
        llm.tool({
          name: 'bookAirportCar',
          description:
            'Book the hotel car to SFO. The flat price is 85 dollars and it seats up to four guests with luggage.',
          parameters: z.object({
            room: z.string(),
            pickupDate: z.string(),
            pickupTime: z.string(),
            passengers: z.number().int().min(1).max(4),
          }),
          execute: async (args, { ctx }: llm.ToolOptions<UserData>) => {
            const code = ctx.userData.db.bookAirportCar({
              ...args,
              pickupDate: parseDate(args.pickupDate),
              pickupTime: parseTime(args.pickupTime),
            });
            return `hotel car booked; reference ${speakCode(code)}, pickup ${args.pickupDate} at ${speakTime(args.pickupTime)} from the front entrance, flat fare ${speakUsd(8500)}.`;
          },
        }),
        llm.tool({
          name: 'resolveRoomConflict',
          description:
            'After verifying a double-booked room, resolve it by free in-house move/upgrade first or walking the guest if no room fits.',
          execute: async (_, { ctx }: llm.ToolOptions<UserData>) => {
            const booking = this.verifiedBooking(ctx);
            const result = ctx.userData.db.resolveRoomConflict(booking.code);
            if ('movedTo' in result) {
              const upgrade = result.upgraded ? 'free upgrade' : 'free move';
              return `${upgrade} confirmed to ${result.movedToType.replace('_', ' ')} with ${result.movedToView} view, room ${result.movedTo}; total unchanged.`;
            }
            return `walk arrangement made at ${result.walkPartner}; hotel pays the room and taxi at no extra cost to the guest, and their room here is guaranteed from ${result.walkReturnDate}.`;
          },
        }),
      ],
    });
  }

  async onEnter() {
    await this.session.generateReply({
      instructions:
        "Greet the caller in one short sentence. If they've already named a need, move straight into helping; otherwise ask how you can help.",
    });
  }

  private verifiedBooking(ctx: voice.RunContext<UserData>): RoomBooking {
    const booking = ctx.userData.verifiedBooking;
    if (!booking || booking.status !== 'confirmed')
      throw new llm.ToolError('verify the booking first by code or card');
    return booking;
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const userData: UserData = { db: new HotelDB() };
    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad! as silero.VAD,
      stt: new inference.STT({ model: 'deepgram/nova-3' }),
      llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
      tts: new inference.TTS({ model: 'cartesia/sonic-3' }),
      userData,
      maxToolSteps: 8,
    });

    await session.start({
      agent: new HotelReceptionistAgent(),
      room: ctx.room,
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
