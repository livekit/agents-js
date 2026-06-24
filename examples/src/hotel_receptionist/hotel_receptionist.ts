// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  ServerOptions,
  cli,
  dedent,
  defineAgent,
  inference,
  llm,
  voice,
} from '@livekit/agents';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));

const pricing = {
  breakfastPerNight: 2500,
  valetPerNight: 3500,
  lateCheckout: 4000,
  petFee: 5000,
  smokingCleaningFee: 25000,
  taxRatePct: 12,
  cancellationWindowHours: 48,
  minibarAutoRefundThreshold: 2000,
};

const maxPartySize = 6;
const today = process.env.HOTEL_TODAY ? parseDate(process.env.HOTEL_TODAY) : startOfDay(new Date());

type RoomType = 'king' | 'queen_2beds' | 'double_queen' | 'suite' | 'penthouse';
type RoomExtra = 'breakfast' | 'valet' | 'late_checkout' | 'pets';
type BookingStatus = 'confirmed' | 'cancelled';

type Room = {
  id: string;
  type: RoomType;
  nightlyRate: number;
  maxOccupancy: number;
  smoking: boolean;
  petsAllowed: boolean;
  view: string;
};

type Booking = {
  code: string;
  roomId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  checkIn: Date;
  checkOut: Date;
  guests: number;
  extras: RoomExtra[];
  total: number;
  cardLast4: string;
  status: BookingStatus;
  lateArrivalNote?: string;
};

type RestaurantReservation = {
  code: string;
  firstName: string;
  lastName: string;
  phone: string;
  partySize: number;
  date: Date;
  time: string;
  notes?: string;
  status: BookingStatus;
};

type UserData = {
  db: HotelDb;
  transferredTo: Set<string>;
  verifiedBooking?: Booking;
};

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function parseDate(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) {
    throw new Error(`invalid date ${value}`);
  }
  return new Date(year, month - 1, day);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function formatDate(date: Date) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(date);
}

function speakUsd(cents: number) {
  const dollars = Math.trunc(Math.abs(cents) / 100);
  const change = Math.abs(cents) % 100;
  return change === 0 ? `${dollars} dollars` : `${dollars} dollars and ${change} cents`;
}

function speakCode(code: string) {
  return code
    .toUpperCase()
    .split('')
    .map((char) => (char === '-' ? 'dash' : char))
    .join(', ');
}

function nights(checkIn: Date, checkOut: Date) {
  return Math.round((checkOut.getTime() - checkIn.getTime()) / 86_400_000);
}

function extrasTotal(extras: RoomExtra[], stayNights: number) {
  let total = 0;
  if (extras.includes('breakfast')) total += pricing.breakfastPerNight * stayNights;
  if (extras.includes('valet')) total += pricing.valetPerNight * stayNights;
  if (extras.includes('late_checkout')) total += pricing.lateCheckout;
  if (extras.includes('pets')) total += pricing.petFee;
  return total;
}

function computeTotal(room: Room, checkIn: Date, checkOut: Date, extras: RoomExtra[]) {
  const stayNights = nights(checkIn, checkOut);
  const subtotal = room.nightlyRate * stayNights + extrasTotal(extras, stayNights);
  return subtotal + Math.trunc((subtotal * pricing.taxRatePct) / 100);
}

class HotelDb {
  rooms: Room[] = [
    ['RM_201', 'king', 24000, 2, false, false, 'city'],
    ['RM_202', 'king', 26000, 2, false, true, 'ocean'],
    ['RM_203', 'king', 24000, 2, true, false, 'city'],
    ['RM_204', 'queen_2beds', 22000, 4, false, false, 'city'],
    ['RM_205', 'queen_2beds', 22000, 4, false, true, 'garden'],
    ['RM_206', 'double_queen', 26000, 4, false, false, 'ocean'],
    ['RM_301', 'king', 28000, 2, false, false, 'ocean'],
    ['RM_302', 'king', 28000, 2, false, false, 'ocean'],
    ['RM_303', 'queen_2beds', 24000, 4, false, false, 'city'],
    ['RM_304', 'double_queen', 28000, 4, false, true, 'ocean'],
    ['RM_401', 'suite', 48000, 4, false, true, 'ocean'],
    ['RM_402', 'suite', 52000, 4, false, false, 'ocean'],
    ['RM_PH', 'penthouse', 120000, 6, false, true, 'ocean'],
  ].map(([id, type, nightlyRate, maxOccupancy, smoking, petsAllowed, view]) => ({
    id: id as string,
    type: type as RoomType,
    nightlyRate: nightlyRate as number,
    maxOccupancy: maxOccupancy as number,
    smoking: smoking as boolean,
    petsAllowed: petsAllowed as boolean,
    view: view as string,
  }));

  bookings: Booking[] = [];
  restaurantReservations: RestaurantReservation[] = [];
  followups: string[] = [];
  messages: string[] = [];
  dndRooms = new Set<string>();

