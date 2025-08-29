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

export function getUniqueHash(slot: AvailableSlot): string {
  // unique id based on the start_time & duration_min
  const raw = `${slot.startTime.toISOString()}|${slot.durationMin}`;
  const hash = createHash('blake2s256').update(raw).digest();
  const truncated = hash.subarray(0, 5);
  return `ST_${truncated.toString('base64').replace(/[+/=]/g, '').toLowerCase()}`;
}

export interface Calendar {
  initialize(): Promise<void>;
  scheduleAppointment(options: { startTime: Date; attendeeEmail: string }): Promise<void>;
  listAvailableSlots(options: { startTime: Date; endTime: Date }): Promise<AvailableSlot[]>;
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
      const chosen = this.randomSample(slotsInDay, numSlots);

      for (const slotStart of chosen.sort((a, b) => a.getTime() - b.getTime())) {
        this._slots.push(createAvailableSlot(slotStart, 30));
      }
    }
  }

  private randomSample<T>(array: T[], size: number): T[] {
    const shuffled = [...array].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, size);
  }

  async initialize(): Promise<void> {
    // No initialization needed for fake calendar
  }

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
  private _httpSession: unknown; // Would need proper HTTP client type
  private _lkEventId?: number;
  private _logger: unknown; // Would need proper logger type

  constructor(options: { apiKey: string; timezone: string }) {
    this.tz = options.timezone;
    this._apiKey = options.apiKey;
    // Note: This would need proper HTTP client implementation in TypeScript
    // For now, we'll leave this as a placeholder since it requires additional dependencies
    this._logger = console; // Simple fallback for logging
  }

  async initialize(): Promise<void> {
    throw new Error(
      'CalComCalendar not fully implemented in TypeScript version yet. Use FakeCalendar for testing.',
    );

    // Implementation would require:
    // 1. HTTP client (like axios or fetch)
    // 2. Proper error handling
    // 3. JSON parsing
    //
    // Example implementation structure:
    // const response = await fetch(`${BASE_URL}me/`, {
    //   headers: this._buildHeaders({ apiVersion: '2024-06-14' })
    // });
    // const data = await response.json();
    // const username = data.data.username;
    // this._logger.info(`using cal.com username: ${username}`);
  }

  async scheduleAppointment(options: { startTime: Date; attendeeEmail: string }): Promise<void> {
    throw new Error(
      'CalComCalendar not fully implemented in TypeScript version yet. Use FakeCalendar for testing.',
    );
  }

  async listAvailableSlots(options: { startTime: Date; endTime: Date }): Promise<AvailableSlot[]> {
    throw new Error(
      'CalComCalendar not fully implemented in TypeScript version yet. Use FakeCalendar for testing.',
    );
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
