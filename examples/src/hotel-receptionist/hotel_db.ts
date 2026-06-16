// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { randomInt } from 'node:crypto';

export const TODAY = process.env.HOTEL_TODAY ?? new Date().toISOString().slice(0, 10);
export const MAX_PARTY_SIZE = 6;

export const PRICING = {
  breakfastPerNight: 2500,
  valetPerNight: 3500,
  lateCheckout: 4000,
  petFee: 5000,
  smokingCleaningFee: 25000,
  taxRatePct: 12,
  cancellationWindowHours: 48,
  cancellationForfeitNights: 1,
} as const;

export const ROOM_TYPES = ['queen_2beds', 'king', 'double_queen', 'suite', 'penthouse'] as const;
export const ROOM_EXTRAS = ['breakfast', 'valet', 'late_checkout', 'pets'] as const;
export const FOLLOWUP_KINDS = [
  'housekeeping',
  'sales_lead',
  'identity_change',
  'callback',
  'verification_help',
  'early_checkout',
  'abandoned_booking',
  'other',
] as const;
export const GROUP_SHARE_TYPES = ['twin', 'double', 'single', 'mixed'] as const;
export const TOUR_IDS = ['half_day_city', 'full_day_city', 'private_city'] as const;

export type RoomType = (typeof ROOM_TYPES)[number];
export type RoomExtra = (typeof ROOM_EXTRAS)[number];
export type FollowupKind = (typeof FOLLOWUP_KINDS)[number];
export type GroupShareType = (typeof GROUP_SHARE_TYPES)[number];
export type TourId = (typeof TOUR_IDS)[number];

type BookingStatus = 'confirmed' | 'cancelled';

export type Room = {
  id: string;
  roomNumber: string;
  type: RoomType;
  view: 'city' | 'garden' | 'ocean';
  capacity: number;
  smoking: boolean;
  nightlyRate: number;
};

export type RoomTypeAvailability = {
  type: RoomType;
  nightlyRate: number;
  views: string[];
};

export type RoomBooking = {
  code: string;
  roomId: string;
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
  doubleBooked?: boolean;
};

export type RestaurantReservation = {
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
};

export type TimeSlot = {
  time: string;
  availableTableIds: number[];
};

export type Invoice = {
  bookingCode: string;
  lineItems: { label: string; amountCents: number }[];
  subtotal: number;
  taxes: number;
  total: number;
  paid: boolean;
};

export type ConflictResolution =
  | { movedTo: string; movedToType: RoomType; movedToView: string; upgraded: boolean }
  | { walkPartner: string; walkReturnDate: string };

export class Unavailable extends Error {}
export class NotFound extends Error {}

export function formatUsd(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function speakUsd(cents: number): string {
  const dollars = Math.floor(Math.abs(cents) / 100);
  const change = Math.abs(cents) % 100;
  return change === 0 ? `${dollars} dollars` : `${dollars} dollars and ${change} cents`;
}

export function speakTime(time: string): string {
  const [hourRaw, minute = '00'] = time.split(':');
  const hour = Number(hourRaw);
  const displayHour = hour % 12 || 12;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  return minute === '00' ? `${displayHour} ${suffix}` : `${displayHour}:${minute} ${suffix}`;
}

export function speakCode(code: string): string {
  return code.replace('-', ', dash, ').split('').join(', ');
}

export function normalizeCode(code: string): string {
  return code.replace(/\s/g, '').toUpperCase();
}

export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

function nights(checkIn: string, checkOut: string): number {
  return Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000);
}

function extrasTotal(extras: RoomExtra[], stayNights: number): number {
  let total = 0;
  if (extras.includes('breakfast')) total += PRICING.breakfastPerNight * stayNights;
  if (extras.includes('valet')) total += PRICING.valetPerNight * stayNights;
  if (extras.includes('late_checkout')) total += PRICING.lateCheckout;
  if (extras.includes('pets')) total += PRICING.petFee;
  return total;
}

