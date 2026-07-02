// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { CalComCalendar } from './calendar_api.js';

describe('Calendar Integration Tests', () => {
  describe('CalComCalendar with real API', () => {
    it.skipIf(!process.env.CAL_API_KEY)(
      'should initialize with real API key',
      async () => {
        const calendar = new CalComCalendar({
          apiKey: process.env.CAL_API_KEY!,
          timezone: 'America/New_York',
        });

        await expect(calendar.initialize()).resolves.not.toThrow();
      },
      10000,
    );

    it.skipIf(!process.env.CAL_API_KEY)(
      'should list available slots with real API key',
      async () => {
        const calendar = new CalComCalendar({
          apiKey: process.env.CAL_API_KEY!,
          timezone: 'America/New_York',
        });

        await calendar.initialize();

        const startTime = new Date();
        startTime.setDate(startTime.getDate() + 1);
        const endTime = new Date(startTime);
        endTime.setDate(endTime.getDate() + 7);

        const slots = await calendar.listAvailableSlots({ startTime, endTime });

        expect(Array.isArray(slots)).toBe(true);
        slots.forEach((slot) => {
          expect(slot.startTime).toBeInstanceOf(Date);
          expect(typeof slot.durationMin).toBe('number');
          expect(slot.durationMin).toBeGreaterThan(0);
        });
      },
      10000,
    );
  });
});