  constructor() {
    const seedBookings: Array<
      [
        string,
        string,
        string,
        string,
        string,
        string,
        number,
        number,
        number,
        RoomExtra[],
        string,
        BookingStatus,
      ]
    > = [
      [
        'Sofia',
        'Garcia',
        'sofia.garcia@proton.me',
        '+1 415 555 0107',
        'EF56',
        '401',
        -1,
        4,
        3,
        ['breakfast', 'valet', 'pets'],
        '0007',
        'confirmed',
      ],
      [
        'Priya',
        'Nair',
        'priya.nair@gmail.com',
        '+1 510 555 0188',
        'KM21',
        '202',
        -2,
        4,
        2,
        ['breakfast'],
        '3310',
        'confirmed',
      ],
      [
        'Amara',
        'Okafor',
        'amara.okafor@gmail.com',
        '+1 650 555 0121',
        'WX53',
        '206',
        -1,
        2,
        4,
        ['breakfast', 'pets'],
        '5550',
        'confirmed',
      ],
      [
        'Dana',
        'Holt',
        'dana.holt@gmail.com',
        '+1 415 555 0341',
        'DH27',
        '301',
        -2,
        3,
        2,
        [],
        '9034',
        'confirmed',
      ],
      [
        'Kenji',
        'Tanaka',
        'kenji.tanaka@gmail.com',
        '+1 415 555 0164',
        'RT88',
        '301',
        0,
        3,
        2,
        ['valet'],
        '7782',
        'confirmed',
      ],
      [
        'Robert',
        'Klein',
        'robert.klein@gmail.com',
        '+1 415 555 0377',
        'RK20',
        '201',
        0,
        2,
        1,
        [],
        '8412',
        'confirmed',
      ],
      [
        'Eleanor',
        'Smith',
        'eleanor.smith@gmail.com',
        '+1 415 555 0142',
        'AB12',
        '203',
        5,
        2,
        2,
        ['breakfast'],
        '4242',
        'confirmed',
      ],
      [
        'Marcus',
        'Johnson',
        'm.johnson@outlook.com',
        '+1 628 555 0199',
        'CD34',
        '205',
        9,
        3,
        4,
        ['breakfast', 'valet'],
        '1881',
        'confirmed',
      ],
      [
        'Mei',
        'Chen',
        'mei.chen@gmail.com',
        '+1 415 555 0222',
        'MN42',
        '203',
        14,
        2,
        2,
        ['breakfast'],
        '4477',
        'confirmed',
      ],
      [
        'Daniel',
        'Lee',
        'daniel.lee@gmail.com',
        '+1 415 555 0104',
        'GH78',
        '302',
        -6,
        2,
        2,
        ['late_checkout'],
        '9999',
        'confirmed',
      ],
      [
        'Tanya',
        'Richardson',
        'tanya.richardson@gmail.com',
        '+1 248 555 0291',
        'NS44',
        '304',
        -4,
        2,
        1,
        [],
        '7321',
        'confirmed',
      ],
      [
        'Felix',
        'Wagner',
        'felix.wagner@me.com',
        '+1 415 555 0312',
        'FW77',
        '402',
        3,
        2,
        2,
        ['breakfast', 'valet'],
        '2299',
        'cancelled',
      ],
    ];

    for (const [
      firstName,
      lastName,
      email,
      phone,
      suffix,
      roomNo,
      offset,
      stayNights,
      guests,
      extras,
      cardLast4,
      status,
    ] of seedBookings) {
      const room = this.roomByNumber(roomNo);
      const checkIn = addDays(today, offset);
      const checkOut = addDays(checkIn, stayNights);
      this.bookings.push({
        code: `HTL-${suffix}`,
        roomId: room.id,
        firstName,
        lastName,
        email,
        phone,
        checkIn,
        checkOut,
        guests,
        extras,
        total: computeTotal(room, checkIn, checkOut, extras),
        cardLast4,
        status,
      });
    }

    this.restaurantReservations = [
      ['Marcus', 'Bennett', '+1 415 555 0231', 4, 0, '19:00', 'JK90', 'Birthday', 'confirmed'],
      ['Hannah', 'Kowalski', '+1 415 555 0244', 2, 0, '20:30', 'LM12', 'Anniversary', 'confirmed'],
      ['Yuki', 'Sato', '+1 415 555 0277', 2, 1, '20:00', 'ST56', undefined, 'confirmed'],
      ['Chen', 'Wei', '+1 415 555 0344', 4, 1, '20:00', 'CW10', undefined, 'cancelled'],
    ].map(([firstName, lastName, phone, partySize, offset, time, suffix, notes, status]) => ({
      code: `RES-${suffix}`,
      firstName: firstName as string,
      lastName: lastName as string,
      phone: phone as string,
      partySize: partySize as number,
      date: addDays(today, offset as number),
      time: time as string,
      notes: notes as string | undefined,
      status: status as BookingStatus,
    }));
  }

  roomByNumber(roomNo: string) {
    const normalized = roomNo.toUpperCase().startsWith('RM_')
      ? roomNo.toUpperCase()
      : `RM_${roomNo.toUpperCase()}`;
    const room = this.rooms.find((candidate) => candidate.id === normalized);
    if (!room) throw new llm.ToolError(`no room ${roomNo} exists`);
    return room;
  }

  lookupBooking(lastName: string, confirmationCode?: string, cardLast4?: string) {
    const code = confirmationCode?.replaceAll(' ', '').toUpperCase();
    const booking = this.bookings.find(
      (candidate) =>
        candidate.lastName.toLowerCase() === lastName.toLowerCase() &&
        ((code && candidate.code === code) || (cardLast4 && candidate.cardLast4 === cardLast4)),
    );
    if (!booking) throw new llm.ToolError('could not find a matching booking');
    return booking;
  }

