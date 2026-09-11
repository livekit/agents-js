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
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const ROOM_TYPES = ['king', 'queen_2beds', 'double_queen', 'suite', 'penthouse'] as const;
const ROOM_EXTRAS = ['breakfast', 'valet', 'late_checkout', 'pets'] as const;
const FOLLOWUP_KINDS = [
  'sales_lead',
  'identity_change',
  'callback',
  'verification_help',
  'early_checkout',
  'abandoned_booking',
  'other',
] as const;
const DISPUTE_CATEGORIES = [
  'minibar',
  'room_service_restaurant',
  'damage_cleaning',
  'late_checkout_fee',
  'cancellation_fee',
  'double_charge_billing_error',
  'other',
] as const;

type RoomType = (typeof ROOM_TYPES)[number];
type RoomExtra = (typeof ROOM_EXTRAS)[number];
type FollowupKind = (typeof FOLLOWUP_KINDS)[number];
type DisputeCategory = (typeof DISPUTE_CATEGORIES)[number];
type BookingStatus = 'confirmed' | 'cancelled';

interface Room {
  id: number;
  roomNumber: string;
  type: RoomType;
  nightlyRate: number;
  maxOccupancy: number;
  smoking: boolean;
  petsAllowed: boolean;
  roomView: string;
}

interface RoomTypeAvailability {
  type: RoomType;
  nightlyRate: number;
  sampleView: string;
}

interface RoomBooking {
  id: number;
  code: string;
  roomId: number;
  roomType: RoomType;
  smoking: boolean;
  nightlyRate: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  extras: RoomExtra[];
  total: number;
  cardLast4: string;
  status: BookingStatus;
  lateArrivalNote?: string;
}

interface RestaurantTable {
  id: number;
  label: string;
  capacity: number;
  location: string;
  description: string;
}

interface RestaurantReservation {
  id: number;
  code: string;
  tableId: number;
  firstName: string;
  lastName: string;
  phone: string;
  partySize: number;
  date: string;
  time: string;
  notes?: string;
  status: BookingStatus;
}

interface TimeSlot {
  time: string;
  availableTableIds: number[];
}

interface LineItem {
  label: string;
  amountCents: number;
}

interface Invoice {
  id: number;
  bookingCode: string;
  lineItems: LineItem[];
  subtotal: number;
  taxes: number;
  total: number;
  paid: boolean;
}

interface DisputePolicy {
  action:
    | 'auto_refund_if_under_threshold'
    | 'verify_explain_then_offer_credit'
    | 'explain_no_refund'
    | 'explain_policy_offer_goodwill'
    | 'correct_immediately_or_open_ticket';
  escalation: 'manager' | 'accounting' | 'none';
  explanation: string;
}

interface UserData {
  db: HotelDB;
  consent?: boolean;
  bookedRoomCodes: string[];
  bookedRestaurantCodes: string[];
  cancelledCodes: string[];
  verifiedBooking?: RoomBooking;
}

const PRICING = {
  breakfastPerNight: 2500,
  valetPerNight: 3500,
  lateCheckout: 4000,
  petFee: 5000,
  smokingCleaningFee: 25000,
  taxRatePct: 12,
  cancellationWindowHours: 48,
  cancellationForfeitNights: 1,
  minibarAutoRefundThreshold: 2000,
};

const MAX_PARTY_SIZE = 6;
// eslint-disable-next-line turbo/no-undeclared-env-vars
const TODAY = process.env.HOTEL_TODAY ?? new Date().toISOString().slice(0, 10);
const DINING_SLOTS = [
  '17:30:00',
  '18:00:00',
  '18:30:00',
  '19:00:00',
  '19:30:00',
  '20:00:00',
  '20:30:00',
  '21:00:00',
];

const DISPUTE_POLICIES: Record<DisputeCategory, DisputePolicy> = {
  minibar: {
    action: 'auto_refund_if_under_threshold',
    escalation: 'manager',
    explanation:
      "For small minibar charges I can waive them right away. If it's a larger amount I'll verify against the housekeeping note first.",
  },
  room_service_restaurant: {
    action: 'verify_explain_then_offer_credit',
    escalation: 'manager',
    explanation:
      "I'll pull up the order. If something looks off I can apply a credit, or escalate to the food and beverage manager.",
  },
  damage_cleaning: {
    action: 'explain_no_refund',
    escalation: 'manager',
    explanation:
      "Damage and cleaning fees are assessed by housekeeping. I can't waive them, but I can have the manager review and follow up by email.",
  },
  late_checkout_fee: {
    action: 'explain_policy_offer_goodwill',
    escalation: 'manager',
    explanation: `Late checkout past noon is ${formatUsd(PRICING.lateCheckout)}. If this is your first time I can waive it as a one-time courtesy.`,
  },
  cancellation_fee: {
    action: 'explain_policy_offer_goodwill',
    escalation: 'manager',
    explanation: `Our policy is free cancellation up to ${PRICING.cancellationWindowHours} hours before check-in. Inside that window it's one night. If you're a returning guest I can waive it once.`,
  },
  double_charge_billing_error: {
    action: 'correct_immediately_or_open_ticket',
    escalation: 'accounting',
    explanation:
      "If I can see the duplicate I'll refund it right now. Otherwise accounting will open a ticket and email you within two business days.",
  },
  other: {
    action: 'verify_explain_then_offer_credit',
    escalation: 'manager',
    explanation: 'Let me look into that and offer a fair resolution.',
  },
};

const HOTEL_INFO = `Address: 100 LiveKit Way, San Francisco.
Airport: SFO is roughly 30 minutes by car. No hotel shuttle; the front desk will arrange a ride.
Getting around: nearest Muni stop is two blocks away; BART is a 10-minute walk. Cabs and rideshares pick up at the main entrance.
Neighborhood: a few coffee shops and a 24-hour pharmacy within two blocks. The nearest hospital is six blocks east; non-emergency urgent care five blocks south.
Things to do nearby: walkable to the waterfront and the main shopping street; the front desk keeps a list of dinner spots, museums, and tour operators for guests who ask.
Rooms: 55-inch TV, mini-fridge, safe, iron, hair dryer, Nespresso, blackout curtains. King beds in most rooms; suites have a separate sitting area.
Cribs and rollaway beds: free on request, subject to availability - mention it at booking or call ahead.
Accessibility: ADA-accessible rooms on every floor, roll-in showers in the suites. Mention at booking so we assign one.
Connecting rooms: available on request, subject to availability.
Laundry and dry-cleaning: drop at the front desk before 9 AM for same-day return, priced per item.
Lost-and-found: held at the front desk for 90 days.
Business center: 24/7 lobby workstations with printing.
Spa: not on-site. The front desk can recommend places nearby.`;

const RESTAURANT_INFO = `Menu: standard dinner fare - starters and salads, mains (salmon, chicken, steak, pasta, burger, vegetarian risotto), sides, desserts, full bar. Specific dish prices rotate and I don't keep them memorized; if the caller asks about a particular dish or price I don't have, offer to note the question for the kitchen via record_followup (kind="other").
Dietary and allergies: vegetarian and most dietary needs handled. For severe or anaphylactic allergies, the kitchen needs to know at the reservation.
Dress code: smart casual. No jacket required.
Seating: indoor dining room, outdoor terrace, and a bar. Children welcome.
Reservations: bar walk-ins fine anytime; tables are reservation-only on weekends.
Private dining: separate room seats up to twelve. Advance reservation required.
Room service: same menu as the restaurant, 5:30 to 9:30 PM.
Takeout and delivery: not offered.
Celebrations: mention a birthday or anniversary at the reservation and the kitchen sends out a small dessert.`;

const COMMON_INSTRUCTIONS = `You're a receptionist at The LiveKit Hotel, a small boutique property with an on-site restaurant. Speak naturally, not from a customer-service script. Don't pad answers with stock filler before getting to the point, and don't repeat context the caller just gave you. When you do refer to the hotel by name, say it in full ("The LiveKit Hotel"), never shorten - but don't bring up the name unnecessarily; the caller knows where they called. Today is ${formatLongDate(TODAY)}. You're on a phone call with a guest.

# What you can help with
- Room bookings - check availability, book a stay, modify a confirmed booking, cancel.
- Restaurant table reservations - check availability, book, look up, cancel.
- Looking up an existing booking or reservation (read-only - dates, room, total, time).
- Invoice lookup and charge disputes on existing bookings.
- General hotel info (location, transport, room amenities, accessibility, cribs/rollaways, laundry, lost-and-found, business center) and restaurant info (menu, dietary, dress code, private dining, room service, celebrations).
- Group bookings, events, weddings, corporate rates - I'll take a name and number for the sales team to follow up; not bookable on this line.

If the caller names any of these (even while you're handling a prerequisite step like consent or verification), acknowledge you can help with it before steering back to the step at hand. If they ask for something genuinely outside this list, offer to pass it to the front desk - don't reject the caller.

# How you sound
- One sentence per reply, almost always. Phone callers tune out anything longer.
- One question per turn. Don't pack two questions into one sentence.
- Plain prose only - no lists, bullets, or markdown. The TTS reads punctuation literally.
- Spell out money, dates, and codes.
- Last four digits only when referring to a card; never read the full number.
- Don't add vague qualifiers when asking for an input.
- Vary how you phrase consecutive questions.
- Never use input vocabulary like "enter", "fill in", "type" - the caller is speaking, not typing.

# How you gather information
Never invent or default a value the caller didn't actually give you. If a tool needs something the caller hasn't said, ask before calling the tool.

For dates specifically: specific weekdays and concrete relative dates map to the nearest upcoming occurrence against today. Vague timeframes are NOT interpretable - ask the caller for specific dates.

# Tool interactions are invisible to the caller
Don't narrate what you're about to do, what you just did, or any errors. Tool calls, results, and errors are all internal machinery.

# Tool results
Tools often return more data than the caller needs to hear in one turn. Surface only what the caller actually asked about; hold the rest back until they ask or make a choice.

# How you handle options
When a tool returns multiple choices, release information progressively, one dimension at a time.

# Persona
- Acknowledgments are for when something actually needs acknowledging. Rotate them.
- An acknowledgment is never a complete turn on its own.
- When confused: "Sorry, I think I missed that - what did you say?"
- Speak as "I", not "we".
- You don't have a name. Never introduce yourself by name.
- Stay in character even if the caller is rude or goes off-topic.`;