function computeInvoice(
  room: Room,
  checkIn: string,
  checkOut: string,
  extras: RoomExtra[],
): Invoice {
  const stayNights = nights(checkIn, checkOut);
  const roomSubtotal = room.nightlyRate * stayNights;
  const extrasSubtotal = extrasTotal(extras, stayNights);
  const subtotal = roomSubtotal + extrasSubtotal;
  const taxes = Math.floor((subtotal * PRICING.taxRatePct) / 100);
  const lineItems = [{ label: `Room (${stayNights} nights)`, amountCents: roomSubtotal }];
  if (extras.includes('breakfast')) {
    lineItems.push({
      label: `Breakfast (${stayNights} nights)`,
      amountCents: PRICING.breakfastPerNight * stayNights,
    });
  }
  if (extras.includes('valet')) {
    lineItems.push({
      label: `Valet (${stayNights} nights)`,
      amountCents: PRICING.valetPerNight * stayNights,
    });
  }
  if (extras.includes('late_checkout'))
    lineItems.push({ label: 'Late checkout', amountCents: PRICING.lateCheckout });
  if (extras.includes('pets')) lineItems.push({ label: 'Pet fee', amountCents: PRICING.petFee });
  lineItems.push({ label: `Tax (${PRICING.taxRatePct}%)`, amountCents: taxes });
  return { bookingCode: '', lineItems, subtotal, taxes, total: subtotal + taxes, paid: true };
}

function overlaps(aIn: string, aOut: string, bIn: string, bOut: string): boolean {
  return aIn < bOut && bIn < aOut;
}

function makeCode(prefix: string): string {
  return `${prefix}-${randomInt(0, 36 ** 4)
    .toString(36)
    .padStart(4, '0')
    .toUpperCase()}`;
}

const ROOM_RANK: Record<RoomType, number> = {
  queen_2beds: 1,
  king: 2,
  double_queen: 3,
  suite: 4,
  penthouse: 5,
};

const TOURS: Record<
  TourId,
  {
    name: string;
    pickupTime: string;
    pricePerPerson?: number;
    flatPrice?: number;
    maxParty: number;
  }
> = {
  half_day_city: {
    name: 'Half-day city highlights',
    pickupTime: '09:00',
    pricePerPerson: 6500,
    maxParty: 12,
  },
  full_day_city: {
    name: 'Full-day city and bay',
    pickupTime: '08:30',
    pricePerPerson: 11000,
    maxParty: 12,
  },
  private_city: {
    name: 'Private half-day tour',
    pickupTime: '10:00',
    flatPrice: 29000,
    maxParty: 4,
  },
};

const ROOMS: Room[] = [
  {
    id: 'RM_201',
    roomNumber: '201',
    type: 'king',
    view: 'city',
    capacity: 2,
    smoking: false,
    nightlyRate: 24000,
  },
  {
    id: 'RM_202',
    roomNumber: '202',
    type: 'king',
    view: 'ocean',
    capacity: 2,
    smoking: false,
    nightlyRate: 26000,
  },
  {
    id: 'RM_203',
    roomNumber: '203',
    type: 'king',
    view: 'city',
    capacity: 2,
    smoking: true,
    nightlyRate: 24000,
  },
  {
    id: 'RM_204',
    roomNumber: '204',
    type: 'queen_2beds',
    view: 'city',
    capacity: 2,
    smoking: false,
    nightlyRate: 22000,
  },
  {
    id: 'RM_205',
    roomNumber: '205',
    type: 'queen_2beds',
    view: 'garden',
    capacity: 2,
    smoking: false,
    nightlyRate: 22000,
  },
  {
    id: 'RM_301',
    roomNumber: '301',
    type: 'double_queen',
    view: 'garden',
    capacity: 4,
    smoking: false,
    nightlyRate: 26000,
  },
  {
    id: 'RM_302',
    roomNumber: '302',
    type: 'double_queen',
    view: 'city',
    capacity: 4,
    smoking: false,
    nightlyRate: 26000,
  },
  {
    id: 'RM_401',
    roomNumber: '401',
    type: 'suite',
    view: 'ocean',
    capacity: 4,
    smoking: false,
    nightlyRate: 42000,
  },
  {
    id: 'RM_402',
    roomNumber: '402',
    type: 'suite',
    view: 'garden',
    capacity: 4,
    smoking: false,
    nightlyRate: 40000,
  },
  {
    id: 'RM_501',
    roomNumber: '501',
    type: 'penthouse',
    view: 'ocean',
    capacity: 6,
    smoking: false,
    nightlyRate: 90000,
  },
];