  availableRooms(checkIn: Date, checkOut: Date, guests: number, smoking?: boolean) {
    return this.rooms.filter((room) => {
      if (room.maxOccupancy < guests) return false;
      if (smoking !== undefined && room.smoking !== smoking) return false;
      return !this.bookings.some(
        (booking) =>
          booking.status === 'confirmed' &&
          booking.roomId === room.id &&
          booking.checkIn < checkOut &&
          checkIn < booking.checkOut,
      );
    });
  }
}

function loadPolicies() {
  const dir = join(__dirname, 'policies');
  const policies = new Map<string, string>();
  const index: string[] = [];
  for (const name of readdirSync(dir)
    .filter((entry) => entry.endsWith('.md'))
    .sort()) {
    const topic = name.slice(0, -3);
    const text = readFileSync(join(dir, name), 'utf8');
    const [description = '', ...body] = text.split('\n');
    policies.set(topic, body.join('\n').trim());
    index.push(`- ${topic}: ${description.trim()}`);
  }
  return { policies, index: index.join('\n') };
}

const { policies, index: policyIndex } = loadPolicies();

function buildInstructions() {
  return dedent`
    You're a receptionist at The LiveKit Hotel, a small boutique property with an on-site restaurant. Speak naturally, keep replies short, and handle the whole call across room bookings, restaurant reservations, cancellations, invoices, charge disputes, concierge requests, messages, wake-up calls, and hotel policy questions. Today is ${formatDate(today)}.

    Quick facts: check-in is 3 PM, check-out is 11 AM, late checkout until 2 PM is ${speakUsd(pricing.lateCheckout)} subject to availability, pets are ${speakUsd(pricing.petFee)} per stay in pet-friendly rooms, valet is ${speakUsd(pricing.valetPerNight)} per night, breakfast is ${speakUsd(pricing.breakfastPerNight)} per night, cancellation is free up to ${pricing.cancellationWindowHours} hours before check-in, and tax is ${pricing.taxRatePct}%.

    Use tools for real work. A booking, cancellation, refund, message, wake-up call, transfer, or follow-up is only real after the matching tool returns. Look up policies before answering details beyond quick facts. Never reveal guest presence, room numbers, or private details to third-party callers; offer to take a message instead. Emergency reports come first: get the room, dispatch hotel staff with dispatch_emergency, then direct the caller to outside emergency services as appropriate.

    Ask one question per turn, never invent missing dates or counts, and surface tool results progressively instead of reading every detail. For existing bookings, tools verify by last name plus confirmation code or card last four; do not pre-gate verification in conversation.
  `;
}