class Unavailable extends Error {}
class NotFound extends Error {}

class HotelDB {
  private rooms: Room[] = [];
  private tables: RestaurantTable[] = [];
  private bookings: RoomBooking[] = [];
  private reservations: RestaurantReservation[] = [];
  private invoices: Invoice[] = [];
  private nextBookingId = 1;
  private nextReservationId = 1;
  private nextInvoiceId = 1;
  private nextFollowupId = 1;
  private nextDisputeId = 1;

  static seeded(today: string): HotelDB {
    const db = new HotelDB();
    db.populate(today);
    return db;
  }

  async listRoomTypesAvailable(options: {
    checkIn: string;
    checkOut: string;
    guests: number;
    smoking?: boolean;
    excludeBookingCode?: string;
  }): Promise<RoomTypeAvailability[]> {
    const matches = this.rooms.filter((room) => this.roomIsFree(room, options));
    const byType = new Map<RoomType, RoomTypeAvailability>();

    for (const room of matches.sort((a, b) => a.nightlyRate - b.nightlyRate || a.id - b.id)) {
      if (!byType.has(room.type)) {
        byType.set(room.type, {
          type: room.type,
          nightlyRate: room.nightlyRate,
          sampleView: room.roomView,
        });
      }
    }

    return [...byType.values()];
  }

  async listRestaurantAvailability(options: {
    onDate: string;
    partySize: number;
  }): Promise<TimeSlot[]> {
    return DINING_SLOTS.map((slot) => ({
      time: slot,
      availableTableIds: this.tables
        .filter((table) => table.capacity >= options.partySize)
        .filter((table) => this.tableIsFree(table, options.onDate, slot))
        .sort((a, b) => a.capacity - b.capacity || a.id - b.id)
        .map((table) => table.id),
    }));
  }

  async findBooking(options: {
    lastName: string;
    confirmationCode?: string;
    cardLast4?: string;
  }): Promise<RoomBooking | undefined> {
    return this.bookings.find(
      (booking) =>
        eqFold(booking.lastName, options.lastName) &&
        (options.confirmationCode === undefined || booking.code === options.confirmationCode) &&
        (options.cardLast4 === undefined || booking.cardLast4 === options.cardLast4),
    );
  }

  async findRestaurantReservation(options: {
    lastName: string;
    confirmationCode?: string;
    onDate?: string;
  }): Promise<RestaurantReservation | undefined> {
    return this.reservations.find(
      (reservation) =>
        eqFold(reservation.lastName, options.lastName) &&
        (options.confirmationCode === undefined || reservation.code === options.confirmationCode) &&
        (options.onDate === undefined || reservation.date === options.onDate),
    );
  }

  async getInvoice(bookingCode: string): Promise<Invoice> {
    const invoice = this.invoices.find((i) => i.bookingCode === bookingCode);
    if (!invoice) throw new NotFound(`no invoice for ${bookingCode}`);
    return invoice;
  }

  async bookRoom(options: {
    roomType: RoomType;
    smoking: boolean;
    guests: number;
    checkIn: string;
    checkOut: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    cardLast4: string;
    extras: RoomExtra[];
  }): Promise<RoomBooking> {
    const room = this.freeRoom({
      roomType: options.roomType,
      smoking: options.smoking,
      guests: options.guests,
      checkIn: options.checkIn,
      checkOut: options.checkOut,
    });
    if (!room) throw new Unavailable(`sold out: ${options.roomType}`);

    const extras = cleanExtras(options.extras);
    const nights = nightsBetween(options.checkIn, options.checkOut);
    const invoice = computeInvoice({ nightlyRate: room.nightlyRate, nights, extras });
    const booking: RoomBooking = {
      id: this.nextBookingId++,
      code: shortUuid('HTL-'),
      roomId: room.id,
      roomType: room.type,
      smoking: room.smoking,
      nightlyRate: room.nightlyRate,
      firstName: options.firstName,
      lastName: options.lastName,
      email: options.email,
      phone: options.phone,
      checkIn: options.checkIn,
      checkOut: options.checkOut,
      guests: options.guests,
      extras,
      total: invoice.total,
      cardLast4: options.cardLast4,
      status: 'confirmed',
    };
    this.bookings.push(booking);
    this.invoices.push({
      id: this.nextInvoiceId++,
      bookingCode: booking.code,
      lineItems: invoice.lineItems,
      subtotal: invoice.subtotal,
      taxes: invoice.taxes,
      total: invoice.total,
      paid: false,
    });
    return booking;
  }

  async updateBooking(options: {
    bookingCode: string;
    roomType: RoomType;
    smoking: boolean;
    guests: number;
    checkIn: string;
    checkOut: string;
    extras: RoomExtra[];
  }): Promise<RoomBooking> {
    const room = this.freeRoom({
      roomType: options.roomType,
      smoking: options.smoking,
      guests: options.guests,
      checkIn: options.checkIn,
      checkOut: options.checkOut,
      excludeBookingCode: options.bookingCode,
    });
    if (!room) throw new Unavailable(`sold out: ${options.roomType}`);

    const booking = this.bookings.find(
      (b) => b.code === options.bookingCode && b.status === 'confirmed',
    );
    if (!booking) throw new NotFound(`booking not found: ${options.bookingCode}`);

    const extras = cleanExtras(options.extras);
    const nights = nightsBetween(options.checkIn, options.checkOut);
    const invoice = computeInvoice({ nightlyRate: room.nightlyRate, nights, extras });

    Object.assign(booking, {
      roomId: room.id,
      roomType: room.type,
      smoking: room.smoking,
      nightlyRate: room.nightlyRate,
      checkIn: options.checkIn,
      checkOut: options.checkOut,
      guests: options.guests,
      extras,
      total: invoice.total,
    });

    const existingInvoice = await this.getInvoice(booking.code);
    Object.assign(existingInvoice, {
      lineItems: invoice.lineItems,
      subtotal: invoice.subtotal,
      taxes: invoice.taxes,
      total: invoice.total,
    });
    return booking;
  }

  async cancelRoomBooking(bookingCode: string): Promise<void> {
    const booking = this.bookings.find((b) => b.code === bookingCode && b.status === 'confirmed');
    if (!booking) throw new NotFound(`booking not found: ${bookingCode}`);
    booking.status = 'cancelled';
  }

  async bookRestaurant(options: {
    firstName: string;
    lastName: string;
    phone: string;
    partySize: number;
    onDate: string;
    atTime: string;
    notes?: string;
  }): Promise<RestaurantReservation> {
    const table = this.tables
      .filter((t) => t.capacity >= options.partySize)
      .sort((a, b) => a.capacity - b.capacity || a.id - b.id)
      .find((t) => this.tableIsFree(t, options.onDate, options.atTime));
    if (!table) throw new Unavailable(`restaurant full: ${options.onDate} ${options.atTime}`);

    const reservation: RestaurantReservation = {
      id: this.nextReservationId++,
      code: shortUuid('RES-'),
      tableId: table.id,
      firstName: options.firstName,
      lastName: options.lastName,
      phone: options.phone,
      partySize: options.partySize,
      date: options.onDate,
      time: normalizeTime(options.atTime),
      notes: options.notes,
      status: 'confirmed',
    };
    this.reservations.push(reservation);
    return reservation;
  }

  async cancelRestaurantReservation(code: string): Promise<void> {
    const reservation = this.reservations.find((r) => r.code === code && r.status === 'confirmed');
    if (!reservation) throw new NotFound(`reservation not found: ${code}`);
    reservation.status = 'cancelled';
  }

  async flagLateArrival(options: { bookingCode: string; note: string }): Promise<void> {
    const booking = this.bookings.find(
      (b) => b.code === options.bookingCode && b.status === 'confirmed',
    );
    if (!booking) throw new NotFound(`booking not found: ${options.bookingCode}`);
    booking.lateArrivalNote = options.note;
  }

  async recordFollowup(_options: {
    kind: FollowupKind;
    callerName: string;
    callerPhone: string;
    summary: string;
  }): Promise<string> {
    this.nextFollowupId += 1;
    return shortUuid('FUP-');
  }

  async fileDispute(options: {
    bookingCode: string;
    lineItem: string;
    amountCents: number;
    category: DisputeCategory;
    callerNote: string;
    outcome: string;
    refundAmount: number;
  }): Promise<string> {
    this.nextDisputeId += 1;
    if (options.refundAmount > 0) {
      const invoice = await this.getInvoice(options.bookingCode);
      invoice.total -= options.refundAmount;
    }
    return shortUuid('DSP-');
  }