const RESTAURANT_TABLES = [
  { id: 1, capacity: 2 },
  { id: 2, capacity: 2 },
  { id: 3, capacity: 4 },
  { id: 4, capacity: 6 },
];

const DINING_TIMES = ['17:30', '18:00', '18:30', '19:00', '19:30', '20:00', '20:30', '21:00'];

export class HotelDB {
  private rooms = ROOMS.map((room) => ({ ...room }));
  private bookings: RoomBooking[] = [];
  private restaurantReservations: RestaurantReservation[] = [];
  private invoices = new Map<string, Invoice>();

  constructor() {
    this.seed();
  }

  listRoomTypesAvailable(args: {
    checkIn: string;
    checkOut: string;
    guests: number;
    smoking?: boolean;
    excludeBookingCode?: string;
  }): RoomTypeAvailability[] {
    const free = this.freeRooms(args);
    const byType = new Map<RoomType, Room[]>();
    for (const room of free) {
      const existing = byType.get(room.type) ?? [];
      existing.push(room);
      byType.set(room.type, existing);
    }
    return [...byType.entries()]
      .map(([type, rooms]) => ({
        type,
        nightlyRate: Math.min(...rooms.map((room) => room.nightlyRate)),
        views: [...new Set(rooms.map((room) => room.view))].sort(),
      }))
      .sort((a, b) => a.nightlyRate - b.nightlyRate);
  }

  listRestaurantAvailability(args: { date: string; partySize: number }): TimeSlot[] {
    return DINING_TIMES.map((time) => ({
      time,
      availableTableIds: this.freeTables(args.date, time, args.partySize).map((table) => table.id),
    }));
  }

  findBooking(args: {
    lastName: string;
    confirmationCode?: string;
    cardLast4?: string;
  }): RoomBooking | undefined {
    const code = args.confirmationCode ? normalizeCode(args.confirmationCode) : undefined;
    const last = args.lastName.trim().toLowerCase();
    return this.bookings.find((booking) => {
      if (booking.lastName.toLowerCase() !== last) return false;
      if (code) return booking.code === code;
      if (args.cardLast4) return booking.cardLast4 === args.cardLast4.replace(/\D/g, '');
      return false;
    });
  }

  lookupBookingByCode(code: string): RoomBooking | undefined {
    return this.bookings.find((booking) => booking.code === normalizeCode(code));
  }

  findRestaurantReservation(args: {
    lastName: string;
    confirmationCode?: string;
    date?: string;
  }): RestaurantReservation | undefined {
    const code = args.confirmationCode ? normalizeCode(args.confirmationCode) : undefined;
    const last = args.lastName.trim().toLowerCase();
    return this.restaurantReservations.find((reservation) => {
      if (reservation.lastName.toLowerCase() !== last) return false;
      if (code) return reservation.code === code;
      if (args.date) return reservation.date === args.date;
      return false;
    });
  }

  getRoom(roomId: string): Room {
    const room = this.rooms.find((candidate) => candidate.id === roomId);
    if (!room) throw new NotFound(`room not found: ${roomId}`);
    return room;
  }

  getInvoice(bookingCode: string): Invoice {
    const invoice = this.invoices.get(normalizeCode(bookingCode));
    if (!invoice) throw new NotFound(`no invoice for ${bookingCode}`);
    return invoice;
  }

  peekStayTotal(args: {
    roomType: RoomType;
    guests: number;
    smoking: boolean;
    checkIn: string;
    checkOut: string;
    view?: string;
    extras: RoomExtra[];
  }): number {
    const room = this.pickRoom(args);
    return computeInvoice(room, args.checkIn, args.checkOut, args.extras).total;
  }

  bookRoom(args: {
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
    view?: string;
  }): RoomBooking {
    const room = this.pickRoom(args);
    const invoice = computeInvoice(room, args.checkIn, args.checkOut, args.extras);
    const code = makeCode('HTL');
    const booking: RoomBooking = {
      code,
      roomId: room.id,
      firstName: args.firstName.trim(),
      lastName: args.lastName.trim(),
      email: args.email.trim().toLowerCase(),
      phone: normalizePhone(args.phone),
      checkIn: args.checkIn,
      checkOut: args.checkOut,
      guests: args.guests,
      extras: [...new Set(args.extras)].sort(),
      total: invoice.total,
      cardLast4: args.cardLast4.replace(/\D/g, '').slice(-4),
      status: 'confirmed',
    };
    this.bookings.push(booking);
    this.invoices.set(code, { ...invoice, bookingCode: code });
    return booking;
  }