function createTools() {
  return {
    lookup_policy: llm.tool({
      description: `Fetch the full hotel or restaurant policy text for one topic. Topics:\n${policyIndex}`,
      parameters: z.object({ topic: z.string().describe('The policy topic to fetch.') }),
      execute: async ({ topic }) => {
        const policy = policies.get(topic);
        if (!policy)
          throw new llm.ToolError(
            `unknown topic ${topic}; valid topics: ${[...policies.keys()].join(', ')}`,
          );
        return policy;
      },
    }),

    check_room_availability: llm.tool({
      description:
        'Check available room types, rates, and views for a date range. Read-only; it never books.',
      parameters: z.object({
        check_in: z.string().describe('Check-in date as YYYY-MM-DD.'),
        check_out: z.string().describe('Check-out date as YYYY-MM-DD.'),
        guests: z.number().int().min(1).max(maxPartySize),
        smoking: z.enum(['smoking', 'non_smoking', 'no_preference']),
        room_type: z.enum(['king', 'queen_2beds', 'double_queen', 'suite', 'penthouse', 'any']),
      }),
      execute: async (
        { check_in, check_out, guests, smoking, room_type },
        { ctx }: llm.ToolOptions<UserData>,
      ) => {
        const checkIn = parseDate(check_in);
        const checkOut = parseDate(check_out);
        if (checkOut <= checkIn) throw new llm.ToolError('check-out must be after check-in');
        const smokingFilter = smoking === 'no_preference' ? undefined : smoking === 'smoking';
        const rooms = ctx.userData.db
          .availableRooms(checkIn, checkOut, guests, smokingFilter)
          .filter((room) => room_type === 'any' || room.type === room_type);
        if (rooms.length === 0) return 'no rooms available for those dates';
        const byType = new Map<RoomType, Room[]>();
        for (const room of rooms) byType.set(room.type, [...(byType.get(room.type) ?? []), room]);
        return [...byType.entries()]
          .map(([type, matches]) => {
            const lowest = Math.min(...matches.map((room) => room.nightlyRate));
            const views = [...new Set(matches.map((room) => room.view))].join(' or ');
            return `${type.replaceAll('_', ' ')}: ${speakUsd(lowest)} per night, ${views} view`;
          })
          .join(' | ');
      },
    }),

    start_room_booking: llm.tool({
      description:
        'Create a room booking after the caller has provided stay dates, room type, identity, contact details, extras, and card last four.',
      parameters: z.object({
        check_in: z.string(),
        check_out: z.string(),
        guests: z.number().int().min(1).max(maxPartySize),
        room_type: z.enum(['king', 'queen_2beds', 'double_queen', 'suite', 'penthouse']),
        first_name: z.string(),
        last_name: z.string(),
        email: z.string(),
        phone: z.string(),
        card_last4: z.string().min(4).max(4),
        extras: z.array(z.enum(['breakfast', 'valet', 'late_checkout', 'pets'])).default([]),
        smoking: z.enum(['smoking', 'non_smoking', 'no_preference']).default('no_preference'),
      }),
      execute: async (args, { ctx }: llm.ToolOptions<UserData>) => {
        const checkIn = parseDate(args.check_in);
        const checkOut = parseDate(args.check_out);
        const smokingFilter =
          args.smoking === 'no_preference' ? undefined : args.smoking === 'smoking';
        const room = ctx.userData.db
          .availableRooms(checkIn, checkOut, args.guests, smokingFilter)
          .find((candidate) => candidate.type === args.room_type);
        if (!room) throw new llm.ToolError('no matching room is available for those dates');
        const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
        const booking: Booking = {
          code: `HTL-${suffix}`,
          roomId: room.id,
          firstName: args.first_name,
          lastName: args.last_name,
          email: args.email,
          phone: args.phone,
          checkIn,
          checkOut,
          guests: args.guests,
          extras: args.extras,
          total: computeTotal(room, checkIn, checkOut, args.extras),
          cardLast4: args.card_last4,
          status: 'confirmed',
        };
        ctx.userData.db.bookings.push(booking);
        return `You're booked. Confirmation ${speakCode(booking.code)}. Total ${speakUsd(booking.total)}, charged to the card ending ${booking.cardLast4}. A confirmation email is going to ${booking.email}.`;
      },
    }),

    lookup_booking: llm.tool({
      description:
        'Look up an existing room booking by last name plus confirmation code or card last four.',
      parameters: z.object({
        last_name: z.string(),
        confirmation_code: z.string().optional(),
        card_last4: z.string().optional(),
      }),
      execute: async (
        { last_name, confirmation_code, card_last4 },
        { ctx }: llm.ToolOptions<UserData>,
      ) => {
        const booking = ctx.userData.db.lookupBooking(last_name, confirmation_code, card_last4);
        ctx.userData.verifiedBooking = booking;
        const room = ctx.userData.db.rooms.find((candidate) => candidate.id === booking.roomId)!;
        const conflict = ctx.userData.db.bookings.some(
          (other) =>
            other !== booking &&
            other.status === 'confirmed' &&
            other.roomId === booking.roomId &&
            other.checkIn < booking.checkOut &&
            booking.checkIn < other.checkOut,
        );
        return `${booking.status} booking for ${booking.firstName} ${booking.lastName}: ${room.type.replaceAll('_', ' ')} ${room.view} room, ${formatDate(booking.checkIn)} to ${formatDate(booking.checkOut)}, ${booking.guests} guests, total ${speakUsd(booking.total)}, card ending ${booking.cardLast4}${conflict ? ' | WARNING: this room is double-booked; call resolve_room_conflict.' : ''}`;
      },
    }),

    cancel_room_booking: llm.tool({
      description: 'Cancel a verified room booking and return the cancellation outcome.',
      parameters: z.object({
        last_name: z.string(),
        confirmation_code: z.string().optional(),
        card_last4: z.string().optional(),
      }),
      execute: async (
        { last_name, confirmation_code, card_last4 },
        { ctx }: llm.ToolOptions<UserData>,
      ) => {
        const booking = ctx.userData.db.lookupBooking(last_name, confirmation_code, card_last4);
        if (booking.status === 'cancelled')
          return `booking ${speakCode(booking.code)} was already cancelled`;
        booking.status = 'cancelled';
        return `booking ${speakCode(booking.code)} is cancelled; any eligible refund will return to the card ending ${booking.cardLast4}`;
      },
    }),

    start_booking_modification: llm.tool({
      description:
        'Modify dates, room type, guest count, or extras on an existing verified room booking.',
      parameters: z.object({
        last_name: z.string(),
        confirmation_code: z.string().optional(),
        card_last4: z.string().optional(),
        check_in: z.string().optional(),
        check_out: z.string().optional(),
        guests: z.number().int().min(1).max(maxPartySize).optional(),
        room_type: z.enum(['king', 'queen_2beds', 'double_queen', 'suite', 'penthouse']).optional(),
        extras: z.array(z.enum(['breakfast', 'valet', 'late_checkout', 'pets'])).optional(),
      }),
      execute: async (args, { ctx }: llm.ToolOptions<UserData>) => {
        const booking = ctx.userData.db.lookupBooking(
          args.last_name,
          args.confirmation_code,
          args.card_last4,
        );
        const checkIn = args.check_in ? parseDate(args.check_in) : booking.checkIn;
        const checkOut = args.check_out ? parseDate(args.check_out) : booking.checkOut;
        const guests = args.guests ?? booking.guests;
        const currentRoom = ctx.userData.db.rooms.find((room) => room.id === booking.roomId)!;
        const wantedType = args.room_type ?? currentRoom.type;
        const room =
          ctx.userData.db
            .availableRooms(checkIn, checkOut, guests)
            .find((candidate) => candidate.type === wantedType) ?? currentRoom;
        booking.roomId = room.id;
        booking.checkIn = checkIn;
        booking.checkOut = checkOut;
        booking.guests = guests;
        booking.extras = args.extras ?? booking.extras;
        booking.total = computeTotal(room, checkIn, checkOut, booking.extras);
        return `updated booking ${speakCode(booking.code)}: ${room.type.replaceAll('_', ' ')} ${room.view} room, ${formatDate(checkIn)} to ${formatDate(checkOut)}, total ${speakUsd(booking.total)}`;
      },
    }),

    flag_late_arrival: llm.tool({
      description: 'Flag a confirmed booking with an expected late-arrival note.',
      parameters: z.object({
        last_name: z.string(),
        confirmation_code: z.string().optional(),
        card_last4: z.string().optional(),
        note: z.string(),
      }),
      execute: async (
        { last_name, confirmation_code, card_last4, note },
        { ctx }: llm.ToolOptions<UserData>,
      ) => {
        const booking = ctx.userData.db.lookupBooking(last_name, confirmation_code, card_last4);
        booking.lateArrivalNote = note;
        return `late arrival noted on ${speakCode(booking.code)}: ${note}`;
      },
    }),

    lookup_invoice: llm.tool({
      description: 'Look up invoice line items for an existing booking.',
      parameters: z.object({
        last_name: z.string(),
        confirmation_code: z.string().optional(),
        card_last4: z.string().optional(),
      }),
      execute: async (
        { last_name, confirmation_code, card_last4 },
        { ctx }: llm.ToolOptions<UserData>,
      ) => {
        const booking = ctx.userData.db.lookupBooking(last_name, confirmation_code, card_last4);
        const room = ctx.userData.db.rooms.find((candidate) => candidate.id === booking.roomId)!;
        const stayNights = nights(booking.checkIn, booking.checkOut);
        const lineItems = [
          `Room (${stayNights} nights): ${speakUsd(room.nightlyRate * stayNights)}`,
        ];
        for (const extra of booking.extras)
          lineItems.push(`${extra.replaceAll('_', ' ')}: included in total`);
        return `${lineItems.join(' | ')} | total paid ${speakUsd(booking.total)}`;
      },
    }),

    dispute_charge: llm.tool({
      description: 'Record and resolve a charge dispute after looking up the invoice.',
      parameters: z.object({
        last_name: z.string(),
        confirmation_code: z.string().optional(),
        card_last4: z.string().optional(),
        category: z.enum([
          'minibar',
          'room_service_restaurant',
          'damage_cleaning',
          'late_checkout_fee',
          'cancellation_fee',
          'no_show',
          'double_charge_billing_error',
          'other',
        ]),
        line_item: z.string(),
        accepts_resolution: z.boolean().default(true),
      }),
      execute: async (
        { last_name, confirmation_code, card_last4, category, line_item, accepts_resolution },
        { ctx }: llm.ToolOptions<UserData>,
      ) => {
        const booking = ctx.userData.db.lookupBooking(last_name, confirmation_code, card_last4);
        const caseNumber = `DSP-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
        if (category === 'minibar')
          return `removed the ${line_item} charge; case ${speakCode(caseNumber)}`;
        if (category === 'double_charge_billing_error')
          return `opened an accounting ticket for ${line_item}; case ${speakCode(caseNumber)}`;
        if (category === 'no_show')
          return `booking ${speakCode(booking.code)} was card-guaranteed with no cancellation on record; escalated to manager, case ${speakCode(caseNumber)}`;
        return accepts_resolution
          ? `recorded dispute for ${line_item}; case ${speakCode(caseNumber)}`
          : `escalated dispute for ${line_item} to the manager; case ${speakCode(caseNumber)}`;
      },
    }),

    resolve_room_conflict: llm.tool({
      description:
        'Resolve a double-booked verified booking with a free move or a partner-hotel walk.',
      parameters: z.object({
        last_name: z.string(),
        confirmation_code: z.string().optional(),
        card_last4: z.string().optional(),
      }),
      execute: async (
        { last_name, confirmation_code, card_last4 },
        { ctx }: llm.ToolOptions<UserData>,
      ) => {
        const booking = ctx.userData.db.lookupBooking(last_name, confirmation_code, card_last4);
        const openSuite = ctx.userData.db
          .availableRooms(booking.checkIn, booking.checkOut, booking.guests)
          .find((room) => room.type === 'suite');
        if (openSuite) {
          booking.roomId = openSuite.id;
          return `resolved: moved to ${openSuite.id.replace('RM_', '')}, an ocean-view suite as a free upgrade; total unchanged`;
        }
        return `no room in the house fits; walk arranged at the partner hotel two blocks away, room and taxi both on us, room back here ${formatDate(addDays(today, 1))}`;
      },
    }),

    start_card_update: llm.tool({
      description: 'Replace the card on file for an existing booking after verification.',
      parameters: z.object({
        last_name: z.string(),
        confirmation_code: z.string().optional(),
        card_last4: z.string().optional(),
        new_card_last4: z.string().min(4).max(4),
      }),
      execute: async (
        { last_name, confirmation_code, card_last4, new_card_last4 },
        { ctx }: llm.ToolOptions<UserData>,
      ) => {
        const booking = ctx.userData.db.lookupBooking(last_name, confirmation_code, card_last4);
        booking.cardLast4 = new_card_last4;
        return `card on file updated to the one ending ${new_card_last4}`;
      },
    }),

    lookup_guest_history: llm.tool({
      description: 'Look up stored preferences for a returning guest by last name.',
      parameters: z.object({ last_name: z.string() }),
      execute: async ({ last_name }) =>
        last_name.toLowerCase() === 'lee'
          ? 'Prefers a high, quiet floor away from the elevator and hypoallergenic pillows.'
          : 'no stored preferences found',
    }),

    add_to_waitlist: llm.tool({
      description: 'Add a caller to the room waitlist when requested dates are sold out.',
      parameters: z.object({
        caller_name: z.string(),
        caller_phone: z.string(),
        check_in: z.string(),
        check_out: z.string(),
        party_size: z.number().int().min(1),
      }),
      execute: async ({ caller_name, caller_phone, check_in, check_out }) =>
        `waitlist entry recorded for ${caller_name}, ${caller_phone}, ${check_in} to ${check_out}; nothing is held or guaranteed`,
    }),

    check_restaurant_availability: llm.tool({
      description: 'Check restaurant time slots for a date. Read-only; it never books.',
      parameters: z.object({
        on_date: z.string(),
        party_size: z.number().int().min(1).max(maxPartySize),
      }),
      execute: async ({ on_date, party_size }, { ctx }: llm.ToolOptions<UserData>) => {
        const date = parseDate(on_date);
        const taken = new Set(
          ctx.userData.db.restaurantReservations
            .filter(
              (reservation) =>
                reservation.status === 'confirmed' && isoDate(reservation.date) === isoDate(date),
            )
            .map((reservation) => reservation.time),
        );
        const slots = [
          '17:30',
          '18:00',
          '18:30',
          '19:00',
          '19:30',
          '20:00',
          '20:30',
          '21:00',
        ].filter((slot) => !taken.has(slot));
        if (party_size > maxPartySize)
          return 'party is too large for normal table booking; transfer to restaurant for private dining';
        return slots.length ? slots.join(', ') : `fully booked on ${formatDate(date)}`;
      },
    }),

    start_restaurant_booking: llm.tool({
      description:
        'Create a restaurant reservation after collecting date, time, party size, name, and phone.',
      parameters: z.object({
        on_date: z.string(),
        at_time: z.string(),
        party_size: z.number().int().min(1).max(maxPartySize),
        first_name: z.string(),
        last_name: z.string(),
        phone: z.string(),
        notes: z.string().optional(),
      }),
      execute: async (args, { ctx }: llm.ToolOptions<UserData>) => {
        const code = `RES-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
        ctx.userData.db.restaurantReservations.push({
          code,
          firstName: args.first_name,
          lastName: args.last_name,
          phone: args.phone,
          partySize: args.party_size,
          date: parseDate(args.on_date),
          time: args.at_time,
          notes: args.notes,
          status: 'confirmed',
        });
        return `You're set for ${args.at_time} on ${formatDate(parseDate(args.on_date))} for ${args.party_size}; confirmation ${speakCode(code)}`;
      },
    }),

    lookup_restaurant_reservation: llm.tool({
      description: 'Look up a confirmed restaurant reservation by last name and confirmation code.',
      parameters: z.object({ last_name: z.string(), confirmation_code: z.string() }),
      execute: async ({ last_name, confirmation_code }, { ctx }: llm.ToolOptions<UserData>) => {
        const code = confirmation_code.replaceAll(' ', '').toUpperCase();
        const reservation = ctx.userData.db.restaurantReservations.find(
          (candidate) =>
            candidate.lastName.toLowerCase() === last_name.toLowerCase() &&
            candidate.code === code &&
            candidate.status === 'confirmed',
        );
        if (!reservation)
          throw new llm.ToolError('could not find a matching confirmed reservation');
        return `reservation for ${reservation.firstName} ${reservation.lastName}, ${reservation.time} on ${formatDate(reservation.date)}, party of ${reservation.partySize}${reservation.notes ? `, note: ${reservation.notes}` : ''}`;
      },
    }),

    cancel_restaurant_reservation: llm.tool({
      description: 'Cancel a restaurant reservation by last name and confirmation code.',
      parameters: z.object({ last_name: z.string(), confirmation_code: z.string() }),
      execute: async ({ last_name, confirmation_code }, { ctx }: llm.ToolOptions<UserData>) => {
        const code = confirmation_code.replaceAll(' ', '').toUpperCase();
        const reservation = ctx.userData.db.restaurantReservations.find(
          (candidate) =>
            candidate.lastName.toLowerCase() === last_name.toLowerCase() && candidate.code === code,
        );
        if (!reservation || reservation.status !== 'confirmed')
          throw new llm.ToolError('could not find a matching confirmed reservation');
        reservation.status = 'cancelled';
        return `reservation for ${reservation.time} on ${formatDate(reservation.date)} cancelled`;
      },
    }),

    modify_restaurant_reservation: llm.tool({
      description:
        'Move an existing restaurant reservation to a new date/time and optionally party size.',
      parameters: z.object({
        last_name: z.string(),
        confirmation_code: z.string(),
        new_date: z.string(),
        new_time: z.string(),
        new_party_size: z.number().int().min(1).max(maxPartySize).optional(),
      }),
      execute: async (
        { last_name, confirmation_code, new_date, new_time, new_party_size },
        { ctx }: llm.ToolOptions<UserData>,
      ) => {
        const code = confirmation_code.replaceAll(' ', '').toUpperCase();
        const reservation = ctx.userData.db.restaurantReservations.find(
          (candidate) =>
            candidate.lastName.toLowerCase() === last_name.toLowerCase() &&
            candidate.code === code &&
            candidate.status === 'confirmed',
        );
        if (!reservation)
          throw new llm.ToolError('could not find a matching confirmed reservation');
        reservation.date = parseDate(new_date);
        reservation.time = new_time;
        reservation.partySize = new_party_size ?? reservation.partySize;
        return `reservation updated to ${reservation.time} on ${formatDate(reservation.date)} for ${reservation.partySize}, code ${speakCode(reservation.code)}`;
      },
    }),

    record_followup: llm.tool({
      description:
        'Record a human follow-up request for housekeeping, sales, identity changes, callbacks, lost-and-found, or anything outside direct tools.',
      parameters: z.object({
        kind: z.enum([
          'housekeeping',
          'sales_lead',
          'identity_change',
          'callback',
          'verification_help',
          'early_checkout',
          'abandoned_booking',
          'lost_and_found',
          'other',
        ]),
        caller_name: z.string(),
        caller_phone: z.string(),
        summary: z.string(),
      }),
      execute: async (
        { kind, caller_name, caller_phone, summary },
        { ctx }: llm.ToolOptions<UserData>,
      ) => {
        const ref = `FUP-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
        ctx.userData.db.followups.push(
          `${ref}: ${kind}: ${caller_name} ${caller_phone}: ${summary}`,
        );
        return `recorded; reference ${speakCode(ref)} for ${caller_name}, ${caller_phone}: ${summary}`;
      },
    }),

    record_group_inquiry: llm.tool({
      description: 'Open a room-block inquiry for a group of 15 or more guests.',
      parameters: z.object({
        company: z.string(),
        contact_name: z.string(),
        contact_phone: z.string(),
        party_size: z.number().int().min(15),
        share_type: z.enum(['twin', 'double', 'single', 'mixed']),
        check_in: z.string(),
        nights: z.number().int().min(1),
      }),
      execute: async ({ company, contact_name }) =>
        `group inquiry recorded for ${company}; the group desk will call ${contact_name} within two business days after credit review`,
    }),

    schedule_wakeup_call: llm.tool({
      description: 'Schedule a wake-up call to a room.',
      parameters: z.object({
        room: z.string(),
        guest_name: z.string(),
        call_date: z.string(),
        call_time: z.string(),
      }),
      execute: async (
        { room, guest_name, call_date, call_time },
        { ctx }: llm.ToolOptions<UserData>,
      ) => {
        ctx.userData.db.roomByNumber(room);
        return `wake-up call set for ${guest_name} in room ${room}, ${call_date} at ${call_time}; reference ${speakCode(`WKU-${Math.random().toString(36).slice(2, 6).toUpperCase()}`)}`;
      },
    }),

    dispatch_emergency: llm.tool({
      description:
        'Emergency only: dispatch hotel staff/security to a room for medical, fire, or security danger.',
      parameters: z.object({
        room: z.string(),
        kind: z.enum(['medical', 'fire', 'security']),
        situation: z.string(),
      }),
      execute: async ({ room, kind, situation }, { ctx }: llm.ToolOptions<UserData>) => {
        ctx.userData.db.roomByNumber(room);
        return `DISPATCHED: duty manager and staff heading to room ${room} for ${kind}: ${situation}. Tell the caller our people are on their way and direct them to 911 if needed.`;
      },
    }),

    book_tour: llm.tool({
      description: 'Book a sightseeing tour through the desk after lookup_policy(topic="tours").',
      parameters: z.object({
        tour: z.enum(['half_day_city', 'full_day_city', 'private_city']),
        on_date: z.string(),
        party_size: z.number().int().min(1),
        guest_name: z.string(),
        guest_phone: z.string(),
      }),
      execute: async ({ tour, on_date, party_size }) =>
        `${tour.replaceAll('_', ' ')} booked for ${party_size} on ${on_date}; reference ${speakCode(`TOU-${Math.random().toString(36).slice(2, 6).toUpperCase()}`)}`,
    }),

    book_spa_appointment: llm.tool({
      description: 'Book a spa or health-club appointment after lookup_policy(topic="spa").',
      parameters: z.object({
        service: z.enum([
          'deep_tissue_massage',
          'signature_facial',
          'personal_training',
          'group_yoga',
        ]),
        on_date: z.string(),
        at_time: z.string(),
        party_size: z.number().int().min(1),
        guest_name: z.string(),
        guest_phone: z.string(),
      }),
      execute: async ({ service, on_date, at_time, party_size }) =>
        `${service.replaceAll('_', ' ')} booked for ${party_size} on ${on_date} at ${at_time}; reference ${speakCode(`SPA-${Math.random().toString(36).slice(2, 6).toUpperCase()}`)}`,
    }),

    order_flowers: llm.tool({
      description: 'Order flowers for delivery after lookup_policy(topic="florist").',
      parameters: z.object({
        arrangement: z.enum(['seasonal_bouquet', 'rose_arrangement', 'orchid_bowl']),
        delivery_date: z.string(),
        recipient: z.string(),
        location: z.string(),
        card_message: z.string(),
        caller_name: z.string(),
        caller_phone: z.string(),
      }),
      execute: async ({ arrangement, delivery_date, recipient, location }) =>
        `${arrangement.replaceAll('_', ' ')} ordered for ${recipient} at ${location} on ${delivery_date}; reference ${speakCode(`FLR-${Math.random().toString(36).slice(2, 6).toUpperCase()}`)}`,
    }),

    request_flight_reconfirmation: llm.tool({
      description: 'Record a concierge flight reconfirmation request.',
      parameters: z.object({
        airline: z.string(),
        flight_number: z.string(),
        flight_date: z.string(),
        booking_reference: z.string(),
        guest_name: z.string(),
        room_or_phone: z.string(),
      }),
      execute: async ({ airline, flight_number, guest_name }) =>
        `concierge request recorded for ${guest_name}; they will reconfirm ${airline} ${flight_number} and call back`,
    }),

    book_airport_car: llm.tool({
      description: 'Book the hotel car from the hotel to SFO.',
      parameters: z.object({
        departure_date: z.string(),
        departure_time: z.string(),
        guest_name: z.string(),
        room_or_phone: z.string(),
        passengers: z.number().int().min(1),
      }),
      execute: async ({ departure_date, departure_time, passengers }) =>
        `hotel car booked to SFO for ${passengers} on ${departure_date} at ${departure_time}; reference ${speakCode(`CAR-${Math.random().toString(36).slice(2, 6).toUpperCase()}`)}`,
    }),

    book_business_center: llm.tool({
      description:
        'Book a business-center room, secretarial help, or print job after lookup_policy(topic="business_center").',
      parameters: z.object({
        service: z.enum(['meeting_room', 'secretarial_help', 'printing']),
        on_date: z.string(),
        at_time: z.string(),
        duration_minutes: z.number().int().min(15),
        guest_name: z.string(),
        room_or_phone: z.string(),
        notes: z.string().optional(),
      }),
      execute: async ({ service, on_date, at_time }) =>
        `${service.replaceAll('_', ' ')} booked for ${on_date} at ${at_time}; reference ${speakCode(`BUS-${Math.random().toString(36).slice(2, 6).toUpperCase()}`)}`,
    }),

    take_guest_message: llm.tool({
      description:
        'Take a message for a possible guest without confirming whether they are staying.',
      parameters: z.object({
        guest_name: z.string(),
        caller_name: z.string(),
        caller_phone: z.string(),
        message: z.string(),
      }),
      execute: async ({ guest_name, caller_name, message }, { ctx }: llm.ToolOptions<UserData>) => {
        ctx.userData.db.messages.push(`${guest_name}: from ${caller_name}: ${message}`);
        return `message recorded; if ${guest_name} is a guest, it will be passed along`;
      },
    }),

    transfer_call: llm.tool({
      description:
        'Transfer the caller to a hotel department after telling them and receiving their okay.',
      parameters: z.object({
        destination: z.enum(['restaurant', 'manager', 'duty_manager', 'housekeeping']),
        summary: z.string(),
      }),
      execute: async ({ destination, summary }, { ctx }: llm.ToolOptions<UserData>) => {
        if (ctx.userData.transferredTo.has(destination))
          return `already transferred to ${destination}; do not transfer again`;
        ctx.userData.transferredTo.add(destination);
        return `transfer to ${destination} started; summary: ${summary}`;
      },
    }),

    set_do_not_disturb: llm.tool({
      description: 'Hold calls and messages for a room until the guest lifts the hold.',
      parameters: z.object({ room: z.string() }),
      execute: async ({ room }, { ctx }: llm.ToolOptions<UserData>) => {
        ctx.userData.db.roomByNumber(room);
        ctx.userData.db.dndRooms.add(room);
        return `do-not-disturb set for room ${room}; calls and messages are held except genuine emergencies`;
      },
    }),

    resend_confirmation: llm.tool({
      description: 'Resend a booking confirmation or itemized folio to the email already on file.',
      parameters: z.object({
        last_name: z.string(),
        confirmation_code: z.string().optional(),
        card_last4: z.string().optional(),
        document: z.enum(['confirmation', 'folio']),
      }),
      execute: async (
        { last_name, confirmation_code, card_last4, document },
        { ctx }: llm.ToolOptions<UserData>,
      ) => {
        const booking = ctx.userData.db.lookupBooking(last_name, confirmation_code, card_last4);
        return `${document} sent to ${booking.email}`;
      },
    }),
  };
}

class HotelReceptionistAgent extends voice.Agent<UserData> {
  constructor() {
    super({ instructions: buildInstructions(), tools: createTools() });
  }

  async onEnter(): Promise<void> {
    await this.session.generateReply({
      instructions:
        "Greet the caller in one short sentence. If they've already named a need, move straight into helping; otherwise ask how you can help.",
    });
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    const session = new voice.AgentSession<UserData>({
      userData: { db: new HotelDb(), transferredTo: new Set() },
      vad: new inference.VAD(),
      stt: new inference.STT({ model: 'deepgram/nova-3' }),
      llm: new inference.LLM({ model: 'google/gemini-3-flash-preview' }),
      tts: new inference.TTS({ model: 'inworld/inworld-tts-2' }),
      voiceOptions: { maxToolSteps: 5 },
    });

    await session.start({ agent: new HotelReceptionistAgent(), room: ctx.room });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