  private freeRoom(options: {
    roomType: RoomType;
    smoking: boolean;
    guests: number;
    checkIn: string;
    checkOut: string;
    excludeBookingCode?: string;
  }): Room | undefined {
    return this.rooms
      .filter((room) => room.type === options.roomType)
      .filter((room) => room.smoking === options.smoking)
      .filter((room) => room.maxOccupancy >= options.guests)
      .filter((room) => this.roomIsFree(room, options))
      .sort((a, b) => a.id - b.id)[0];
  }

  private roomIsFree(
    room: Room,
    options: {
      checkIn: string;
      checkOut: string;
      guests: number;
      smoking?: boolean;
      excludeBookingCode?: string;
    },
  ): boolean {
    if (room.maxOccupancy < options.guests) return false;
    if (options.smoking !== undefined && room.smoking !== options.smoking) return false;
    return !this.bookings.some(
      (booking) =>
        booking.roomId === room.id &&
        booking.status === 'confirmed' &&
        booking.code !== options.excludeBookingCode &&
        rangesOverlap(booking.checkIn, booking.checkOut, options.checkIn, options.checkOut),
    );
  }

  private tableIsFree(table: RestaurantTable, onDate: string, atTime: string): boolean {
    const time = normalizeTime(atTime);
    return !this.reservations.some(
      (reservation) =>
        reservation.tableId === table.id &&
        reservation.status === 'confirmed' &&
        reservation.date === onDate &&
        reservation.time === time,
    );
  }

  private populate(today: string): void {
    this.rooms = ROOMS.map((room, index) => ({
      id: index + 1,
      roomNumber: room[0],
      type: room[1],
      nightlyRate: room[2],
      maxOccupancy: room[3],
      smoking: room[4],
      petsAllowed: room[5],
      roomView: room[6],
    }));
    this.tables = TABLES.map((table, index) => ({
      id: index + 1,
      label: table[0],
      capacity: table[1],
      location: table[2],
      description: table[3],
    }));

    for (const bookingSeed of BOOKINGS) {
      const [
        firstName,
        lastName,
        email,
        phone,
        suffix,
        roomNumber,
        offset,
        nights,
        guests,
        extras,
        cardLast4,
        status,
      ] = bookingSeed;
      const room = this.rooms.find((r) => r.roomNumber === roomNumber);
      if (!room) throw new Error(`seed fixture references unknown room ${roomNumber}`);
      const checkIn = addDays(today, offset);
      const checkOut = addDays(checkIn, nights);
      const invoice = computeInvoice({ nightlyRate: room.nightlyRate, nights, extras });
      const code = `HTL-${suffix}`;
      this.bookings.push({
        id: this.nextBookingId++,
        code,
        roomId: room.id,
        roomType: room.type,
        smoking: room.smoking,
        nightlyRate: room.nightlyRate,
        firstName,
        lastName,
        email,
        phone,
        checkIn,
        checkOut,
        guests,
        extras: cleanExtras(extras),
        total: invoice.total,
        cardLast4,
        status,
      });
      this.invoices.push({
        id: this.nextInvoiceId++,
        bookingCode: code,
        lineItems: invoice.lineItems,
        subtotal: invoice.subtotal,
        taxes: invoice.taxes,
        total: invoice.total,
        paid: offset <= 0 && status === 'confirmed',
      });
    }

    for (const seed of RESERVATIONS) {
      const [
        firstName,
        lastName,
        phone,
        partySize,
        offset,
        hour,
        minute,
        suffix,
        label,
        notes,
        status,
      ] = seed;
      const table = this.tables.find((t) => t.label === label);
      if (!table) throw new Error(`seed fixture references unknown table ${label}`);
      this.reservations.push({
        id: this.nextReservationId++,
        code: `RES-${suffix}`,
        tableId: table.id,
        firstName,
        lastName,
        phone,
        partySize,
        date: addDays(today, offset),
        time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`,
        notes: notes ?? undefined,
        status,
      });
    }

    for (const dispute of DISPUTES) {
      const [_caseNumber, bookingCode, _lineItem, _amount, _category, _note, _outcome, refund] =
        dispute;
      if (refund > 0) {
        const invoice = this.invoices.find((i) => i.bookingCode === bookingCode);
        if (invoice) invoice.total -= refund;
      }
    }
  }
}

const ROOMS: readonly [string, RoomType, number, number, boolean, boolean, string][] = [
  ['201', 'king', 24000, 2, false, false, 'city'],
  ['202', 'king', 26000, 2, false, true, 'ocean'],
  ['203', 'king', 24000, 2, true, false, 'city'],
  ['204', 'queen_2beds', 22000, 4, false, false, 'city'],
  ['205', 'queen_2beds', 22000, 4, false, true, 'garden'],
  ['206', 'double_queen', 26000, 4, false, false, 'ocean'],
  ['301', 'king', 28000, 2, false, false, 'ocean'],
  ['302', 'king', 28000, 2, false, false, 'ocean'],
  ['303', 'queen_2beds', 24000, 4, false, false, 'city'],
  ['304', 'double_queen', 28000, 4, false, true, 'ocean'],
  ['401', 'suite', 48000, 4, false, true, 'ocean'],
  ['402', 'suite', 52000, 4, false, false, 'ocean'],
  ['PH', 'penthouse', 120000, 6, false, true, 'ocean'],
];

const TABLES: readonly [string, number, string, string][] = [
  ['T-01', 2, 'indoor', 'Window two-top overlooking the harbor'],
  ['T-02', 2, 'indoor', 'Quiet corner booth, tucked beside the wine wall'],
  ['T-03', 4, 'indoor', 'Round table beneath the chandelier'],
  ['T-04', 4, 'indoor', 'Velvet banquette along the main dining wall'],
  ['T-05', 6, 'indoor', "Chef's table facing the open kitchen"],
  ['P-01', 2, 'terrace', 'Intimate table for two at the terrace railing'],
  ['P-02', 4, 'terrace', 'Terrace table under the string lights'],
  ['P-03', 4, 'terrace', 'Shaded terrace table by the herb garden'],
  ['B-01', 2, 'bar', 'High-top at the end of the marble bar'],
  ['B-02', 2, 'bar', 'Counter seats facing the bartenders'],
];

const BOOKINGS: readonly [
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
][] = [
  [
    'Sofía',
    'García',
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
    'Lucas',
    'Meyer',
    'lucas.meyer@gmx.de',
    '+49 30 5550173',
    'ZP19',
    '402',
    -3,
    5,
    2,
    ['breakfast', 'valet'],
    '9041',
    'confirmed',
  ],
  [
    'Vivienne',
    'Laurent',
    'v.laurent@me.com',
    '+1 415 555 0193',
    'PH01',
    'PH',
    -2,
    6,
    2,
    ['breakfast', 'valet', 'pets'],
    '1206',
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
    'Hiroshi',
    'Sato',
    'h.sato@gmail.com',
    '+1 415 555 0211',
    'BN23',
    '204',
    1,
    2,
    3,
    ['breakfast'],
    '8821',
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
    'Olivia',
    'Brandt',
    'olivia.brandt@me.com',
    '+1 415 555 0288',
    'QT55',
    '204',
    -10,
    3,
    2,
    ['breakfast'],
    '6677',
    'confirmed',
  ],
  [
    'Aino',
    'Virtanen',
    'aino.virtanen@gmail.com',
    '+358 9 5550144',
    'JX31',
    '303',
    -14,
    4,
    3,
    ['breakfast', 'valet'],
    '5512',
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

const RESERVATIONS: readonly [
  string,
  string,
  string,
  number,
  number,
  number,
  number,
  string,
  string,
  string | null,
  BookingStatus,
][] = [
  ['Marcus', 'Bennett', '+1 415 555 0231', 4, 0, 19, 0, 'JK90', 'T-03', 'Birthday', 'confirmed'],
  [
    'Hannah',
    'Kowalski',
    '+1 415 555 0244',
    2,
    0,
    20,
    30,
    'LM12',
    'T-01',
    'Anniversary',
    'confirmed',
  ],
  [
    'Sofía',
    'García',
    '+1 415 555 0107',
    6,
    0,
    19,
    30,
    'NP21',
    'T-05',
    'Family dinner',
    'confirmed',
  ],
  ['Diego', 'Herrera', '+1 415 555 0259', 2, 0, 18, 0, 'QR34', 'B-01', null, 'confirmed'],
  ['Yuki', 'Sato', '+1 415 555 0277', 2, 1, 20, 0, 'ST56', 'P-01', null, 'confirmed'],
  ['Olivia', 'Brandt', '+1 415 555 0288', 4, 1, 18, 0, 'UV78', 'T-04', null, 'confirmed'],
  ['Tomás', 'Silva', '+1 415 555 0290', 4, 2, 18, 30, 'WX90', 'T-04', null, 'confirmed'],
  ['Naomi', 'Adeyemi', '+1 415 555 0301', 4, 2, 19, 30, 'YZ12', 'T-04', 'Window seat', 'confirmed'],
  ['Felix', 'Wagner', '+1 415 555 0312', 4, 4, 20, 30, 'AC34', 'T-04', null, 'confirmed'],
  ['Chiamaka', 'Eze', '+1 415 555 0333', 2, 5, 19, 0, 'BD45', 'P-02', null, 'confirmed'],
  ['Chen', 'Wei', '+1 415 555 0344', 4, 1, 20, 0, 'CW10', 'T-04', null, 'cancelled'],
  [
    'Antonio',
    'Russo',
    '+1 415 555 0355',
    2,
    -1,
    19,
    30,
    'AR22',
    'T-02',
    'Anniversary',
    'confirmed',
  ],
];

const DISPUTES: readonly [
  string,
  string,
  string,
  number,
  DisputeCategory,
  string,
  string,
  number,
  string,
][] = [
  [
    'DSP-4K7M',
    'HTL-GH78',
    'Late checkout',
    PRICING.lateCheckout,
    'late_checkout_fee',
    'Front desk said a 1 PM checkout would be fine.',
    'goodwill_waived',
    PRICING.lateCheckout,
    'resolved',
  ],
  [
    'DSP-9X2C',
    'HTL-EF56',
    'Minibar',
    1800,
    'minibar',
    'Says they never opened the minibar.',
    'auto_refunded',
    1800,
    'resolved',
  ],
  [
    'DSP-5R8K',
    'HTL-QT55',
    'Room (3 nights)',
    66000,
    'double_charge_billing_error',
    'Charged twice for the same stay - duplicate on the statement.',
    'auto_refunded',
    66000,
    'resolved',
  ],
  [
    'DSP-7M3X',
    'HTL-JX31',
    'Pet fee',
    5000,
    'damage_cleaning',
    'No pet on the stay, but pet cleaning fee on the invoice.',
    'explained_no_action',
    0,
    'resolved',
  ],
  [
    'DSP-2H6T',
    'HTL-ZP19',
    'Room service',
    8800,
    'room_service_restaurant',
    "Charged for a dinner they didn't order.",
    'escalated_to_manager',
    0,
    'open',
  ],
];

class GetRecordingConsentTask extends voice.AgentTask<
  { consent: boolean; declinedReason?: string },
  UserData
> {
  constructor() {
    super({
      instructions: `${COMMON_INSTRUCTIONS}\n\nYour job right now: get the caller's permission to record the call for quality. The question MUST be phrased so a "yes" answer means "yes, record me".`,
      tools: {
        recordConsent: llm.tool({
          description: "Record the caller's recording-consent answer.",
          parameters: z.object({ consents: z.boolean() }),
          execute: async ({ consents }) => {
            this.complete({ consent: consents });
            return 'recorded';
          },
        }),
        declineConsent: llm.tool({
          description: 'Handles an explicit refusal with a reason.',
          parameters: z.object({ reason: z.string() }),
          execute: async ({ reason }) => {
            this.complete({ consent: false, declinedReason: reason });
            return 'recorded';
          },
        }),
      },
    });
  }

  async onEnter() {
    this.session.generateReply({
      instructions: 'Greet the caller in one short sentence and ask permission to record.',
    });
  }
}

class BookRoomTask extends voice.AgentTask<RoomBooking, UserData> {
  private checkIn?: string;
  private checkOut?: string;
  private guests?: number;
  private roomType?: RoomType;
  private extras: RoomExtra[] = [];
  private smoking = false;
  private firstName?: string;
  private lastName?: string;
  private email?: string;
  private phone?: string;
  private cardLast4?: string;

