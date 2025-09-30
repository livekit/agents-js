// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'crypto';

export class SlotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlotUnavailableError';
  }
}

export interface AvailableSlot {
  startTime: Date;
  durationMin: number;
}

export function createAvailableSlot(startTime: Date, durationMin: number): AvailableSlot {
  return { startTime, durationMin };
}

// Base32 alphabet (RFC 4648)
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function toBase32(buffer: Buffer): string {
  let result = '';
  let bits = 0;
  let value = 0;

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i]!;
    bits += 8;

    while (bits >= 5) {
      result += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    result += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return result;
}

export function getUniqueHash(slot: AvailableSlot): string {
  // unique id based on the start_time & duration_min
  const raw = `${slot.startTime.toISOString()}|${slot.durationMin}`;
  const hash = createHash('blake2s256').update(raw).digest();
  const truncated = hash.subarray(0, 5);
  // Use base32 encoding like Python version and remove padding, then lowercase
  return `ST_${toBase32(truncated).replace(/=/g, '').toLowerCase()}`;
}

export interface Calendar {
  initialize(): Promise<void>;
  scheduleAppointment(options: { startTime: Date; attendeeEmail: string }): Promise<void>;
  listAvailableSlots(options: { startTime: Date; endTime: Date }): Promise<AvailableSlot[]>;
}

export function randomSample<T>(array: T[], size: number): T[] {
  const shuffled = [...array].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, size);
}

export class FakeCalendar implements Calendar {
  private tz: string;
  private _slots: AvailableSlot[];

  constructor(options: { timezone: string; slots?: AvailableSlot[] }) {
    this.tz = options.timezone;
    this._slots = [];

    if (options.slots) {
      this._slots.push(...options.slots);
      return;
    }

    const today = new Date();
    for (let dayOffset = 1; dayOffset <= 90; dayOffset++) {
      const currentDay = new Date(today);
      currentDay.setDate(today.getDate() + dayOffset);

      // Skip weekends (Saturday = 6, Sunday = 0)
      if (currentDay.getDay() === 0 || currentDay.getDay() === 6) {
        continue;
      }

      // Build all possible 30-min slots between 09:00 and 17:00
      const dayStart = new Date(currentDay);
      dayStart.setHours(9, 0, 0, 0);

      const slotsInDay: Date[] = [];
      for (let i = 0; i < 16; i++) {
        // (17-9)=8 hours => 16 slots
        const slotTime = new Date(dayStart);
        slotTime.setMinutes(dayStart.getMinutes() + 30 * i);
        slotsInDay.push(slotTime);
      }

      const numSlots = Math.floor(Math.random() * 4) + 3; // random between 3-6
      const chosen = randomSample(slotsInDay, numSlots);

      for (const slotStart of chosen.sort((a, b) => a.getTime() - b.getTime())) {
        this._slots.push(createAvailableSlot(slotStart, 30));
      }
    }
  }

  async initialize(): Promise<void> {}

  async scheduleAppointment(options: { startTime: Date; attendeeEmail: string }): Promise<void> {
    // Fake it by just removing it from our slots list
    this._slots = this._slots.filter(
      (slot) => slot.startTime.getTime() !== options.startTime.getTime(),
    );
  }

  async listAvailableSlots(options: { startTime: Date; endTime: Date }): Promise<AvailableSlot[]> {
    return this._slots.filter(
      (slot) => slot.startTime >= options.startTime && slot.startTime < options.endTime,
    );
  }
}

// --- cal.com impl ---

const _CAL_COM_EVENT_TYPE = 'livekit-front-desk';
const _EVENT_DURATION_MIN = 30;
const _BASE_URL = 'https://api.cal.com/v2/';

export class CalComCalendar implements Calendar {
  private tz: string;
  private _apiKey: string;
  private _lkEventId?: number;
  private _logger: { info: (message: string) => void };

  constructor(options: { apiKey: string; timezone: string }) {
    this.tz = options.timezone;
    this._apiKey = options.apiKey;
    this._logger = {
      info: (message: string) => console.info(`[cal.com] ${message}`),
    };
  }

