// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { SERVICE_DESK_DATA as seed } from './service_desk_data.js';

export const DEALERSHIP = seed.dealership;
export const LOANER_MIN_HOURS = seed.loanerMinHours;
export const SHUTTLE_MILES = seed.shuttleMiles;
export type Service = 'oil_change' | 'tire_rotation' | 'diagnostic' | 'warranty_repair' | 'recall';
export type Ride = 'wait' | 'shuttle' | 'loaner';
export type Sound =
  | 'grinding'
  | 'squealing'
  | 'clunking'
  | 'humming'
  | 'clicking'
  | 'rattling'
  | 'other';
export type Moment =
  | 'braking'
  | 'turning'
  | 'over_bumps'
  | 'at_speed'
  | 'idling'
  | 'cold_start'
  | 'all_the_time'
  | 'other';
export type UnsafeReason =
  | 'brakes_failing'
  | 'smoke_or_burning'
  | 'steering_failing'
  | 'red_or_flashing_warning_light'
  | 'overheating';
export type WarrantyPart =
  | 'electrical'
  | 'infotainment_or_electronics'
  | 'window_or_door'
  | 'liftgate_or_trunk'
  | 'climate'
  | 'engine'
  | 'transmission'
  | 'fluid_leak';
export type BmwModel =
  | '1 Series'
  | '2 Series'
  | '3 Series'
  | '4 Series'
  | '5 Series'
  | '7 Series'
  | '8 Series'
  | 'X1'
  | 'X2'
  | 'X3'
  | 'X4'
  | 'X5'
  | 'X6'
  | 'X7'
  | 'XM'
  | 'Z4'
  | 'i4'
  | 'i5'
  | 'i7'
  | 'iX'
  | 'M2'
  | 'M3'
  | 'M4'
  | 'M5'
  | 'M8';
export type Priceable =
  | Service
  | 'shuttle'
  | 'loaner'
  | 'waiting_lounge'
  | 'this_visit'
  | 'something_else';
export type PartOfDay = 'morning' | 'afternoon' | 'any';
export type RepairId = 'front_brakes' | 'rear_brakes';
export type RepairDecision = 'approved' | 'declined' | 'next_visit' | 'thinking_it_over';
export type PickupRide = 'shuttle' | 'self';
export type EndedEarly = 'wrong_person' | 'call_back_later';
export type Publish = (key: string, value: unknown) => Promise<void>;

export class ServiceDeskError extends Error {}

const DAY_MS = 86_400_000;
const discard: Publish = async () => {};
const dateOnly = (date: Date): string => date.toISOString().slice(0, 10);
const atUtc = (day: string, time = '00:00'): Date => new Date(`${day}T${time}:00Z`);
const addDays = (day: string, count: number): string =>
  dateOnly(new Date(atUtc(day).getTime() + count * DAY_MS));