  constructor(private db: HotelDB) {
    super({
      instructions: `${COMMON_INSTRUCTIONS}\n\nYou're handling a room booking from start to finish. Collect details in whatever order the caller offers them - don't follow a fixed script, and never re-ask something already given. Run setStay before chooseRoom. Before calling confirm, make sure you've collected the stay, the room choice, plus the caller's name, email, phone, and card.`,
      tools: {
        setStay: llm.tool({
          description:
            'Record the stay dates + party size; returns each available room type with rate and view.',
          parameters: z.object({
            checkIn: z.string().describe('Check-in date in ISO YYYY-MM-DD format.'),
            checkOut: z.string().describe('Check-out date in ISO YYYY-MM-DD format.'),
            guests: z.number().int().min(1).max(MAX_PARTY_SIZE),
          }),
          execute: async ({ checkIn, checkOut, guests }) => this.setStay(checkIn, checkOut, guests),
        }),
        chooseRoom: llm.tool({
          description: 'Record the chosen room type, extras, and smoking preference.',
          parameters: z.object({
            roomType: z.enum(ROOM_TYPES),
            extras: z.array(z.enum(ROOM_EXTRAS)),
            smokingRoom: z.boolean().default(false),
          }),
          execute: async ({ roomType, extras, smokingRoom }) =>
            this.chooseRoom(roomType, extras, smokingRoom),
        }),
        recordGuestDetails: llm.tool({
          description:
            "Record the guest's first name, last name, email, and phone after confirming them with the caller.",
          parameters: z.object({
            firstName: z.string(),
            lastName: z.string(),
            email: z.string(),
            phone: z.string(),
          }),
          execute: async ({ firstName, lastName, email, phone }) => {
            Object.assign(this, { firstName, lastName, email, phone });
            return `guest details recorded | ${this.status()}`;
          },
        }),
        recordCard: llm.tool({
          description:
            'Record the card after collecting the card number, expiry, security code, and cardholder name one at a time. Store only the last four digits.',
          parameters: z.object({ cardLast4: z.string().describe('The last four digits only.') }),
          execute: async ({ cardLast4 }) => {
            const digits = cardLast4.replace(/\D/g, '');
            if (digits.length !== 4)
              throw new llm.ToolError('the last 4 digits should be exactly 4 digits');
            this.cardLast4 = digits;
            return `card recorded (ending ${digits}) | ${this.status()}`;
          },
        }),
        confirm: llm.tool({
          description: 'Finalize the booking. All details must already be captured.',
          parameters: z.object({}),
          execute: async () => this.confirm(),
        }),
        giveUp: llm.tool({
          description: 'Caller wants to abandon the booking.',
          parameters: z.object({ reason: z.string() }),
          execute: async ({ reason }) => {
            this.complete(new llm.ToolError(`booking abandoned: ${reason}`));
            return 'booking abandoned';
          },
        }),
      },
    });
  }

  async onEnter() {
    this.session.generateReply({
      instructions:
        "Help the caller book a room. Record anything they've already mentioned - dates, party size, or room type - then ask only for what's still missing.",
    });
  }

  private status(): string {
    if (!this.checkIn)
      return 'no stay yet - ask the caller for dates and party size, then call setStay';
    if (!this.roomType) return 'stay captured - ask which room type, then call chooseRoom';
    if (!(this.firstName && this.lastName && this.email && this.phone)) {
      return 'stay and room captured - next: call recordGuestDetails';
    }
    if (!this.cardLast4) return 'guest details captured - next: call recordCard';
    return 'all required details captured - call confirm() now to finalize the booking';
  }

  private async setStay(checkIn: string, checkOut: string, guests: number): Promise<string> {
    validateDateRange(checkIn, checkOut);
    if (nightsBetween(checkIn, checkOut) > 30) throw new llm.ToolError('the max stay is 30 nights');
    if (compareDate(checkIn, TODAY) < 0) throw new llm.ToolError("check-in can't be in the past");

    const avail = await this.db.listRoomTypesAvailable({ checkIn, checkOut, guests });
    if (!avail.length) {
      return `sold out for ${checkIn} to ${checkOut}, ${guests} guests - dates not recorded; ask for adjacent dates`;
    }

    this.checkIn = checkIn;
    this.checkOut = checkOut;
    this.guests = guests;
    if (this.roomType && !avail.some((a) => a.type === this.roomType)) this.roomType = undefined;
    const options = avail
      .map(
        (a) => `${a.type.replaceAll('_', ' ')} (${speakUsd(a.nightlyRate)}/night, ${a.sampleView})`,
      )
      .join(' | ');
    return `stay recorded (${checkIn} to ${checkOut}, ${guests} guests); options: ${options} | ${this.status()}`;
  }

  private async chooseRoom(
    roomType: RoomType,
    extras: RoomExtra[],
    smokingRoom: boolean,
  ): Promise<string> {
    if (!this.checkIn || !this.checkOut || !this.guests) {
      throw new llm.ToolError('stay dates and guest count not yet recorded');
    }
    const avail = await this.db.listRoomTypesAvailable({
      checkIn: this.checkIn,
      checkOut: this.checkOut,
      guests: this.guests,
      smoking: smokingRoom,
    });
    const chosen = avail.find((a) => a.type === roomType);
    if (!chosen) {
      const kind = smokingRoom ? 'smoking ' : '';
      const offer =
        avail
          .map((a) => a.type)
          .sort()
          .join(', ') || 'nothing for those dates';
      throw new llm.ToolError(`no ${kind}${roomType} available; offer one of: ${offer}`);
    }
    this.roomType = roomType;
    this.extras = cleanExtras(extras);
    this.smoking = smokingRoom;
    const extrasPart = extras.length ? `, extras: ${extras.join(', ')}` : '';
    return `room recorded: ${roomType.replaceAll('_', ' ')}${extrasPart} | ${this.status()}`;
  }

  private async confirm(): Promise<string | undefined> {
    if (
      !this.checkIn ||
      !this.checkOut ||
      !this.guests ||
      !this.roomType ||
      !this.firstName ||
      !this.lastName ||
      !this.email ||
      !this.phone ||
      !this.cardLast4
    ) {
      throw new llm.ToolError(this.status());
    }
    try {
      const booking = await this.db.bookRoom({
        roomType: this.roomType,
        smoking: this.smoking,
        guests: this.guests,
        checkIn: this.checkIn,
        checkOut: this.checkOut,
        firstName: this.firstName,
        lastName: this.lastName,
        email: this.email,
        phone: this.phone,
        cardLast4: this.cardLast4,
        extras: this.extras,
      });
      this.complete(booking);
      return undefined;
    } catch (error) {
      if (error instanceof Unavailable) {
        this.roomType = undefined;
        return "That room just got booked - pick another room or shift the dates; I've kept everything else.";
      }
      throw error;
    }
  }
}

class BookRestaurantTask extends voice.AgentTask<RestaurantReservation, UserData> {
  private date?: string;
  private partySize?: number;
  private time?: string;
  private notes?: string;
  private openTimes = new Set<string>();
  private firstName?: string;
  private lastName?: string;
  private phone?: string;