  async initialize(): Promise<void> {
    const meResponse = await fetch(`${_BASE_URL}me/`, {
      headers: this._buildHeaders({ apiVersion: '2024-06-14' }),
    });

    if (!meResponse.ok) {
      throw new Error(`Failed to get user info: ${meResponse.status} ${meResponse.statusText}`);
    }

    const meData = await meResponse.json();
    const username = meData.data.username;
    this._logger.info(`using cal.com username: ${username}`);

    const params = new URLSearchParams({ username });
    const eventTypesResponse = await fetch(`${_BASE_URL}event-types/?${params}`, {
      headers: this._buildHeaders({ apiVersion: '2024-06-14' }),
    });

    if (!eventTypesResponse.ok) {
      throw new Error(
        `Failed to get event types: ${eventTypesResponse.status} ${eventTypesResponse.statusText}`,
      );
    }

    const eventTypesData = await eventTypesResponse.json();
    const data = eventTypesData.data;
    const lkEventType =
      data.find((event: { slug: string }) => event.slug === _CAL_COM_EVENT_TYPE) || null;

    if (lkEventType) {
      this._lkEventId = lkEventType.id;
    } else {
      const createResponse = await fetch(`${_BASE_URL}event-types`, {
        method: 'POST',
        headers: {
          ...this._buildHeaders({ apiVersion: '2024-06-14' }),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          lengthInMinutes: _EVENT_DURATION_MIN,
          title: 'LiveKit Front-Desk',
          slug: _CAL_COM_EVENT_TYPE,
        }),
      });

      if (!createResponse.ok) {
        throw new Error(
          `Failed to create event type: ${createResponse.status} ${createResponse.statusText}`,
        );
      }

      this._logger.info(`successfully added ${_CAL_COM_EVENT_TYPE} event type`);
      const createData = await createResponse.json();
      this._lkEventId = createData.data.id;
    }

    this._logger.info(`event type id: ${this._lkEventId}`);
  }

  async scheduleAppointment(options: { startTime: Date; attendeeEmail: string }): Promise<void> {
    const startTimeUtc = new Date(options.startTime.getTime());

    const response = await fetch(`${_BASE_URL}bookings`, {
      method: 'POST',
      headers: {
        ...this._buildHeaders({ apiVersion: '2024-08-13' }),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        start: startTimeUtc.toISOString(),
        attendee: {
          name: options.attendeeEmail,
          email: options.attendeeEmail,
          timeZone: this.tz,
        },
        eventTypeId: this._lkEventId,
      }),
    });

    const data = await response.json();
    if (data.error) {
      const message = data.error.message;
      if (message.includes('User either already has booking at this time or is not available')) {
        throw new SlotUnavailableError(data.error.message);
      }
    }

    if (!response.ok) {
      throw new Error(`Failed to schedule appointment: ${response.status} ${response.statusText}`);
    }
  }

  async listAvailableSlots(options: { startTime: Date; endTime: Date }): Promise<AvailableSlot[]> {
    const startTimeUtc = new Date(options.startTime.getTime());
    const endTimeUtc = new Date(options.endTime.getTime());

    const params = new URLSearchParams({
      eventTypeId: this._lkEventId!.toString(),
      start: startTimeUtc.toISOString(),
      end: endTimeUtc.toISOString(),
    });

    const response = await fetch(`${_BASE_URL}slots/?${params}`, {
      headers: this._buildHeaders({ apiVersion: '2024-09-04' }),
    });

    if (!response.ok) {
      throw new Error(`Failed to get available slots: ${response.status} ${response.statusText}`);
    }

    const rawData = await response.json();
    const availableSlots: AvailableSlot[] = [];

    for (const [, slots] of Object.entries(rawData.data)) {
      for (const slot of slots as { start: string }[]) {
        const startDt = new Date(slot.start.replace('Z', '+00:00'));
        availableSlots.push(createAvailableSlot(startDt, _EVENT_DURATION_MIN));
      }
    }

    return availableSlots;
  }

  private _buildHeaders(options: { apiVersion?: string }): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this._apiKey}`,
    };

    if (options.apiVersion) {
      headers['cal-api-version'] = options.apiVersion;
    }

    return headers;
  }
}