const weekday = (day: string): number => atUtc(day).getUTCDay();
const clockMinutes = (time: string): number =>
  Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const formatTime = (date: Date): string => {
  const h = date.getUTCHours();
  return `${h % 12 || 12}:${String(date.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
const dayName = (day: string): string =>
  atUtc(day).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
const monthName = (day: string): string =>
  atUtc(day).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });

export function businessDays(after: string, count: number): string[] {
  const days: string[] = [];
  let day = after;
  while (days.length < count) {
    day = addDays(day, 1);
    if (weekday(day) !== 0 && weekday(day) !== 6) days.push(day);
  }
  return days;
}

export function todayIn(timezone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || seed.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: seed.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }
}

export type Recall = { id: string; title: string; hours: number };
export function openRecall(model: string, year: number): Recall | undefined {
  const recall = seed.recalls.find(
    (r) => r.model === model && r.years[0] <= year && year <= r.years[1],
  );
  return recall && { id: recall.id, title: recall.title, hours: recall.hours };
}

export class Vehicle {
  addedOnCall = false;
  constructor(
    public id: string,
    public year: number,
    public model: string,
    public miles: number,
    public inService: string,
    public trim?: string,
  ) {}
  get name(): string {
    return this.trim ?? this.model;
  }
  get label(): string {
    return `${this.year} BMW ${this.name}`;
  }
  get recall(): Recall | undefined {
    return openRecall(this.model, this.year);
  }
  inWarranty(today: string): boolean {
    return (
      (atUtc(today).getTime() - atUtc(this.inService).getTime()) / DAY_MS / 365.25 <
        seed.warranty.years && this.miles < seed.warranty.miles
    );
  }
  toJson(today: string): Record<string, unknown> {
    const years = (atUtc(today).getTime() - atUtc(this.inService).getTime()) / DAY_MS / 365.25;
    return {
      vehicleId: this.id,
      car: this.label,
      miles: this.miles,
      inWarranty: this.inWarranty(today),
      yearsInService: Math.round(years * 10) / 10,
      openRecall: this.recall
        ? { recallId: this.recall.id, title: this.recall.title, hours: this.recall.hours }
        : null,
      addedOnCall: this.addedOnCall,
    };
  }
}

export class Customer {
  constructor(
    public name: string,
    public phone: string,
    public vehicles: Vehicle[],
    public newFile = false,
  ) {}
  vehicle(id: string): Vehicle {
    const vehicle = this.vehicles.find((v) => v.id === id);
    if (vehicle) return vehicle;
    if (!this.vehicles.length)
      throw new ServiceDeskError('There are no cars on this file yet: use add_vehicle.');
    throw new ServiceDeskError(
      `No car '${id}' on this file. On file: ${this.vehicles.map((v) => `${v.id} (${v.label})`).join(', ')}.`,
    );
  }
}

export class Slot {
  constructor(
    public startsAt: Date,
    public advisor: string,
    public taken = false,
  ) {}
  get id(): string {
    return this.startsAt.toISOString().slice(0, 16);
  }
  fits(hours: number): boolean {
    return clockMinutes(this.id.slice(11)) + hours * 60 <= clockMinutes(seed.closes);
  }
}

export class Appointment {
  concern = '';
  approvalLimit?: number;
  unsafe?: UnsafeReason;
  status: 'booked' | 'cancelled' = 'booked';
  movedFrom?: Date;
  bookedOnCall = false;
  constructor(
    public id: string,
    public vehicle: Vehicle,
    public services: Service[],
    public slot: Slot,
    public ride: Ride,
  ) {}
  get hours(): number {
    return visitHours(this.vehicle, this.services);
  }
  get estimate(): number {
    return this.services.reduce(
      (sum, service) => sum + (service === 'recall' ? 0 : seed.menu[service].price),
      0,
    );
  }
  toJson(): Record<string, unknown> {
    return {
      appointmentId: this.id,
      car: this.vehicle.label,
      services: this.services.map((s) => serviceLabel(s, this.vehicle)),
      concern: this.concern,
      when: spoken(this.slot.startsAt),
      startsAt: this.slot.id,
      advisor: this.slot.advisor,
      ride: this.ride,
      estimate: this.estimate,
      approvalLimit: this.approvalLimit ?? null,
      unsafeToDrive: this.unsafe ?? null,
      status: this.status,
      movedFrom: this.movedFrom ? spoken(this.movedFrom) : null,
      bookedOnCall: this.bookedOnCall,
    };
  }
}

export class Problem {
  summary = '';
  sound?: Sound;
  where = '';
  when?: Moment;
  since = '';
  warningLights = '';
  recentWork = '';
  unsafe?: UnsafeReason;
  toJson(): Record<string, unknown> {
    return {
      summary: this.summary,
      sound: this.sound ?? null,
      where: this.where,
      when: this.when ?? null,
      since: this.since,
      warningLights: this.warningLights,
      recentWork: this.recentWork,
      unsafeToDrive: this.unsafe ?? null,
    };
  }
}
export type LikelyCause = { cause: string; advice: string };
export function likelyCause(sound?: Sound, moment?: Moment): LikelyCause | undefined {
  return seed.likelyCauses.find((c) => c.sound === sound && c.when === moment);
}
export type Visit = {
  vehicle?: Vehicle;
  problem: Problem;
  services: Service[];
  failedPart?: WarrantyPart;
  slot?: Slot;
  ride?: Ride;
  approvalLimit?: number;
  booked?: Appointment;
};
export type Finding = {
  id: RepairId;
  title: string;
  spoken: string;
  found: string;
  why: string;
  parts: number;
  laborHours: number;
  urgency: 'now' | 'next_visit';
  canWait: string;
  warranty: string;
  cheaperOption: string;
  laborRate: number;
  labor: number;
  price: number;
};
export type ShopVisit = {
  appointment: Appointment;
  findings: Finding[];
  decisions: Partial<Record<RepairId, RepairDecision>>;
  ride?: PickupRide;
  shuttleFrom: string;
  collectedBy: string;
  concerns: string[];
  endedEarly?: EndedEarly;
  findingsShared: boolean;
};

export function visitHours(vehicle: Vehicle | undefined, services: Service[]): number {
  return services.reduce(
    (hours, service) =>
      hours + (service === 'recall' ? vehicle?.recall?.hours ?? 0 : seed.menu[service].hours),
    0,
  );
}
export function serviceLabel(service: Service, vehicle?: Vehicle): string {
  return service === 'recall'
    ? vehicle?.recall
      ? `${vehicle.recall.title} recall`
      : 'Recall'
    : seed.menu[service].label;
}
export function spoken(at: Date): string {
  const day = dateOnly(at);
  return `${dayName(day)}, ${monthName(day)} ${at.getUTCDate()} at ${formatTime(at)}`;
}

function phoneDigits(phone: string): string {
  let digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length !== 10)
    throw new ServiceDeskError(
      'A phone number is ten digits with the area code. Ask for the whole number again.',
    );
  return digits;
}
const sameName = (a: string, b: string): boolean =>
  a.trim().replace(/\s+/g, ' ').toLocaleLowerCase() ===
  b.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
const slotJson = (slot: Slot): Record<string, unknown> => ({
  slotId: slot.id,
  when: spoken(slot.startsAt),
  advisor: slot.advisor,
});

export class ServiceDesk {
  readonly days: string[];
  readonly slots: Slot[];
  readonly customers: Customer[];
  readonly appointments: Appointment[] = [];
  customer?: Customer;
  visit: Visit = { problem: new Problem(), services: [] };
  shop?: ShopVisit;
  revision = 0;
  private nextRo = 48_231;
  constructor(
    public readonly today: string,
    public readonly publish: Publish = discard,
  ) {
    this.days = businessDays(today, seed.bookableDays);
    this.slots = this.seedSlots();
    this.customers = seed.customers.map((c) => this.seedCustomer(c));
    this.seedAppointment();
  }
  static forCallback(today: string, publish: Publish = discard): ServiceDesk {
    const desk = new ServiceDesk(today, publish);
    desk.seedShopVisit();
    return desk;
  }
  async findCustomer(name: string, phone: string): Promise<Customer | undefined> {
    const digits = phoneDigits(phone);
    const match = this.customers.find((c) => c.phone === digits && sameName(c.name, name));
    if (match) await this.open(match);
    return match;
  }
  async openNewFile(name: string, phone: string): Promise<Customer> {
    const digits = phoneDigits(phone);
    name = name.trim().replace(/\s+/g, ' ');
    if (!name) throw new ServiceDeskError('Ask for their name first.');
    if (this.customers.some((c) => c.phone === digits && sameName(c.name, name)))
      throw new ServiceDeskError(
        "There's already a file under that name and number: use find_customer.",
      );
    const customer = new Customer(name, digits, [], true);
    this.customers.push(customer);
    await this.open(customer);
    return customer;
  }
  private async open(customer: Customer): Promise<void> {
    if (this.customer === customer) return;
    if (this.visit.vehicle)
      throw new ServiceDeskError(
        `This call already has ${this.customer?.name ?? 'a'} file open with a car on the visit.`,
      );
    this.customer = customer;
    await this.publishCustomer();
    await this.publishAppointments();
  }
  fileJson(): Record<string, unknown> {
    return {
      ...this.customerJson(),
      appointments: this.customerAppointments().map((a) => a.toJson()),
    };
  }
  private customerJson(): Record<string, unknown> {
    const c = this.requireCustomer();
    return {
      name: c.name,
      newFile: c.newFile,
      vehicles: c.vehicles.map((v) => v.toJson(this.today)),
    };
  }
  customerAppointments(): Appointment[] {
    return this.appointments.filter(
      (a) => !!this.customer && this.customer.vehicles.includes(a.vehicle),
    );
  }
  async chooseVehicle(id: string, mileage?: number): Promise<string[]> {
    const vehicle = this.requireCustomer().vehicle(id);
    if (mileage !== undefined) {
      if (mileage < vehicle.miles)
        throw new ServiceDeskError(
          `The file shows ${vehicle.miles.toLocaleString('en-US')} miles, and mileage only goes up. Ask them to check the odometer.`,
        );
      if (mileage !== vehicle.miles) {
        vehicle.miles = mileage;
        this.changed();
      }
    }
    const dropped: string[] = [];
    if (this.visit.vehicle !== vehicle) {
      if (this.visit.services.includes('recall')) {
        this.visit.services.splice(this.visit.services.indexOf('recall'), 1);
        dropped.push('The recall came off the visit: it was for the other car.');
      }
      this.visit.vehicle = vehicle;
      this.changed();
    }
    await this.publishCustomer();
    await this.publishVisit();
    return dropped;
  }
  async addVehicle(year: number, model: BmwModel, mileage: number): Promise<Vehicle> {
    const c = this.requireCustomer();
    if (year < 1990 || year > Number(this.today.slice(0, 4)) + 1)
      throw new ServiceDeskError("That model year doesn't look right. Ask for it again.");
    if (mileage < 0 || mileage >= 400_000)
      throw new ServiceDeskError("That mileage doesn't look right. Ask them to check it.");
    const existing = c.vehicles.find((v) => v.year === year && v.model === model);
    if (existing)
      throw new ServiceDeskError(
        `The ${existing.label} is already on their file as ${existing.id}: use choose_vehicle.`,
      );
    const july = `${year}-07-01`;
    const vehicle = new Vehicle(
      `V${this.customers.reduce((n, x) => n + x.vehicles.length, 0) + 1}`,
      year,
      model,
      mileage,
      july < this.today ? july : this.today,
    );
    vehicle.addedOnCall = true;
    c.vehicles.push(vehicle);
    await this.chooseVehicle(vehicle.id);
    return vehicle;
  }
  async describeProblem(fields: {
    summary?: string;
    sound?: Sound;
    where?: string;
    when?: Moment;
    since?: string;
    warningLights?: string;
    recentWork?: string;
  }): Promise<Problem> {
    const p = this.visit.problem;
    const before = JSON.stringify(p.toJson());
    if (fields.summary !== undefined) p.summary = fields.summary.trim().replace(/\s+/g, ' ');
    if (fields.sound !== undefined) p.sound = fields.sound;
    if (fields.where !== undefined) p.where = fields.where.trim();
    if (fields.when !== undefined) p.when = fields.when;
    if (fields.since !== undefined) p.since = fields.since.trim();
    if (fields.warningLights !== undefined) p.warningLights = fields.warningLights.trim();
    if (fields.recentWork !== undefined) p.recentWork = fields.recentWork.trim();
    if (JSON.stringify(p.toJson()) !== before) this.changed();
    await this.publishVisit();
    return p;
  }
  async flagUnsafeToDrive(reason: UnsafeReason): Promise<void> {
    if (this.visit.problem.unsafe !== reason) {
      this.visit.problem.unsafe = reason;
      this.changed();
    }
    await this.publishVisit();
  }
  async addService(service: Service, failedPart?: WarrantyPart): Promise<void> {
    const v = this.requireVehicle();
    if (service === 'recall' && !v.recall)
      throw new ServiceDeskError(`The ${v.name} has no open recall.`);
    if ((service === 'diagnostic' || service === 'warranty_repair') && !this.visit.problem.summary)
      throw new ServiceDeskError(
        'Record the problem first: describe_problem with a short summary.',
      );
    if (service === 'warranty_repair') {
      if (!failedPart)
        throw new ServiceDeskError(
          'A warranty repair needs the part that failed: pass failed_part.',
        );
      if (!v.inWarranty(this.today))
        throw new ServiceDeskError(
          `The ${v.name} is out of warranty (${seed.warranty.years} years or ${seed.warranty.miles.toLocaleString('en-US')} miles). Offer a diagnostic instead.`,
        );
      if (this.visit.failedPart !== failedPart) {
        this.visit.failedPart = failedPart;
        this.changed();
      }
    }
    if (!this.visit.services.includes(service)) {
      this.visit.services.push(service);
      this.changed();
    }
    await this.publishVisit();
  }
  async removeService(service: Service): Promise<void> {
    const i = this.visit.services.indexOf(service);
    if (i >= 0) {
      this.visit.services.splice(i, 1);
      if (service === 'warranty_repair') this.visit.failedPart = undefined;
      this.changed();
    }
    await this.publishVisit();
  }
  quote(item: Priceable): Record<string, unknown> {
    if (item in seed.menu) {
      const service = item as Exclude<Service, 'recall'>;
      const notes: Partial<Record<Service, string>> = {
        diagnostic: 'The fee to find the cause; any repair is quoted after it.',
        warranty_repair: `No charge, for a part that's failed on a car in warranty (${seed.warranty.years} years and ${seed.warranty.miles.toLocaleString('en-US')} miles). Never brakes, tires, wipers, or maintenance.`,
      };
      return { item, price: seed.menu[service].price, note: notes[service] ?? '' };
    }
    if (item === 'recall') return { item, price: 0, note: 'Recall work is always free.' };
    if (item === 'shuttle') return { item, price: 0, note: `Free, within ${SHUTTLE_MILES} miles.` };
    if (item === 'waiting_lounge') return { item, price: 0, note: 'Free.' };
    if (item === 'loaner')
      return {
        item,
        price: 0,
        note: `Free, but only for warranty or recall visits over ${LOANER_MIN_HOURS} hours.`,
        thisVisitQualifies: this.loanerEligible(),
      };
    if (item === 'this_visit')
      return {
        item,
        price: this.estimate(),
        lines: this.visit.services.map((s) => ({
          service: serviceLabel(s, this.visit.vehicle),
          price: this.price(s),
        })),
      };
    return {
      item,
      price: null,
      note: 'No set price. Only the oil change, tire rotation, and diagnostic have menu prices; any repair is quoted after a diagnostic.',
    };
  }
  openings(day?: string, part: PartOfDay = 'any', appointmentId?: string): Slot[] {
    let hours: number;
    let own: Slot | undefined;
    if (appointmentId) {
      const moving = this.appointment(appointmentId);
      hours = moving.hours;
      own = moving.slot;
    } else hours = visitHours(this.visit.vehicle, this.visit.services);
    if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day))
      throw new ServiceDeskError(`Pass the day as YYYY-MM-DD, got '${day}'.`);
    if (day && !this.days.includes(day))
      throw new ServiceDeskError(
        `That day isn't bookable. Bookable days: ${this.days.join(', ')}.`,
      );
    return this.slots.filter(
      (s) =>
        !s.taken &&
        s !== own &&
        s.fits(hours) &&
        (!day || s.id.startsWith(day)) &&
        (part === 'any' ||
          (part === 'morning' ? s.startsAt.getUTCHours() < 12 : s.startsAt.getUTCHours() >= 12)),
    );
  }
  async publishOpenings(slots: Slot[]): Promise<void> {
    await this.publish('openings', slots.map(slotJson));
  }
  async chooseTime(id: string): Promise<Slot> {
    const slot = this.getSlot(id);
    const held = this.visit.booked?.slot;
    if (slot.taken && slot !== held)
      throw new ServiceDeskError('That time is taken. Offer another.');
    if (!slot.fits(visitHours(this.visit.vehicle, this.visit.services)))
      throw new ServiceDeskError(
        "A visit this long won't finish by closing from that time. Offer an earlier one.",
      );
    if (this.visit.slot !== slot) {
      this.visit.slot = slot;
      this.changed();
    }
    await this.publishVisit();
    return slot;
  }
  async chooseRide(ride: Ride): Promise<void> {
    if (ride === 'loaner' && !this.loanerEligible())
      throw new ServiceDeskError(
        `Tell them the rule: loaners are only for warranty or recall visits over ${LOANER_MIN_HOURS} hours, and this visit is ${visitHours(this.visit.vehicle, this.visit.services)} hours. Then offer the free shuttle or the lounge.`,
      );
    if (this.visit.ride !== ride) {
      this.visit.ride = ride;
      this.changed();
    }
    await this.publishVisit();
  }
  async setApprovalLimit(dollars: number): Promise<void> {
    if (dollars <= 0) throw new ServiceDeskError('Pass the dollar amount they gave.');
    if (this.visit.approvalLimit !== dollars) {
      this.visit.approvalLimit = dollars;
      this.changed();
    }
    await this.publishVisit();
  }
  loanerEligible(): boolean {
    return (
      this.visit.services.some((s) => s === 'warranty_repair' || s === 'recall') &&
      visitHours(this.visit.vehicle, this.visit.services) > LOANER_MIN_HOURS
    );
  }
  estimate(): number {
    return this.visit.services.reduce((sum, s) => sum + this.price(s), 0);
  }
  price(service: Service): number {
    return service === 'recall' ? 0 : seed.menu[service].price;
  }
  changedSinceBooked(): boolean {
    const b = this.visit.booked;
    if (!b) return false;
    return (
      b.vehicle !== this.visit.vehicle ||
      JSON.stringify(b.services) !== JSON.stringify(this.visit.services) ||
      b.slot !== this.visit.slot ||
      b.ride !== this.visit.ride ||
      b.concern !== this.visit.problem.summary ||
      b.approvalLimit !== this.visit.approvalLimit ||
      b.unsafe !== this.visit.problem.unsafe
    );
  }
  readBack(): Record<string, unknown> {
    const vehicle = this.requireVehicle();
    const missing = [
      ['a service', this.visit.services.length],
      ['a time', this.visit.slot],
      ["how they'll get around", this.visit.ride],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length)
      throw new ServiceDeskError(`Not ready to book. Still need: ${missing.join(', ')}.`);
    const slot = this.visit.slot!;
    if (slot.taken && slot !== this.visit.booked?.slot)
      throw new ServiceDeskError('The time they picked was just taken. Offer another.');
    if (!slot.fits(visitHours(vehicle, this.visit.services)))
      throw new ServiceDeskError(
        'The visit no longer fits that time before closing. Offer an earlier one.',
      );
    if (this.visit.ride === 'loaner' && !this.loanerEligible())
      throw new ServiceDeskError(
        'The visit no longer qualifies for a loaner. Offer the shuttle or the lounge.',
      );
    if (this.visit.services.includes('warranty_repair') && !vehicle.inWarranty(this.today))
      throw new ServiceDeskError(`The ${vehicle.name} is out of warranty now. Offer a diagnostic.`);
    for (const a of this.customerAppointments()) {
      const both = a.services.filter((s) => this.visit.services.includes(s));
      if (a.status === 'booked' && a !== this.visit.booked && a.vehicle === vehicle && both.length)
        throw new ServiceDeskError(
          `The ${both
            .map((s) => serviceLabel(s, vehicle))
            .join(', ')
            .toLowerCase()} is already booked for the ${vehicle.name} on ${spoken(a.slot.startsAt)} (${a.id}). Offer to move that one instead, or leave it off this visit.`,
        );
    }
    return {
      car: vehicle.label,
      services: this.visit.services.map((s) => ({
        service: serviceLabel(s, vehicle),
        price: this.price(s),
      })),
      concern: this.visit.problem.summary,
      openRecallNotAdded:
        vehicle.recall && !this.visit.services.includes('recall') ? vehicle.recall.title : null,
      when: spoken(slot.startsAt),
      advisor: slot.advisor,
      ride: this.visit.ride,
      estimate: this.estimate(),
      approvalLimit: this.visit.approvalLimit ?? null,
      unsafeToDrive: this.visit.problem.unsafe ?? null,
      updatesBooking: this.visit.booked?.id ?? null,
    };
  }
  async book(): Promise<Appointment> {
    this.readBack();
    const vehicle = this.visit.vehicle!;
    const slot = this.visit.slot!;
    const ride = this.visit.ride!;
    let booked = this.visit.booked;
    if (!booked) {
      booked = new Appointment(this.ro(), vehicle, [], slot, ride);
      booked.bookedOnCall = true;
      this.appointments.push(booked);
    } else booked.slot.taken = false;
    slot.taken = true;
    booked.vehicle = vehicle;
    booked.services = [...this.visit.services];
    booked.slot = slot;
    booked.ride = ride;
    booked.concern = this.visit.problem.summary;
    booked.approvalLimit = this.visit.approvalLimit;
    booked.unsafe = this.visit.problem.unsafe;
    booked.status = 'booked';
    this.visit.booked = booked;
    this.changed();
    await this.publishAppointments();
    await this.publishVisit();
    return booked;
  }
  appointment(id: string): Appointment {
    const a = this.customerAppointments().find((x) => x.id === id);
    if (a?.status === 'cancelled') throw new ServiceDeskError(`${a.id} is already cancelled.`);
    if (a) return a;
    throw new ServiceDeskError(
      `No appointment '${id}' on this file. Booked: ${
        this.customerAppointments()
          .filter((x) => x.status === 'booked')
          .map((x) => x.id)
          .join(', ') || 'none'
      }.`,
    );
  }
  moveReadBack(id: string, slotId: string): Record<string, unknown> {
    const a = this.appointment(id);
    const slot = this.getSlot(slotId);
    if (slot === a.slot) throw new ServiceDeskError("It's already booked for that time.");
    if (slot.taken) throw new ServiceDeskError('That time is taken. Offer another.');
    if (!slot.fits(a.hours))
      throw new ServiceDeskError("That time won't fit it before closing. Offer an earlier one.");
    return {
      appointment: a.toJson(),
      from: spoken(a.slot.startsAt),
      to: spoken(slot.startsAt),
      advisor: slot.advisor,
    };
  }
  async move(id: string, slotId: string): Promise<Appointment> {
    this.moveReadBack(id, slotId);
    const a = this.appointment(id);
    const slot = this.getSlot(slotId);
    a.slot.taken = false;
    slot.taken = true;
    a.movedFrom = a.slot.startsAt;
    a.slot = slot;
    if (a === this.visit.booked) this.visit.slot = slot;
    this.changed();
    await this.publishAppointments();
    await this.publishVisit();
    return a;
  }
  cancelReadBack(id: string): Record<string, unknown> {
    return { appointment: this.appointment(id).toJson() };
  }
  async cancel(id: string): Promise<Appointment> {
    const a = this.appointment(id);
    a.status = 'cancelled';
    a.slot.taken = false;
    if (a === this.visit.booked) this.visit.booked = undefined;
    this.changed();
    await this.publishAppointments();
    await this.publishVisit();
    return a;
  }
  async decide(repair: RepairId, decision: RepairDecision): Promise<Finding> {
    const shop = this.requireShop();
    const finding = this.finding(repair);
    if (shop.decisions[repair] !== decision) {
      shop.decisions[repair] = decision;
      this.changed();
    }
    await this.publishShop();
    return finding;
  }
  finding(id: string): Finding {
    const finding = this.requireShop().findings.find((f) => f.id === id);
    if (!finding)
      throw new ServiceDeskError(
        `No repair '${id}'. The findings: ${this.requireShop()
          .findings.map((f) => f.id)
          .join(', ')}.`,
      );
    return finding;
  }
  async arrangePickup(
    ride?: PickupRide,
    shuttleFrom?: string,
    collectedBy?: string,
  ): Promise<void> {
    const shop = this.requireShop();
    const before = [shop.ride, shop.shuttleFrom, shop.collectedBy] as const;
    if (ride !== undefined) shop.ride = ride;
    if (shuttleFrom !== undefined) shop.shuttleFrom = shuttleFrom.trim();
    if (collectedBy !== undefined) shop.collectedBy = collectedBy.trim();
    if (shop.ride === 'shuttle' && !shop.shuttleFrom) {
      shop.ride = before[0];
      throw new ServiceDeskError(
        `Ask where the shuttle should pick them up (within ${SHUTTLE_MILES} miles).`,
      );
    }
    if (JSON.stringify(before) !== JSON.stringify([shop.ride, shop.shuttleFrom, shop.collectedBy]))
      this.changed();
    await this.publishShop();
  }
  async noteConcern(concern: string): Promise<void> {
    const shop = this.requireShop();
    concern = concern.trim().replace(/\s+/g, ' ');
    if (!concern) throw new ServiceDeskError('Pass what they noticed, in a few words.');
    if (!shop.concerns.includes(concern)) {
      shop.concerns.push(concern);
      this.changed();
    }
    await this.publishShop();
  }
  async endEarly(reason: EndedEarly): Promise<void> {
    const shop = this.requireShop();
    if (Object.keys(shop.decisions).length)
      throw new ServiceDeskError(
        "They've already decided on a repair: finish with how they'll get the car back.",
      );
    shop.endedEarly = reason;
    this.changed();
    await this.publishShop();
  }
  async shareFindings(): Promise<Finding> {
    const shop = this.requireShop();
    if (shop.endedEarly) throw new ServiceDeskError('This call already ended without the update.');
    if (!shop.findingsShared) {
      shop.findingsShared = true;
      this.changed();
    }
    await this.publishShop();
    return shop.findings.find((f) => f.urgency === 'now')!;
  }
  undecidedLater(): Finding[] {
    const shop = this.requireShop();
    return shop.findings.filter((f) => f.urgency === 'next_visit' && !shop.decisions[f.id]);
  }
  undecided(): Finding[] {
    const shop = this.requireShop();
    return shop.findings.filter((f) => f.urgency === 'now' && !shop.decisions[f.id]);
  }
  readyAt(repairs?: Finding[]): Date | undefined {
    const shop = this.requireShop();
    repairs ??= shop.findings.filter((f) => shop.decisions[f.id] === 'approved');
    const hours = repairs.reduce((n, f) => n + f.laborHours, 0);
    if (!hours) return undefined;
    return hours <= seed.shopVisit.sameDayHours
      ? atUtc(this.today, seed.closes)
      : atUtc(businessDays(this.today, 1)[0]!, seed.shopVisit.nextDayReady);
  }
  said(at: Date): string {
    const day = dateOnly(at);
    if (day === this.today) return `today at ${formatTime(at)}`;
    if (day === addDays(this.today, 1)) return `tomorrow at ${formatTime(at)}`;
    return spoken(at);
  }
  pickupSummary(): Record<string, unknown> {
    const shop = this.requireShop();
    const ready = this.readyAt();
    let shuttleAt: string | null = null;
    if (shop.ride === 'shuttle')
      shuttleAt = !ready
        ? 'in about half an hour'
        : this.said(new Date(ready.getTime() - seed.shopVisit.shuttleLeadMinutes * 60_000));
    return {
      readyAt: ready ? this.said(ready) : 'now',
      totalDue: this.totalDue(),
      lines: this.ticket(),
      ride: shop.ride ?? null,
      shuttleFrom: shop.ride === 'shuttle' ? shop.shuttleFrom : null,
      shuttleAt,
      collectedBy: shop.collectedBy || null,
      stillToDecide: this.undecided().map((f) => f.id),
    };
  }
  ticket(): { line: string; price: number }[] {
    const shop = this.requireShop();
    return [
      ...shop.appointment.services.map((s) => ({
        line: serviceLabel(s, shop.appointment.vehicle),
        price: this.price(s),
      })),
      ...shop.findings
        .filter((f) => shop.decisions[f.id] === 'approved')
        .map((f) => ({ line: f.title, price: f.price })),
    ];
  }
  totalDue(): number {
    return this.ticket().reduce((sum, line) => sum + line.price, 0);
  }
  async publishAll(): Promise<void> {
    if (this.shop) {
      await this.publishCustomer();
      await this.publishShop();
    } else await this.publishVisit();
  }
  private async publishCustomer(): Promise<void> {
    await this.publish('customer', this.customer ? this.customerJson() : null);
  }
  private async publishAppointments(): Promise<void> {
    await this.publish(
      'appointments',
      this.customerAppointments().map((a) => a.toJson()),
    );
  }
  private async publishVisit(): Promise<void> {
    const v = this.visit.vehicle;
    const p = this.visit.problem;
    await this.publish('visit', {
      car: v?.toJson(this.today) ?? null,
      problem: p.toJson(),
      likelyCause: likelyCause(p.sound, p.when)?.cause ?? null,
      services: this.visit.services.map((s) => ({
        service: s,
        label: serviceLabel(s, v),
        price: this.price(s),
      })),
      failedPart: this.visit.failedPart ?? null,
      slot: this.visit.slot ? slotJson(this.visit.slot) : null,
      ride: this.visit.ride ?? null,
      approvalLimit: this.visit.approvalLimit ?? null,
      estimate: this.estimate(),
      hours: visitHours(v, this.visit.services),
      bookedAs: this.visit.booked?.id ?? null,
    });
  }
  private async publishShop(): Promise<void> {
    const shop = this.requireShop();
    await this.publish('shop', {
      appointment: shop.appointment.toJson(),
      findings: shop.findings.map((f) => ({
        repairId: f.id,
        title: f.title,
        found: f.found,
        price: f.price,
        parts: f.parts,
        labor: f.labor,
        urgency: f.urgency,
        decision: shop.decisions[f.id] ?? null,
      })),
      concerns: shop.concerns,
      findingsShared: shop.findingsShared,
      endedEarly: shop.endedEarly ?? null,
      ...this.pickupSummary(),
    });
  }
  private changed(): void {
    this.revision += 1;
  }
  private ro(): string {
    return `RO-${this.nextRo++}`;
  }
  private getSlot(id: string): Slot {
    const slot = this.slots.find((s) => s.id === id);
    if (!slot) throw new ServiceDeskError(`No time '${id}': use a slot_id from find_times.`);
    return slot;
  }
  private requireCustomer(): Customer {
    if (!this.customer)
      throw new ServiceDeskError('Find their file first: their name, then their number.');
    return this.customer;
  }
  private requireVehicle(): Vehicle {
    this.requireCustomer();
    if (!this.visit.vehicle) throw new ServiceDeskError('Choose which car first.');
    return this.visit.vehicle;
  }
  private requireShop(): ShopVisit {
    if (!this.shop) throw new ServiceDeskError("There's no car in the shop on this call.");
    return this.shop;
  }
  private seedSlots(): Slot[] {
    const booked = new Set(seed.bookedSlots.map(([a, b]) => `${a}:${b}`));
    return this.days.flatMap((day, i) =>
      seed.slotTimes.map(
        (time, j) =>
          new Slot(
            atUtc(day, time),
            seed.advisors[(i + j) % seed.advisors.length]!,
            booked.has(`${weekday(day) - 1}:${j}`),
          ),
      ),
    );
  }
  private seedCustomer(c: (typeof seed.customers)[number]): Customer {
    return new Customer(
      c.name,
      c.phone,
      c.vehicles.map(
        (v) =>
          new Vehicle(
            v.id,
            v.year,
            v.model,
            v.miles,
            'inService' in v ? v.inService : addDays(this.today, -v.inServiceDaysAgo),
            'trim' in v ? v.trim : undefined,
          ),
      ),
    );
  }
  private seedAppointment(): void {
    const seeded = seed.customers[0].appointment;
    const customer = this.customers[0]!;
    const slot = this.slots.find((s) => s.id === `${this.days.at(-1)}T${seeded.time}`)!;
    slot.taken = true;
    this.appointments.push(
      new Appointment(
        'RO-48194',
        customer.vehicle(seeded.vehicleId),
        [...seeded.services] as Service[],
        slot,
        seeded.ride,
      ),
    );
  }
  private seedShopVisit(): void {
    const data = seed.shopVisit;
    const customer = this.customers[0]!;
    const vehicle = customer.vehicle(data.vehicleId);
    const appointment = new Appointment(
      'RO-48207',
      vehicle,
      [...data.done] as Service[],
      new Slot(atUtc(this.today, data.droppedOff), seed.advisors[0]!, true),
      'shuttle',
    );
    appointment.concern = data.concern;
    this.appointments.push(appointment);
    this.customer = customer;
    this.shop = {
      appointment,
      findings: data.findings.map((f) => ({
        ...f,
        id: f.id as RepairId,
        urgency: f.urgency as 'now' | 'next_visit',
        laborRate: data.laborRate,
        labor: Math.round(f.laborHours * data.laborRate),
        price: f.parts + Math.round(f.laborHours * data.laborRate),
      })),
      decisions: {},
      shuttleFrom: '',
      collectedBy: '',
      concerns: [],
      findingsShared: false,
    };
  }
}