  constructor(private db: HotelDB) {
    super({
      instructions: `${COMMON_INSTRUCTIONS}\n\nYou're handling a restaurant reservation from start to finish. Collect details in whatever order the caller offers them - don't follow a fixed script, and never re-ask something already given. Run setParty before chooseTime. Before calling confirm, make sure you've collected the date, party, time, and the caller's name and phone.`,
      tools: {
        setParty: llm.tool({
          description: 'Record the date + party size; returns the open time slots for them.',
          parameters: z.object({
            onDate: z.string().describe('Reservation date in ISO YYYY-MM-DD format.'),
            partySize: z.number().int().min(1).max(MAX_PARTY_SIZE),
          }),
          execute: async ({ onDate, partySize }) => this.setParty(onDate, partySize),
        }),
        chooseTime: llm.tool({
          description: 'Record the chosen time slot and any special request.',
          parameters: z.object({
            atTime: z.string().describe('Slot time like 18:30 or 18:30:00.'),
            notes: z.string().nullable().optional(),
          }),
          execute: async ({ atTime, notes }) => this.chooseTime(atTime, notes ?? undefined),
        }),
        recordGuestDetails: llm.tool({
          description: "Record the guest's first name, last name, and phone.",
          parameters: z.object({ firstName: z.string(), lastName: z.string(), phone: z.string() }),
          execute: async ({ firstName, lastName, phone }) => {
            Object.assign(this, { firstName, lastName, phone });
            return `guest details recorded | ${this.status()}`;
          },
        }),
        confirm: llm.tool({
          description: 'Finalize once the date, party, time, and caller details are captured.',
          parameters: z.object({}),
          execute: async () => this.confirm(),
        }),
        giveUp: llm.tool({
          description: 'Caller wants to abandon the reservation.',
          parameters: z.object({ reason: z.string() }),
          execute: async ({ reason }) => {
            this.complete(new llm.ToolError(`reservation abandoned: ${reason}`));
            return 'reservation abandoned';
          },
        }),
      },
    });
  }

  async onEnter() {
    this.session.generateReply({
      instructions:
        "Help the caller book a table. Record anything they've already mentioned - date, party size, or time - then ask only for what's still missing.",
    });
  }

  private status(): string {
    if (!this.date)
      return 'no party yet - ask the caller for date and party size, then call setParty';
    if (!this.time) return 'party captured - ask which time slot, then call chooseTime';
    if (!(this.firstName && this.lastName))
      return 'party and time captured - next: call recordGuestDetails';
    if (!this.phone) return 'name captured - next: call recordGuestDetails';
    return 'all required details captured - call confirm() now to finalize the reservation';
  }

  private async setParty(onDate: string, partySize: number): Promise<string> {
    if (compareDate(onDate, TODAY) < 0) throw new llm.ToolError("the date can't be in the past");
    const slots = await this.db.listRestaurantAvailability({ onDate, partySize });
    const openTimes = new Set(slots.filter((s) => s.availableTableIds.length).map((s) => s.time));
    if (!openTimes.size) {
      return `fully booked on ${formatShortDate(onDate)} for ${partySize} - date not recorded; ask for another date`;
    }
    this.date = onDate;
    this.partySize = partySize;
    this.openTimes = openTimes;
    if (this.time && !openTimes.has(this.time)) this.time = undefined;
    const labels = [...openTimes].sort().map(speakTime).join(', ');
    return `party recorded (${formatShortDate(onDate)}, ${partySize} guests); open times: ${labels} | ${this.status()}`;
  }

  private async chooseTime(atTime: string, notes?: string): Promise<string> {
    if (!this.date) throw new llm.ToolError('date and party size not yet recorded');
    const time = normalizeTime(atTime);
    if (!this.openTimes.has(time)) {
      const labels = [...this.openTimes].sort().map(speakTime).join(', ');
      throw new llm.ToolError(`${speakTime(time)} isn't open; offer one of: ${labels}`);
    }
    this.time = time;
    this.notes = notes;
    const notesPart = notes ? `, notes: ${notes}` : '';
    return `time recorded: ${speakTime(time)}${notesPart} | ${this.status()}`;
  }

  private async confirm(): Promise<string | undefined> {
    if (!this.date || !this.partySize || !this.time || !this.firstName || !this.phone) {
      throw new llm.ToolError(this.status());
    }
    try {
      const reservation = await this.db.bookRestaurant({
        firstName: this.firstName,
        lastName: this.lastName ?? '',
        phone: this.phone,
        partySize: this.partySize,
        onDate: this.date,
        atTime: this.time,
        notes: this.notes,
      });
      this.complete(reservation);
      return undefined;
    } catch (error) {
      if (error instanceof Unavailable) {
        this.time = undefined;
        return "That slot just filled up - pick another time; I've kept your details.";
      }
      throw error;
    }
  }
}

class VerifyBookingTask extends voice.AgentTask<{ booking: RoomBooking }, UserData> {
  private attempts = 0;

  constructor(private db: HotelDB) {
    super({
      instructions: `${COMMON_INSTRUCTIONS}\n\nThe caller wants to look up an existing reservation - verify them first. Default path: ask for last name plus confirmation code. Fallback if they don't have the code: ask for last name plus the last four digits of the card on file.`,
      tools: {
        lookupByCode: llm.tool({
          description: 'Look up a booking by last name + confirmation code.',
          parameters: z.object({ lastName: z.string(), code: z.string() }),
          execute: async ({ lastName, code }) => {
            this.attempts += 1;
            const booking = await this.db.findBooking({
              lastName,
              confirmationCode: code.replaceAll(' ', '').toUpperCase(),
            });
            return this.handle(booking, 'code');
          },
        }),
        lookupByCard: llm.tool({
          description: 'Look up a booking by last name + last 4 digits of the card on file.',
          parameters: z.object({ lastName: z.string(), cardLast4: z.string() }),
          execute: async ({ lastName, cardLast4 }) => {
            this.attempts += 1;
            const digits = cardLast4.replace(/\D/g, '');
            if (digits.length !== 4)
              throw new llm.ToolError('the last 4 digits should be exactly 4 digits');
            const booking = await this.db.findBooking({ lastName, cardLast4: digits });
            return this.handle(booking, 'card');
          },
        }),
        giveUp: llm.tool({
          description: 'Abandon verification after repeated failures.',
          parameters: z.object({ reason: z.string() }),
          execute: async ({ reason }) => {
            this.complete(new llm.ToolError(`couldn't verify the booking: ${reason}`));
            return 'verification abandoned';
          },
        }),
      },
    });
  }

  async onEnter() {
    this.session.generateReply({
      instructions: 'Ask the caller for their last name and their confirmation code.',
    });
  }

  private handle(booking: RoomBooking | undefined, kind: string): string | undefined {
    if (booking && booking.status === 'confirmed') {
      this.complete({ booking });
      return undefined;
    }
    if (this.attempts >= 3) {
      this.complete(
        new llm.ToolError(
          "verification failed after 3 attempts - don't keep trying. Apologize, then call recordFollowup with kind='verification_help' so a manager can follow up.",
        ),
      );
      return undefined;
    }
    if (!booking) {
      return `No booking found via ${kind}. Politely ask the caller to repeat, or offer the other verification path (code vs. card).`;
    }
    return 'That booking was already cancelled. Ask if the caller meant a different reservation.';
  }
}

class ModifyBookingTask extends voice.AgentTask<RoomBooking, UserData> {
  private checkIn: string;
  private checkOut: string;
  private guests: number;
  private roomType: RoomType;
  private extras: RoomExtra[];
  private smoking: boolean;
  private changed = new Set<string>();

  constructor(
    private db: HotelDB,
    private existing: RoomBooking,
  ) {
    super({
      instructions: `${COMMON_INSTRUCTIONS}\n\nYou're modifying an existing room booking. The caller has been verified and the booking is loaded - dates, room, extras, and party size are pre-filled with the current values. Apply ONLY the changes the caller asks for, then call confirm(). Identity fields cannot be changed here.`,
      tools: {
        setStay: llm.tool({
          description: 'Update the stay on the booking being modified. Pass the FULL new stay.',
          parameters: z.object({
            checkIn: z.string(),
            checkOut: z.string(),
            guests: z.number().int().min(1).max(MAX_PARTY_SIZE),
          }),
          execute: async ({ checkIn, checkOut, guests }) => this.setStay(checkIn, checkOut, guests),
        }),
        chooseRoom: llm.tool({
          description:
            'Update the room type, extras, and smoking preference. Pass the FULL new extras list.',
          parameters: z.object({
            roomType: z.enum(ROOM_TYPES),
            extras: z.array(z.enum(ROOM_EXTRAS)),
            smokingRoom: z.boolean().default(false),
          }),
          execute: async ({ roomType, extras, smokingRoom }) =>
            this.chooseRoom(roomType, extras, smokingRoom),
        }),
        confirm: llm.tool({
          description: 'Write the pending changes back to the booking.',
          parameters: z.object({}),
          execute: async () => this.confirm(),
        }),
        giveUp: llm.tool({
          description: 'Caller no longer wants to modify the booking.',
          parameters: z.object({ reason: z.string() }),
          execute: async () => {
            this.complete(this.existing);
            return undefined;
          },
        }),
      },
    });
    this.checkIn = existing.checkIn;
    this.checkOut = existing.checkOut;
    this.guests = existing.guests;
    this.roomType = existing.roomType;
    this.extras = [...existing.extras];
    this.smoking = existing.smoking;
  }

