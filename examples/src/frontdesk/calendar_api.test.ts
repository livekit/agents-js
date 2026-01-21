// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CalComCalendar,
  FakeCalendar,
  SlotUnavailableError,
  createAvailableSlot,
  getUniqueHash,
} from './calendar_api.js';

describe('Calendar API', () => {
  describe('createAvailableSlot', () => {
    it('should create a valid AvailableSlot', () => {
      const startTime = new Date('2025-01-20T10:00:00Z');
      const durationMin = 30;

      const slot = createAvailableSlot(startTime, durationMin);

      expect(slot.startTime).toEqual(startTime);
      expect(slot.durationMin).toBe(durationMin);
    });
  });

  describe('getUniqueHash', () => {
    it('should generate consistent hash for same slot', () => {
      const slot = createAvailableSlot(new Date('2025-01-20T10:00:00Z'), 30);

      const hash1 = getUniqueHash(slot);
      const hash2 = getUniqueHash(slot);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^ST_[a-z0-9]+$/);
    });

    it('should generate different hashes for different slots', () => {
      const slot1 = createAvailableSlot(new Date('2025-01-20T10:00:00Z'), 30);
      const slot2 = createAvailableSlot(new Date('2025-01-20T10:30:00Z'), 30);

      const hash1 = getUniqueHash(slot1);
      const hash2 = getUniqueHash(slot2);

      expect(hash1).not.toBe(hash2);
    });

    it('should generate different hashes for different durations', () => {
      const startTime = new Date('2025-01-20T10:00:00Z');
      const slot1 = createAvailableSlot(startTime, 30);
      const slot2 = createAvailableSlot(startTime, 60);

      const hash1 = getUniqueHash(slot1);
      const hash2 = getUniqueHash(slot2);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('FakeCalendar', () => {
    let calendar: FakeCalendar;

    beforeEach(() => {
      calendar = new FakeCalendar({ timezone: 'America/New_York' });
    });

    it('should initialize without error', async () => {
      await expect(calendar.initialize()).resolves.not.toThrow();
    });

    it('should generate weekday slots only', async () => {
      await calendar.initialize();

      const startTime = new Date('2025-01-20T00:00:00Z');
      const endTime = new Date('2025-01-27T00:00:00Z');

      const slots = await calendar.listAvailableSlots({ startTime, endTime });

      // Check that all slots are on weekdays
      for (const slot of slots) {
        const dayOfWeek = slot.startTime.getDay();
        expect(dayOfWeek).toBeGreaterThan(0);
        expect(dayOfWeek).toBeLessThan(6);
      }
    });

    it('should generate slots within business hours', async () => {
      await calendar.initialize();

      const startTime = new Date('2025-01-20T00:00:00Z');
      const endTime = new Date('2025-01-21T00:00:00Z');

      const slots = await calendar.listAvailableSlots({ startTime, endTime });

      // Check that all slots are within business hours (9-17)
      for (const slot of slots) {
        const hour = slot.startTime.getHours();
        expect(hour).toBeGreaterThanOrEqual(9);
        expect(hour).toBeLessThan(17);
      }
    });

    it('should filter slots by date range', async () => {
      await calendar.initialize();

      const startTime = new Date('2025-01-20T00:00:00Z');
      const endTime = new Date('2025-01-21T00:00:00Z');

      const slots = await calendar.listAvailableSlots({ startTime, endTime });

      for (const slot of slots) {
        expect(slot.startTime.getTime()).toBeGreaterThanOrEqual(startTime.getTime());
        expect(slot.startTime.getTime()).toBeLessThan(endTime.getTime());
      }
    });

    it('should schedule appointment and remove slot', async () => {
      const predefinedSlots = [
        createAvailableSlot(new Date('2025-01-20T10:00:00Z'), 30),
        createAvailableSlot(new Date('2025-01-20T11:00:00Z'), 30),
      ];

      calendar = new FakeCalendar({
        timezone: 'America/New_York',
        slots: predefinedSlots,
      });

      await calendar.initialize();

      await calendar.scheduleAppointment({
        startTime: predefinedSlots[0]!.startTime,
        attendeeEmail: 'test@example.com',
      });

      const remainingSlots = await calendar.listAvailableSlots({
        startTime: new Date('2025-01-20T00:00:00Z'),
        endTime: new Date('2025-01-21T00:00:00Z'),
      });

      expect(remainingSlots).toHaveLength(1);
      expect(remainingSlots[0]!.startTime).toEqual(predefinedSlots[1]!.startTime);
    });

    it('should work with custom slots', async () => {
      const customSlots = [
        createAvailableSlot(new Date('2025-01-20T14:00:00Z'), 30),
        createAvailableSlot(new Date('2025-01-20T15:30:00Z'), 60),
      ];

      calendar = new FakeCalendar({
        timezone: 'UTC',
        slots: customSlots,
      });

      await calendar.initialize();

      const slots = await calendar.listAvailableSlots({
        startTime: new Date('2025-01-20T00:00:00Z'),
        endTime: new Date('2025-01-21T00:00:00Z'),
      });

      expect(slots).toHaveLength(2);
      expect(slots).toEqual(expect.arrayContaining(customSlots));
    });
  });

  describe('CalComCalendar (mocked)', () => {
    let calendar: CalComCalendar;

    beforeEach(() => {
      calendar = new CalComCalendar({
        apiKey: 'test-api-key',
        timezone: 'America/New_York',
      });

      global.fetch = vi.fn();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    describe('initialize', () => {
      it('should initialize successfully with existing event type', async () => {
        const mockFetch = vi.mocked(fetch);

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: { username: 'testuser' },
          }),
        } as Response);

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: [{ id: 123, slug: 'livekit-front-desk' }],
          }),
        } as Response);

        const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

        await calendar.initialize();

        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(consoleSpy).toHaveBeenCalledWith('[cal.com] using cal.com username: testuser');
        expect(consoleSpy).toHaveBeenCalledWith('[cal.com] event type id: 123');

        consoleSpy.mockRestore();
      });

      it('should create new event type when not exists', async () => {
        const mockFetch = vi.mocked(fetch);

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: { username: 'testuser' },
          }),
        } as Response);

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: [],
          }),
        } as Response);

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: { id: 456 },
          }),
        } as Response);

        const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

        await calendar.initialize();

        expect(mockFetch).toHaveBeenCalledTimes(3);
        expect(consoleSpy).toHaveBeenCalledWith('[cal.com] using cal.com username: testuser');
        expect(consoleSpy).toHaveBeenCalledWith(
          '[cal.com] successfully added livekit-front-desk event type',
        );
        expect(consoleSpy).toHaveBeenCalledWith('[cal.com] event type id: 456');

        consoleSpy.mockRestore();
      });

      it('should handle API errors', async () => {
        const mockFetch = vi.mocked(fetch);

        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
        } as Response);

        await expect(calendar.initialize()).rejects.toThrow(
          'Failed to get user info: 401 Unauthorized',
        );
      });
    });

    describe('scheduleAppointment', () => {
      beforeEach(async () => {
        const mockFetch = vi.mocked(fetch);

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: { username: 'testuser' } }),
        } as Response);

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: [{ id: 123, slug: 'livekit-front-desk' }] }),
        } as Response);

        vi.spyOn(console, 'info').mockImplementation(() => {});
        await calendar.initialize();
        vi.mocked(console.info).mockRestore();

        mockFetch.mockClear();
      });

      it('should schedule appointment successfully', async () => {
        const mockFetch = vi.mocked(fetch);

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true }),
        } as Response);

        await calendar.scheduleAppointment({
          startTime: new Date('2025-01-20T10:00:00Z'),
          attendeeEmail: 'test@example.com',
        });

        expect(mockFetch).toHaveBeenCalledWith(
          'https://api.cal.com/v2/bookings',
          expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
              Authorization: 'Bearer test-api-key',
              'cal-api-version': '2024-08-13',
            }),
            body: JSON.stringify({
              start: '2025-01-20T10:00:00.000Z',
              attendee: {
                name: 'test@example.com',
                email: 'test@example.com',
                timeZone: 'America/New_York',
              },
              eventTypeId: 123,
            }),
          }),
        );
      });

      it('should throw SlotUnavailableError for booking conflicts', async () => {
        const mockFetch = vi.mocked(fetch);

        mockFetch.mockResolvedValueOnce({
          ok: false,
          json: async () => ({
            error: {
              message: 'User either already has booking at this time or is not available',
            },
          }),
        } as Response);

        await expect(
          calendar.scheduleAppointment({
            startTime: new Date('2025-01-20T10:00:00Z'),
            attendeeEmail: 'test@example.com',
          }),
        ).rejects.toThrow(SlotUnavailableError);
      });

      it('should handle other API errors', async () => {
        const mockFetch = vi.mocked(fetch);

        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          json: async () => ({}),
        } as Response);

        await expect(
          calendar.scheduleAppointment({
            startTime: new Date('2025-01-20T10:00:00Z'),
            attendeeEmail: 'test@example.com',
          }),
        ).rejects.toThrow('Failed to schedule appointment: 500 Internal Server Error');
      });
    });

    describe('listAvailableSlots', () => {
      beforeEach(async () => {
        const mockFetch = vi.mocked(fetch);

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: { username: 'testuser' } }),
        } as Response);

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: [{ id: 123, slug: 'livekit-front-desk' }] }),
        } as Response);

        vi.spyOn(console, 'info').mockImplementation(() => {});
        await calendar.initialize();
        vi.mocked(console.info).mockRestore();

        mockFetch.mockClear();
      });

      it('should list available slots successfully', async () => {
        const mockFetch = vi.mocked(fetch);

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: {
              '2025-01-20': [{ start: '2025-01-20T10:00:00Z' }, { start: '2025-01-20T11:00:00Z' }],
            },
          }),
        } as Response);

        const startTime = new Date('2025-01-20T00:00:00Z');
        const endTime = new Date('2025-01-21T00:00:00Z');

        const slots = await calendar.listAvailableSlots({ startTime, endTime });

        expect(slots).toHaveLength(2);
        expect(slots[0]!.startTime).toEqual(new Date('2025-01-20T10:00:00Z'));
        expect(slots[0]!.durationMin).toBe(30);
        expect(slots[1]!.startTime).toEqual(new Date('2025-01-20T11:00:00Z'));
        expect(slots[1]!.durationMin).toBe(30);

        expect(mockFetch).toHaveBeenCalledWith(
          'https://api.cal.com/v2/slots/?eventTypeId=123&start=2025-01-20T00%3A00%3A00.000Z&end=2025-01-21T00%3A00%3A00.000Z',
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: 'Bearer test-api-key',
              'cal-api-version': '2024-09-04',
            }),
          }),
        );
      });

      it('should handle API errors', async () => {
        const mockFetch = vi.mocked(fetch);

        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: 'Not Found',
        } as Response);

        const startTime = new Date('2025-01-20T00:00:00Z');
        const endTime = new Date('2025-01-21T00:00:00Z');

        await expect(calendar.listAvailableSlots({ startTime, endTime })).rejects.toThrow(
          'Failed to get available slots: 404 Not Found',
        );
      });

      it('should return empty array when no slots available', async () => {
        const mockFetch = vi.mocked(fetch);

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: {} }),
        } as Response);

        const startTime = new Date('2025-01-20T00:00:00Z');
        const endTime = new Date('2025-01-21T00:00:00Z');

        const slots = await calendar.listAvailableSlots({ startTime, endTime });

        expect(slots).toHaveLength(0);
      });
    });
  });

  describe('SlotUnavailableError', () => {
    it('should create error with correct name and message', () => {
      const message = 'Slot is not available';
      const error = new SlotUnavailableError(message);

      expect(error.name).toBe('SlotUnavailableError');
      expect(error.message).toBe(message);
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('FakeCalendar end-to-end', () => {
    it('should work as a complete calendar system', async () => {
      const calendar = new FakeCalendar({ timezone: 'UTC' });
      await calendar.initialize();

      // Find the next weekday (FakeCalendar skips weekends)
      const nextWeekday = new Date();
      nextWeekday.setDate(nextWeekday.getDate() + 1);
      while (nextWeekday.getDay() === 0 || nextWeekday.getDay() === 6) {
        nextWeekday.setDate(nextWeekday.getDate() + 1);
      }
      nextWeekday.setHours(0, 0, 0, 0);

      const dayAfter = new Date(nextWeekday);
      dayAfter.setDate(dayAfter.getDate() + 1);

      const slots = await calendar.listAvailableSlots({
        startTime: nextWeekday,
        endTime: dayAfter,
      });

      expect(slots.length).toBeGreaterThan(0);

      const firstSlot = slots[0]!;
      await calendar.scheduleAppointment({
        startTime: firstSlot.startTime,
        attendeeEmail: 'test@example.com',
      });

      const remainingSlots = await calendar.listAvailableSlots({
        startTime: nextWeekday,
        endTime: dayAfter,
      });

      expect(remainingSlots.length).toBe(slots.length - 1);
      expect(
        remainingSlots.find((slot) => slot.startTime.getTime() === firstSlot.startTime.getTime()),
      ).toBeUndefined();
    });
  });
});