  updateBooking(args: {
    bookingCode: string;
    roomType: RoomType;
    smoking: boolean;
    guests: number;
    checkIn: string;
    checkOut: string;
    extras: RoomExtra[];
  }): RoomBooking {
    const booking = this.lookupBookingByCode(args.bookingCode);
    if (!booking || booking.status !== 'confirmed')
      throw new NotFound(`booking not found: ${args.bookingCode}`);
    const currentRoom = this.getRoom(booking.roomId);
    const room = this.pickRoom({
      ...args,
      view: currentRoom.view,
      excludeBookingCode: booking.code,
    });
    const invoice = computeInvoice(room, args.checkIn, args.checkOut, args.extras);
    booking.roomId = room.id;
    booking.guests = args.guests;
    booking.checkIn = args.checkIn;
    booking.checkOut = args.checkOut;
    booking.extras = [...new Set(args.extras)].sort();
    booking.total = invoice.total;
    this.invoices.set(booking.code, { ...invoice, bookingCode: booking.code });
    return booking;
  }

  cancelRoomBooking(code: string): number {
    const booking = this.lookupBookingByCode(code);
    if (!booking || booking.status !== 'confirmed')
      throw new NotFound(`booking not found: ${code}`);
    booking.status = 'cancelled';
    return this.refundAmount(booking);
  }

  updateBookingCard(args: { bookingCode: string; cardLast4: string }): void {
    const booking = this.lookupBookingByCode(args.bookingCode);
    if (!booking || booking.status !== 'confirmed')
      throw new NotFound(`booking not found: ${args.bookingCode}`);
    booking.cardLast4 = args.cardLast4.replace(/\D/g, '').slice(-4);
  }

  flagLateArrival(args: { bookingCode: string; note: string }): void {
    const booking = this.lookupBookingByCode(args.bookingCode);
    if (!booking || booking.status !== 'confirmed')
      throw new NotFound(`booking not found: ${args.bookingCode}`);
    booking.lateArrivalNote = args.note;
  }

  bookRestaurant(args: {
    firstName: string;
    lastName: string;
    phone: string;
    partySize: number;
    date: string;
    time: string;
    notes?: string;
  }): RestaurantReservation {
    const table = this.freeTables(args.date, args.time, args.partySize)[0];
    if (!table) throw new Unavailable(`restaurant full: ${args.date} ${args.time}`);
    const reservation: RestaurantReservation = {
      code: makeCode('RES'),
      tableId: table.id,
      firstName: args.firstName.trim(),
      lastName: args.lastName.trim(),
      phone: normalizePhone(args.phone),
      partySize: args.partySize,
      date: args.date,
      time: args.time,
      notes: args.notes,
      status: 'confirmed',
    };
    this.restaurantReservations.push(reservation);
    return reservation;
  }

  cancelRestaurantReservation(code: string): void {
    const reservation = this.restaurantReservations.find(
      (candidate) => candidate.code === normalizeCode(code),
    );
    if (!reservation || reservation.status !== 'confirmed')
      throw new NotFound(`reservation not found: ${code}`);
    reservation.status = 'cancelled';
  }

  recordFollowup(args: {
    kind: FollowupKind;
    callerName: string;
    callerPhone: string;
    summary: string;
  }): string {
    return makeCode('FUP');
  }

  recordGroupInquiry(args: {
    company: string;
    contactName: string;
    contactPhone: string;
    partySize: number;
    shareType: GroupShareType;
    checkIn: string;
    nights: number;
  }): string {
    return makeCode('GRP');
  }

  scheduleWakeupCall(args: {
    room: string;
    guestName: string;
    date: string;
    time: string;
  }): string {
    const room = this.rooms.find(
      (candidate) => candidate.roomNumber === args.room || candidate.id === args.room,
    );
    if (!room) throw new NotFound(`no room ${args.room}`);
    if (args.date < TODAY) throw new Unavailable('wake-up call date is in the past');
    return makeCode('WAK');
  }