  async onEnter() {
    this.session.generateReply({
      instructions:
        'Read the booking back briefly in one sentence and ask what the caller wants to change.',
    });
  }

  private status(): string {
    if (!this.changed.size) return 'draft unchanged so far - ask the caller what to update';
    return `pending changes: ${[...this.changed].sort().join(', ')} | call confirm() when the caller has nothing else to change`;
  }

  private async setStay(checkIn: string, checkOut: string, guests: number): Promise<string> {
    validateDateRange(checkIn, checkOut);
    if (nightsBetween(checkIn, checkOut) > 30) throw new llm.ToolError('the max stay is 30 nights');
    if (compareDate(checkIn, TODAY) < 0 && checkIn !== this.existing.checkIn) {
      throw new llm.ToolError("check-in can't be in the past");
    }
    const avail = await this.db.listRoomTypesAvailable({
      checkIn,
      checkOut,
      guests,
      smoking: this.smoking,
      excludeBookingCode: this.existing.code,
    });
    if (!avail.length) {
      return `sold out for ${checkIn} to ${checkOut}, ${guests} guests - dates not recorded; ask for adjacent dates`;
    }
    this.checkIn = checkIn;
    this.checkOut = checkOut;
    this.guests = guests;
    this.setChanged(
      'stay',
      [checkIn, checkOut, guests].join('|') !==
        [this.existing.checkIn, this.existing.checkOut, this.existing.guests].join('|'),
    );
    const types = new Set(avail.map((a) => a.type));
    if (!types.has(this.roomType)) {
      const availableList = [...types]
        .sort()
        .map((t) => t.replaceAll('_', ' '))
        .join(', ');
      return `stay updated (${checkIn} to ${checkOut}, ${guests} guests); ${this.roomType.replaceAll('_', ' ')} is no longer available for those dates - offer one of: ${availableList}, then call chooseRoom | ${this.status()}`;
    }
    return `stay updated (${checkIn} to ${checkOut}, ${guests} guests) | ${this.status()}`;
  }

  private async chooseRoom(
    roomType: RoomType,
    extras: RoomExtra[],
    smokingRoom: boolean,
  ): Promise<string> {
    const avail = await this.db.listRoomTypesAvailable({
      checkIn: this.checkIn,
      checkOut: this.checkOut,
      guests: this.guests,
      smoking: smokingRoom,
      excludeBookingCode: this.existing.code,
    });
    if (!avail.some((a) => a.type === roomType)) {
      const kind = smokingRoom ? 'smoking ' : '';
      const offer =
        avail
          .map((a) => a.type)
          .sort()
          .join(', ') || 'nothing for those dates';
      throw new llm.ToolError(`no ${kind}${roomType} available; offer one of: ${offer}`);
    }
    this.roomType = roomType;
    this.extras = cleanExtras(extras);
    this.smoking = smokingRoom;
    this.setChanged('room', roomType !== this.existing.roomType);
    this.setChanged('smoking', smokingRoom !== this.existing.smoking);
    this.setChanged(
      'extras',
      this.extras.sort().join(',') !== [...this.existing.extras].sort().join(','),
    );
    const extrasPart = this.extras.length ? `, extras: ${this.extras.join(', ')}` : ', no extras';
    return `room updated: ${roomType.replaceAll('_', ' ')}${extrasPart} | ${this.status()}`;
  }

  private async confirm(): Promise<string | undefined> {
    if (!this.changed.size) {
      this.complete(this.existing);
      return undefined;
    }
    try {
      const updated = await this.db.updateBooking({
        bookingCode: this.existing.code,
        roomType: this.roomType,
        smoking: this.smoking,
        guests: this.guests,
        checkIn: this.checkIn,
        checkOut: this.checkOut,
        extras: this.extras,
      });
      this.complete(updated);
      return undefined;
    } catch (error) {
      if (error instanceof Unavailable) {
        throw new llm.ToolError(
          `${this.roomType.replaceAll('_', ' ')} just got taken for those dates - pick another room or adjust the dates`,
        );
      }
      throw error;
    }
  }

