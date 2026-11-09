// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { CLINIC_SEED } from './clinic_data.js';

export const CLINIC_NAME = CLINIC_SEED.clinic;
export const DOCTOR = CLINIC_SEED.doctor;
export const CLINIC_TZ = 'America/Los_Angeles';
export const CLINIC_TZ_NAME = 'Pacific time';
export const CLINIC_DAYS = CLINIC_SEED.busy.length;
export const SLOT_TIMES: readonly string[] = CLINIC_SEED.times;
export const PATIENTS_ON_FILE: ReadonlyMap<string, string> = new Map(
  CLINIC_SEED.patients.map((p) => [p.name, p.dob]),
);

export type PartOfDay = 'morning' | 'afternoon' | 'any';
export type Publish = (key: string, value: unknown) => Promise<void>;

export class ClinicError extends Error {}

export class Appointment {
  confirmed = false;
  readonly notes: string[] = [];

  constructor(
    readonly id: string,
    readonly patient: string,
    public startsAt: Date,
    readonly reason: string,
  ) {}

  toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      patient: this.patient,
      startsAt: pacificIso(this.startsAt),
      reason: this.reason,
      confirmed: this.confirmed,
      notes: this.notes,
    };
  }
}

const discard: Publish = async () => {};

export class Clinic {
  readonly patients = new Map<string, string>(PATIENTS_ON_FILE);
  readonly appointments: Appointment[] = [];
  readonly busy = new Set<number>();

  constructor(
    readonly today: string,
    readonly publish: Publish = discard,
  ) {
    const days = this.clinicDays();
    CLINIC_SEED.busy.forEach((times, index) => {
      const day = days[index];
      if (!day) throw new Error('clinic seed has more busy days than clinic days');
      for (const time of times) this.busy.add(at(day, time).getTime());
    });
    for (const item of CLINIC_SEED.appointments) {
      const day = days[item.day];
      if (!day) throw new Error(`clinic seed appointment has invalid day ${item.day}`);
      this.add(item.patient, at(day, item.time), item.reason);
    }
  }

  static forNow(publish: Publish = discard): Clinic {
    return new Clinic(dateInZone(new Date()), publish);
  }

  clinicDays(): string[] {
    const days: string[] = [];
    let day = this.today;
    while (days.length < CLINIC_DAYS) {
      day = addDays(day, 1);
      const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
      if (weekday !== 0 && weekday !== 6) days.push(day);
    }
    return days;
  }

  isOpen(startsAt: Date): boolean {
    const date = dateInZone(startsAt);
    const time = timeInZone(startsAt);
    return (
      this.clinicDays().includes(date) &&
      SLOT_TIMES.includes(time) &&
      !this.busy.has(startsAt.getTime()) &&
      !this.appointments.some(
        (appointment) => appointment.startsAt.getTime() === startsAt.getTime(),
      )
    );
  }

  upcoming(patient: string): Appointment[] {
    return this.appointments.filter((appointment) => appointment.patient === patient);
  }

  bornOn(dateOfBirth: string): string[] {
    return [...this.patients].filter(([, born]) => born === dateOfBirth).map(([name]) => name);
  }

  async register(name: string, dateOfBirth: string): Promise<void> {
    name = name.trim();
    if (!name) throw new ClinicError('A name is required.');
    if (this.patients.has(name)) {
      throw new ClinicError(
        `${name} already has a chart. Read the whole date of birth back to the caller to check it.`,
      );
    }
    this.patients.set(name, dateOfBirth);
    await this.publishCaller(name);
  }

  async checkAvailability(
    earliest: string,
    latest: string,
    partOfDay: PartOfDay = 'any',
  ): Promise<Date[]> {
    if (latest < earliest) throw new ClinicError('latest must be on or after earliest.');
    const openings = this.clinicDays().flatMap((day) =>
      day < earliest || day > latest
        ? []
        : SLOT_TIMES.map((time) => at(day, time)).filter(
            (slot) => inPart(timeInZone(slot), partOfDay) && this.isOpen(slot),
          ),
    );
    await this.publish('search', {
      earliest,
      latest,
      partOfDay,
      openings: openings.map(pacificIso),
    });
    return openings;
  }

  async book(patient: string, startsAt: Date, reason: string): Promise<Appointment> {
    this.requireOpen(startsAt);
    const appointment = this.add(patient, startsAt, reason);
    await this.publish('search', null);
    await this.publishAppointments();
    return appointment;
  }

  async reschedule(patient: string, appointmentId: string, startsAt: Date): Promise<Appointment> {
    const appointment = this.owned(patient, appointmentId);
    this.requireOpen(startsAt);
    appointment.startsAt = startsAt;
    await this.publish('search', null);
    await this.publishAppointments();
    return appointment;
  }

  async confirm(patient: string, appointmentId: string): Promise<Appointment> {
    const appointment = this.owned(patient, appointmentId);
    appointment.confirmed = true;
    await this.publishAppointments();
    return appointment;
  }

  async addNote(patient: string, appointmentId: string, note: string): Promise<Appointment> {
    note = note.trim();
    if (!note) throw new ClinicError("The note is empty. Use the patient's own words.");
    const appointment = this.owned(patient, appointmentId);
    appointment.notes.push(note);
    await this.publishAppointments();
    return appointment;
  }

  async publishCaller(name: string): Promise<void> {
    await this.publish('caller', { name, new: !PATIENTS_ON_FILE.has(name) });
  }

  private owned(patient: string, appointmentId: string): Appointment {
    const appointment = this.upcoming(patient).find((item) => item.id === appointmentId);
    if (!appointment) throw new ClinicError(`${patient} has no appointment ${appointmentId}.`);
    return appointment;
  }

  private add(patient: string, startsAt: Date, reason: string): Appointment {
    const appointment = new Appointment(
      `A-${101 + this.appointments.length}`,
      patient,
      startsAt,
      reason,
    );
    this.appointments.push(appointment);
    return appointment;
  }

  private requireOpen(startsAt: Date): void {
    if (!this.isOpen(startsAt)) {
      throw new ClinicError(`${shortSlot(startsAt)} isn't open. Check availability again.`);
    }
  }

  private async publishAppointments(): Promise<void> {
    await this.publish(
      'appointments',
      this.appointments.map((appointment) => appointment.toJSON()),
    );
  }
}

export function at(day: string, time: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  if (
    [year, month, date, hour, minute].some((value) => value === undefined || Number.isNaN(value))
  ) {
    throw new Error(`invalid Pacific date/time: ${day} ${time}`);
  }
  const guess = Date.UTC(year!, month! - 1, date!, hour!, minute!);
  const offset = zoneOffsetMs(new Date(guess));
  return new Date(guess - offset);
}

export function pacificIso(value: Date): string {
  const parts = zonedParts(value);
  const offsetMinutes = zoneOffsetMs(value) / 60_000;
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function dateInZone(value: Date): string {
  const parts = zonedParts(value);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function timeInZone(value: Date): string {
  const parts = zonedParts(value);
  return `${parts.hour}:${parts.minute}`;
}

function zonedParts(
  value: Date,
): Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', string> {
  const result = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: CLINIC_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(value)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return result as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', string>;
}

function zoneOffsetMs(value: Date): number {
  const p = zonedParts(value);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - value.getTime();
}

function addDays(day: string, count: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function inPart(time: string, partOfDay: PartOfDay): boolean {
  const hour = Number(time.slice(0, 2));
  if (partOfDay === 'morning') return hour < 12;
  if (partOfDay === 'afternoon') return hour >= 12;
  return true;
}

function shortSlot(value: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: CLINIC_TZ,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(value);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