  dispatchEmergency(args: { room: string; situation: string }): string {
    const room = this.rooms.find(
      (candidate) => candidate.roomNumber === args.room || candidate.id === args.room,
    );
    if (!room) throw new NotFound(`no room ${args.room}`);
    return makeCode('EMG');
  }

  takeGuestMessage(args: {
    recipient: string;
    callerName: string;
    callerPhone: string;
    message: string;
  }): string {
    return makeCode('MSG');
  }

  bookTour(args: {
    tourId: TourId;
    guestName: string;
    guestPhone: string;
    date: string;
    partySize: number;
  }): { code: string; total: number; pickupTime: string } {
    const tour = TOURS[args.tourId];
    if (args.partySize > tour.maxParty)
      throw new Unavailable(`${tour.name} is limited to ${tour.maxParty} guests`);
    const total = tour.flatPrice ?? (tour.pricePerPerson ?? 0) * args.partySize;
    return { code: makeCode('TOUR'), total, pickupTime: tour.pickupTime };
  }

  requestFlightReconfirmation(args: {
    room: string;
    airline: string;
    flightNumber: string;
    flightDate: string;
    bookingReference: string;
    seatCheck?: boolean;
  }): string {
    return makeCode('FLT');
  }

  bookAirportCar(args: {
    room: string;
    pickupDate: string;
    pickupTime: string;
    passengers: number;
  }): string {
    if (args.passengers > 4)
      throw new Unavailable('hotel car seats up to four guests with luggage');
    return makeCode('CAR');
  }

  resolveRoomConflict(bookingCode: string): ConflictResolution {
    const booking = this.lookupBookingByCode(bookingCode);
    if (!booking || booking.status !== 'confirmed')
      throw new NotFound(`booking not found: ${bookingCode}`);
    const currentRoom = this.getRoom(booking.roomId);
    const freeRooms = this.freeRooms({
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      guests: booking.guests,
      excludeBookingCode: booking.code,
    }).filter((room) => ROOM_RANK[room.type] >= ROOM_RANK[currentRoom.type]);
    const replacement = freeRooms.sort(
      (a, b) => ROOM_RANK[a.type] - ROOM_RANK[b.type] || a.nightlyRate - b.nightlyRate,
    )[0];
    if (replacement) {
      booking.roomId = replacement.id;
      booking.doubleBooked = false;
      return {
        movedTo: replacement.id,
        movedToType: replacement.type,
        movedToView: replacement.view,
        upgraded: ROOM_RANK[replacement.type] > ROOM_RANK[currentRoom.type],
      };
    }
    return { walkPartner: 'the Harbor House', walkReturnDate: addDays(booking.checkIn, 1) };
  }

  private pickRoom(args: {
    roomType: RoomType;
    smoking: boolean;
    guests: number;
    checkIn: string;
    checkOut: string;
    view?: string;
    excludeBookingCode?: string;
  }): Room {
    const free = this.freeRooms(args).filter(
      (room) => room.type === args.roomType && (!args.view || room.view === args.view),
    );
    const room = free.sort((a, b) => a.nightlyRate - b.nightlyRate || a.id.localeCompare(b.id))[0];
    if (!room)
      throw new Unavailable(`sold out: ${args.view ? `${args.view} ` : ''}${args.roomType}`);
    return room;
  }

  private freeRooms(args: {
    checkIn: string;
    checkOut: string;
    guests: number;
    smoking?: boolean;
    excludeBookingCode?: string;
  }): Room[] {
    return this.rooms.filter((room) => {
      if (room.capacity < args.guests) return false;
      if (args.smoking !== undefined && room.smoking !== args.smoking) return false;
      return !this.bookings.some((booking) => {
        if (booking.code === args.excludeBookingCode || booking.status !== 'confirmed')
          return false;
        return (
          booking.roomId === room.id &&
          overlaps(args.checkIn, args.checkOut, booking.checkIn, booking.checkOut)
        );
      });
    });
  }