  private setChanged(slot: string, differs: boolean): void {
    if (differs) this.changed.add(slot);
    else this.changed.delete(slot);
  }
}

class HotelReceptionistAgent extends voice.Agent<UserData> {
  constructor() {
    super({
      instructions: instructions(),
      tools: {
        getHotelInfo: llm.tool({
          description:
            "Return hotel details the receptionist doesn't keep top-of-mind: address, airport and transport, room amenities, accessibility, cribs and rollaways, laundry, lost-and-found, business center.",
          parameters: z.object({}),
          execute: async () => HOTEL_INFO,
        }),
        getRestaurantInfo: llm.tool({
          description:
            'Return restaurant details: menu shape, dietary handling, dress code, private dining, room service, takeout/delivery policy, special-occasion handling.',
          parameters: z.object({}),
          execute: async () => RESTAURANT_INFO,
        }),
        flagLateArrival: llm.tool({
          description: 'Flag a confirmed booking with an expected late-arrival note.',
          parameters: z.object({ note: z.string() }),
          execute: async ({ note }, { ctx }: llm.ToolOptions<UserData>) => {
            const booking = await this.verifiedBooking(ctx);
            await ctx.userData.db.flagLateArrival({ bookingCode: booking.code, note });
            return `Noted on the booking - we'll hold the room. See you at ${note}.`;
          },
        }),
        recordFollowup: llm.tool({
          description:
            "Capture something for a human to follow up on - sales/group leads, identity-field change requests, callback requests, verification-failed callers, in-house early-checkout requests, and any other request you can't handle on this line.",
          parameters: z.object({
            kind: z.enum(FOLLOWUP_KINDS),
            callerName: z.string(),
            callerPhone: z.string(),
            summary: z.string(),
          }),
          execute: async (
            { kind, callerName, callerPhone, summary },
            { ctx }: llm.ToolOptions<UserData>,
          ) => {
            const code = await ctx.userData.db.recordFollowup({
              kind,
              callerName,
              callerPhone,
              summary,
            });
            return `recorded; reference ${speakCode(code)}. The right team will follow up.`;
          },
        }),
        checkRoomAvailability: llm.tool({
          description: 'Check room availability for a date range, with prices and views.',
          parameters: z.object({
            checkIn: z.string(),
            checkOut: z.string(),
            guests: z.number().int().min(1).max(MAX_PARTY_SIZE),
            smoking: z.boolean().nullable().optional(),
            roomType: z.enum(ROOM_TYPES).nullable().optional(),
          }),
          execute: async (
            { checkIn, checkOut, guests, smoking, roomType },
            { ctx }: llm.ToolOptions<UserData>,
          ) => {
            validateDateRange(checkIn, checkOut);
            let avail = await ctx.userData.db.listRoomTypesAvailable({
              checkIn,
              checkOut,
              guests,
              smoking: smoking ?? undefined,
            });
            if (roomType) avail = avail.filter((a) => a.type === roomType);
            if (!avail.length) {
              const kind = smoking === true ? 'smoking ' : smoking === false ? 'non-smoking ' : '';
              const what = roomType ? `${kind}${roomType.replaceAll('_', ' ')}` : `${kind}rooms`;
              return `no ${what} available for those dates`;
            }
            return avail
              .map(
                (a) =>
                  `${a.type.replaceAll('_', ' ')}: ${speakUsd(a.nightlyRate)} per night, ${a.sampleView} view`,
              )
              .join(' | ');
          },
        }),
        startRoomBooking: llm.tool({
          description:
            'Start the room-booking flow. This collects stay, room choice, name, email, phone, and card, then finalizes the reservation.',
          parameters: z.object({}),
          execute: async (_, { ctx }: llm.ToolOptions<UserData>) => {
            const booking = await new BookRoomTask(ctx.userData.db).run();
            ctx.userData.bookedRoomCodes.push(booking.code);
            return `You're booked. Your confirmation code is ${speakCode(booking.code)}. Total is ${speakUsd(booking.total)}, charged to the card ending in ${booking.cardLast4}. A confirmation email is on its way to ${booking.email}.`;
          },
        }),
        checkRestaurantAvailability: llm.tool({
          description: 'Check restaurant time slots for a date.',
          parameters: z.object({
            onDate: z.string(),
            partySize: z.number().int().min(1).max(MAX_PARTY_SIZE),
          }),
          execute: async ({ onDate, partySize }, { ctx }: llm.ToolOptions<UserData>) => {
            const slots = await ctx.userData.db.listRestaurantAvailability({ onDate, partySize });
            const openSlots = slots.filter((s) => s.availableTableIds.length);
            if (!openSlots.length) return `fully booked on ${formatShortDate(onDate)}`;
            return openSlots.map((s) => speakTime(s.time)).join(', ');
          },
        }),
        startRestaurantBooking: llm.tool({
          description:
            'Start the restaurant-reservation flow. This collects date, party size, time, name, and phone, then finalizes the reservation.',
          parameters: z.object({}),
          execute: async (_, { ctx }: llm.ToolOptions<UserData>) => {
            const reservation = await new BookRestaurantTask(ctx.userData.db).run();
            ctx.userData.bookedRestaurantCodes.push(reservation.code);
            return `You're set for ${speakTime(reservation.time)} on ${formatShortDate(reservation.date)} for ${reservation.partySize} guest${reservation.partySize === 1 ? '' : 's'}. Confirmation code: ${speakCode(reservation.code)}.`;
          },
        }),
        lookupRestaurantReservation: llm.tool({
          description: 'Read-only lookup of a confirmed restaurant reservation.',
          parameters: z.object({ lastName: z.string(), confirmationCode: z.string() }),
          execute: async ({ lastName, confirmationCode }, { ctx }: llm.ToolOptions<UserData>) => {
            const reservation = await ctx.userData.db.findRestaurantReservation({
              lastName,
              confirmationCode: confirmationCode.replaceAll(' ', '').toUpperCase(),
            });
            if (!reservation || reservation.status !== 'confirmed') {
              throw new llm.ToolError("Couldn't find a matching confirmed reservation.");
            }
            const notesPart = reservation.notes ? `, note: ${reservation.notes}` : '';
            return `Reservation for ${reservation.firstName} ${reservation.lastName}, ${speakTime(reservation.time)} on ${formatShortDate(reservation.date)}, party of ${reservation.partySize}${notesPart}.`;
          },
        }),
        startBookingModification: llm.tool({
          description: 'Start the booking-modification flow for an existing reservation.',
          parameters: z.object({}),
          execute: async (_, { ctx }: llm.ToolOptions<UserData>) => {
            const booking = await this.verifiedBooking(ctx);
            if (booking.status !== 'confirmed')
              throw new llm.ToolError('that booking was cancelled - nothing to modify');
            if (compareDate(booking.checkOut, TODAY) < 0) {
              throw new llm.ToolError("that stay already ended - can't modify a past booking");
            }
            const updated = await new ModifyBookingTask(ctx.userData.db, booking).run();
            ctx.userData.verifiedBooking = updated;
            if (updated === booking) return 'Booking left unchanged.';
            const delta = updated.total - booking.total;
            const money =
              delta === 0
                ? `total stays at ${speakUsd(updated.total)}`
                : `new total is ${speakUsd(updated.total)}; ${speakUsd(Math.abs(delta))} ${delta > 0 ? 'added to' : 'refunded to'} the card ending in ${updated.cardLast4}`;
            return `Your booking is updated; ${money}.`;
          },
        }),
        lookupBooking: llm.tool({
          description: 'Read-only lookup of a confirmed room booking. Verifies the caller first.',
          parameters: z.object({}),
          execute: async (_, { ctx }: llm.ToolOptions<UserData>) => {
            const b = await this.verifiedBooking(ctx);
            const nights = nightsBetween(b.checkIn, b.checkOut);
            const extras = b.extras.length ? b.extras.join(', ') : 'no extras';
            const smoking = b.smoking ? 'smoking-permitted' : 'non-smoking';
            return `Booking for ${b.firstName} ${b.lastName}, ${b.roomType.replaceAll('_', ' ')} (${smoking}), checking in ${formatShortDate(b.checkIn)} and out ${formatShortDate(b.checkOut)} (${nights} night${nights === 1 ? '' : 's'}, ${b.guests} guest${b.guests === 1 ? '' : 's'}), extras: ${extras}. Total ${speakUsd(b.total)} on card ending in ${b.cardLast4}.`;
          },
        }),
        cancelRoomBooking: llm.tool({
          description: 'Cancel a room booking after verifying the caller.',
          parameters: z.object({}),
          execute: async (_, { ctx }: llm.ToolOptions<UserData>) => {
            const booking = await this.verifiedBooking(ctx);
            if (compareDate(booking.checkIn, TODAY) < 0) {
              throw new llm.ToolError(
                "this booking's check-in has already passed; can't cancel a past stay",
              );
            }
            const within =
              daysBetween(TODAY, booking.checkIn) * 24 < PRICING.cancellationWindowHours;
            const forfeit = within ? booking.nightlyRate : 0;
            await ctx.userData.db.cancelRoomBooking(booking.code);
            ctx.userData.cancelledCodes.push(booking.code);
            ctx.userData.verifiedBooking = undefined;
            if (within) {
              return `Cancelled. Because the booking's inside the ${PRICING.cancellationWindowHours}-hour window, one room-night (${speakUsd(forfeit)}) is forfeited; I'll refund ${speakUsd(booking.total - forfeit)} to the card on file.`;
            }
            return `Cancelled. I'll refund the full ${speakUsd(booking.total)} to the card on file - usually two to five business days.`;
          },
        }),
        cancelRestaurantReservation: llm.tool({
          description: 'Cancel a restaurant reservation by last name + confirmation code.',
          parameters: z.object({ lastName: z.string(), confirmationCode: z.string() }),
          execute: async ({ lastName, confirmationCode }, { ctx }: llm.ToolOptions<UserData>) => {
            const reservation = await ctx.userData.db.findRestaurantReservation({
              lastName,
              confirmationCode: confirmationCode.replaceAll(' ', '').toUpperCase(),
            });
            if (!reservation || reservation.status !== 'confirmed') {
              throw new llm.ToolError("Couldn't find a matching confirmed reservation.");
            }
            await ctx.userData.db.cancelRestaurantReservation(reservation.code);
            ctx.userData.cancelledCodes.push(reservation.code);
            return `Reservation for ${speakTime(reservation.time)} on ${formatShortDate(reservation.date)} cancelled.`;
          },
        }),
        lookupInvoice: llm.tool({
          description: 'Verify the caller, fetch their invoice, and read it back.',
          parameters: z.object({}),
          execute: async (_, { ctx }: llm.ToolOptions<UserData>) => {
            const booking = await this.verifiedBooking(ctx);
            const invoice = await ctx.userData.db.getInvoice(booking.code);
            const items = invoice.lineItems
              .map((li) => `${li.label} ${speakUsd(li.amountCents)}`)
              .join(', ');
            return `That booking's total is ${speakUsd(invoice.total)}, with line items: ${items}. I've emailed a copy to ${booking.email}.`;
          },
        }),
        disputeCharge: llm.tool({
          description: 'Handle a guest dispute on a line item.',
          parameters: z.object({
            category: z.enum(DISPUTE_CATEGORIES),
            lineItemLabel: z.string(),
            callerNote: z.string(),
            acceptsOfferedResolution: z.boolean(),
          }),
          execute: async (
            { category, lineItemLabel, callerNote, acceptsOfferedResolution },
            { ctx }: llm.ToolOptions<UserData>,
          ) => {
            const policy = DISPUTE_POLICIES[category];
            const booking = await this.verifiedBooking(ctx);
            const invoice = await ctx.userData.db.getInvoice(booking.code);
            const item = invoice.lineItems.find(
              (li) => li.label.toLocaleLowerCase() === lineItemLabel.toLocaleLowerCase(),
            );
            if (!item) {
              throw new llm.ToolError(
                `No line item labelled ${lineItemLabel} on that invoice. Read the line items back and ask the caller to pick one.`,
              );
            }
            const [outcome, refund] = resolveDisputeOutcome({
              policy,
              amountCents: item.amountCents,
              lineItemLabel: item.label,
              invoiceLineItems: invoice.lineItems,
              accepts: acceptsOfferedResolution,
            });
            const caseNumber = await ctx.userData.db.fileDispute({
              bookingCode: booking.code,
              lineItem: item.label,
              amountCents: item.amountCents,
              category,
              callerNote,
              outcome,
              refundAmount: refund,
            });
            return sayDisputeOutcome({
              outcome,
              refund,
              caseNumber,
              lineItem: item.label,
              escalation: policy.escalation,
              policyExplanation: policy.explanation,
            });
          },
        }),
      },
    });
  }

  async onEnter() {
    const consent = await new GetRecordingConsentTask().run();
    this.session.userData.consent = consent.consent;
    const ack = consent.consent
      ? 'Briefly confirm the call will be recorded.'
      : "Briefly confirm the call won't be recorded.";
    this.session.generateReply({
      instructions: `${ack} Then continue from whatever the caller has already said: if they've named a need, move straight into helping; otherwise welcome them and ask how you can help.`,
    });
  }

  private async verifiedBooking(ctx: voice.RunContext<UserData>): Promise<RoomBooking> {
    if (!ctx.userData.verifiedBooking) {
      const verify = await new VerifyBookingTask(ctx.userData.db).run();
      ctx.userData.verifiedBooking = verify.booking;
    }
    return ctx.userData.verifiedBooking;
  }
}

function instructions(): string {
  return `${COMMON_INSTRUCTIONS}

You're the lead receptionist, holding the whole call and routing each request to the right tool. Help the caller with whatever they bring - if a request fits a tool, run it; if it's general, answer from what you know.

# Quick facts (answer directly - no tool call needed)
- Check-in 3 PM, check-out 11 AM. Late checkout until 2 PM is ${formatUsd(PRICING.lateCheckout)}, subject to availability. Early check-in is on a same-day, ask-housekeeping basis.
- Late arrival is fine; the room is held all night as long as the booking is confirmed. ID at check-in: a government-issued photo ID.
- Pets: pet-friendly rooms only, ${formatUsd(PRICING.petFee)} per stay. Service animals always welcome at no charge.
- Smoking: smoking-permitted rooms on request; ${formatUsd(PRICING.smokingCleaningFee)} cleaning fee for smoking in a non-smoking room.
- Self-parking free; valet ${formatUsd(PRICING.valetPerNight)} per night.
- Wi-Fi free. Pool, gym, sauna 6 AM to 10 PM, towels provided, free for guests.
- Cancellation: free up to ${PRICING.cancellationWindowHours} hours before check-in; inside that window, one night is forfeited. Tax is ${PRICING.taxRatePct}% on room and extras.
- Breakfast buffet in the restaurant, 6:30 to 10:30 AM, ${formatUsd(PRICING.breakfastPerNight)} a night when added as a room extra.
- Restaurant: on-site, dinner only, 5:30 to 9 PM last seating.
- Luggage hold at the front desk before check-in and after check-out, no charge.

# Routing the call
- Browse without booking: checkRoomAvailability, checkRestaurantAvailability, lookupBooking, lookupRestaurantReservation.
- Caller wants to book: startRoomBooking or startRestaurantBooking.
- Existing booking changes: startBookingModification. Cancel via cancelRoomBooking. Late arrival -> flagLateArrival.
- Existing restaurant reservation: change isn't supported directly - with permission, cancel the old one and book a new slot.
- Sold out: offer adjacent dates or another room type. One tool call per turn; finish each tool's flow before starting another.
- Detail beyond the quick facts: getHotelInfo or getRestaurantInfo.

# Things you can't book directly - use recordFollowup
Never say "someone will follow up" without making this tool call.
- Group bookings, events, weddings, corporate rates -> kind="sales_lead".
- Changes to identity fields on an existing booking -> kind="identity_change".
- "Call me back later" / "I'll think about it" -> kind="callback".
- Verification failed three times -> kind="verification_help".
- In-house guest wants to check out early -> kind="early_checkout".
- Anything else outside what your tools cover -> kind="other".

# Before you confirm a new booking
Before calling confirm() inside startRoomBooking, read the whole booking back to the caller in one short sentence. Same idea for restaurant.

# Never invent a confirmation
A booking, reservation, cancellation, refund, modification, or invoice lookup is only real if a tool just returned it.`;
}

function computeInvoice(options: {
  nightlyRate: number;
  nights: number;
  extras: readonly RoomExtra[];
}): { subtotal: number; taxes: number; total: number; lineItems: LineItem[] } {
  const roomSubtotal = options.nightlyRate * options.nights;
  const subtotal = roomSubtotal + extrasTotal(options.extras, options.nights);
  const taxes = applyTax(subtotal);
  return {
    subtotal,
    taxes,
    total: subtotal + taxes,
    lineItems: invoiceLineItems({
      nights: options.nights,
      roomSubtotal,
      extras: options.extras,
      tax: taxes,
    }),
  };
}

function invoiceLineItems(options: {
  nights: number;
  roomSubtotal: number;
  extras: readonly RoomExtra[];
  tax: number;
}): LineItem[] {
  const items: LineItem[] = [
    { label: `Room (${options.nights} nights)`, amountCents: options.roomSubtotal },
  ];
  if (options.extras.includes('breakfast')) {
    items.push({
      label: `Breakfast (${options.nights} nights)`,
      amountCents: PRICING.breakfastPerNight * options.nights,
    });
  }
  if (options.extras.includes('valet')) {
    items.push({
      label: `Valet (${options.nights} nights)`,
      amountCents: PRICING.valetPerNight * options.nights,
    });
  }
  if (options.extras.includes('late_checkout')) {
    items.push({ label: 'Late checkout', amountCents: PRICING.lateCheckout });
  }
  if (options.extras.includes('pets')) {
    items.push({ label: 'Pet fee', amountCents: PRICING.petFee });
  }
  items.push({ label: `Tax (${PRICING.taxRatePct}%)`, amountCents: options.tax });
  return items;
}

function extrasTotal(extras: readonly RoomExtra[], nights: number): number {
  let total = 0;
  if (extras.includes('breakfast')) total += PRICING.breakfastPerNight * nights;
  if (extras.includes('valet')) total += PRICING.valetPerNight * nights;
  if (extras.includes('late_checkout')) total += PRICING.lateCheckout;
  if (extras.includes('pets')) total += PRICING.petFee;
  return total;
}

function applyTax(amountCents: number): number {
  return Math.floor((amountCents * PRICING.taxRatePct) / 100);
}

function formatUsd(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function speakUsd(cents: number): string {
  const [dollars, change] = [Math.floor(Math.abs(cents) / 100), Math.abs(cents) % 100];
  if (change === 0) return `${dollars} dollars`;
  return `${dollars} dollars and ${change} cents`;
}

function speakTime(value: string): string {
  const [hourPart, minutePart] = normalizeTime(value).split(':');
  const hour = Number(hourPart);
  const minute = Number(minutePart);
  const clockHour = hour % 12 || 12;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  return minute === 0
    ? `${clockHour} ${suffix}`
    : `${clockHour}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function speakCode(code: string): string {
  return code.replace('-', ' dash ').toUpperCase().split('').join(', ');
}

function cleanExtras(extras: readonly RoomExtra[]): RoomExtra[] {
  return [...new Set(extras.filter((extra) => ROOM_EXTRAS.includes(extra)))].sort();
}

function shortUuid(prefix: string): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 4; i += 1) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `${prefix}${suffix}`;
}

function normalizeTime(time: string): string {
  const parts = time.split(':');
  const hour = Number(parts[0]);
  const minute = Number(parts[1] ?? 0);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
}

function parseUtcDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function addDays(date: string, days: number): string {
  const d = parseUtcDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function compareDate(left: string, right: string): number {
  return left.localeCompare(right);
}

function daysBetween(start: string, end: string): number {
  return Math.round((parseUtcDate(end).getTime() - parseUtcDate(start).getTime()) / 86_400_000);
}

function nightsBetween(checkIn: string, checkOut: string): number {
  return daysBetween(checkIn, checkOut);
}

function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return !(compareDate(aEnd, bStart) <= 0 || compareDate(aStart, bEnd) >= 0);
}

function validateDateRange(checkIn: string, checkOut: string): void {
  if (compareDate(checkOut, checkIn) <= 0)
    throw new llm.ToolError('check-out must be after check-in');
}

function formatLongDate(date: string): string {
  return parseUtcDate(date).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatShortDate(date: string): string {
  return parseUtcDate(date).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function eqFold(left: string, right: string): boolean {
  return left.toLocaleLowerCase() === right.toLocaleLowerCase();
}

function resolveDisputeOutcome(options: {
  policy: DisputePolicy;
  amountCents: number;
  lineItemLabel: string;
  invoiceLineItems: LineItem[];
  accepts: boolean;
}): [string, number] {
  switch (options.policy.action) {
    case 'auto_refund_if_under_threshold':
      if (options.amountCents <= PRICING.minibarAutoRefundThreshold) {
        return ['auto_refunded', options.amountCents];
      }
      return options.accepts
        ? ['credit_offered', options.amountCents]
        : ['escalated_to_manager', 0];
    case 'verify_explain_then_offer_credit':
      return options.accepts
        ? ['credit_offered', options.amountCents]
        : ['escalated_to_manager', 0];
    case 'explain_no_refund':
      return options.accepts ? ['explained_no_action', 0] : ['escalated_to_manager', 0];
    case 'explain_policy_offer_goodwill':
      return options.accepts
        ? ['goodwill_waived', options.amountCents]
        : ['escalated_to_manager', 0];
    case 'correct_immediately_or_open_ticket': {
      const same = options.invoiceLineItems.filter(
        (li) => li.label === options.lineItemLabel && li.amountCents === options.amountCents,
      ).length;
      return same > 1 ? ['auto_refunded', options.amountCents] : ['accounting_ticket_opened', 0];
    }
    default:
      return ['open', 0];
  }
}

function sayDisputeOutcome(options: {
  outcome: string;
  refund: number;
  caseNumber: string;
  lineItem: string;
  escalation: string;
  policyExplanation: string;
}): string {
  switch (options.outcome) {
    case 'auto_refunded':
      return `I've removed the ${options.lineItem} charge - that's ${speakUsd(options.refund)} back to the card. Case number ${speakCode(options.caseNumber)} if you need to reference it.`;
    case 'credit_offered':
      return `Applied a ${speakUsd(options.refund)} credit toward the ${options.lineItem}. Case number ${speakCode(options.caseNumber)}.`;
    case 'goodwill_waived':
      return `Waived as a one-time courtesy - ${speakUsd(options.refund)} back to the card. Case number ${speakCode(options.caseNumber)}.`;
    case 'explained_no_action':
      return options.policyExplanation;
    case 'escalated_to_manager':
      return `I've escalated this to the ${options.escalation} - they'll review and follow up by email. Your case number is ${speakCode(options.caseNumber)}.`;
    case 'accounting_ticket_opened':
      return `I've opened an accounting ticket. They'll investigate and email you within two business days. Case number ${speakCode(options.caseNumber)}.`;
    default:
      return `Logged. Case number ${speakCode(options.caseNumber)}.`;
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const userdata: UserData = {
      db: HotelDB.seeded(TODAY),
      bookedRoomCodes: [],
      bookedRestaurantCodes: [],
      cancelledCodes: [],
    };

    const session = new voice.AgentSession<UserData>({
      vad: ctx.proc.userData.vad! as silero.VAD,
      stt: new inference.STT({ model: 'deepgram/nova-3' }),
      llm: new inference.LLM({ model: 'google/gemini-2.5-flash' }),
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '39b376fc-488e-4d0c-8b37-e00b72059fdd',
      }),
      turnHandling: {
        turnDetection: new livekit.turnDetector.MultilingualModel(),
      },
      userData: userdata,
      voiceOptions: {
        maxToolSteps: 5,
      },
    });

    await session.start({ agent: new HotelReceptionistAgent(), room: ctx.room });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