  private freeTables(date: string, time: string, partySize: number) {
    return RESTAURANT_TABLES.filter((table) => {
      if (table.capacity < partySize) return false;
      return !this.restaurantReservations.some(
        (reservation) =>
          reservation.status === 'confirmed' &&
          reservation.date === date &&
          reservation.time === time &&
          reservation.tableId === table.id,
      );
    });
  }

  private refundAmount(booking: RoomBooking): number {
    const hoursUntilCheckIn =
      (Date.parse(`${booking.checkIn}T15:00:00Z`) - Date.parse(`${TODAY}T00:00:00Z`)) / 3_600_000;
    if (hoursUntilCheckIn >= PRICING.cancellationWindowHours) return booking.total;
    const room = this.getRoom(booking.roomId);
    const forfeit = Math.min(room.nightlyRate * PRICING.cancellationForfeitNights, booking.total);
    return Math.max(0, booking.total - forfeit);
  }

  private setBookingCode(booking: RoomBooking, code: string): RoomBooking {
    const invoice = this.invoices.get(booking.code);
    this.invoices.delete(booking.code);
    booking.code = code;
    if (invoice) this.invoices.set(code, { ...invoice, bookingCode: code });
    return booking;
  }

  private seed() {
    this.setBookingCode(
      this.bookRoom({
        roomType: 'king',
        smoking: false,
        guests: 1,
        checkIn: '2026-06-15',
        checkOut: '2026-06-17',
        firstName: 'Eleanor',
        lastName: 'Smith',
        email: 'eleanor.smith@example.com',
        phone: '5550111',
        cardLast4: '4242',
        extras: [],
      }),
      'HTL-AB12',
    );
    this.setBookingCode(
      this.bookRoom({
        roomType: 'queen_2beds',
        smoking: false,
        guests: 4,
        checkIn: '2026-06-17',
        checkOut: '2026-06-20',
        firstName: 'Marcus',
        lastName: 'Johnson',
        email: 'marcus.johnson@example.com',
        phone: '5550181',
        cardLast4: '1881',
        extras: ['breakfast', 'valet'],
        view: 'garden',
      }),
      'HTL-CD34',
    );
    this.setBookingCode(
      this.bookRoom({
        roomType: 'king',
        smoking: false,
        guests: 1,
        checkIn: '2026-06-04',
        checkOut: '2026-06-06',
        firstName: 'Tanya',
        lastName: 'Richardson',
        email: 'tanya@example.com',
        phone: '5550732',
        cardLast4: '7321',
        extras: [],
      }),
      'HTL-NO22',
    );
    this.setBookingCode(
      this.bookRoom({
        roomType: 'king',
        smoking: false,
        guests: 1,
        checkIn: '2026-06-12',
        checkOut: '2026-06-14',
        firstName: 'Hiroshi',
        lastName: 'Sato',
        email: 'hiroshi@example.com',
        phone: '5550882',
        cardLast4: '8821',
        extras: [],
      }),
      'HTL-BN23',
    );
    this.setBookingCode(
      this.bookRoom({
        roomType: 'king',
        smoking: false,
        guests: 1,
        checkIn: '2026-06-08',
        checkOut: '2026-06-10',
        firstName: 'Robert',
        lastName: 'Klein',
        email: 'robert@example.com',
        phone: '5550841',
        cardLast4: '8412',
        extras: [],
      }),
      'HTL-RK20',
    );
    const tanaka = this.setBookingCode(
      this.bookRoom({
        roomType: 'king',
        smoking: false,
        guests: 1,
        checkIn: '2026-06-08',
        checkOut: '2026-06-10',
        firstName: 'Kenji',
        lastName: 'Tanaka',
        email: 'kenji@example.com',
        phone: '5550778',
        cardLast4: '7782',
        extras: [],
      }),
      'HTL-RT88',
    );
    tanaka.doubleBooked = true;
    const whelan = this.setBookingCode(
      this.bookRoom({
        roomType: 'double_queen',
        smoking: false,
        guests: 4,
        checkIn: '2026-06-12',
        checkOut: '2026-06-15',
        firstName: 'Tom',
        lastName: 'Whelan',
        email: 'tom@example.com',
        phone: '5550512',
        cardLast4: '5126',
        extras: [],
      }),
      'HTL-TW55',
    );
    whelan.doubleBooked = true;
  }
}

function addDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}
