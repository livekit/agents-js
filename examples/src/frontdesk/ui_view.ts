// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { JobContext } from '@livekit/agents';
import type { AvailableSlot } from './calendar_api.js';

const VIEW_METHOD = 'set_appointment_status';

function formatDate(date: Date, timezone: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', { ...options, timeZone: timezone }).format(date);
}

export class UIView {
  constructor(private readonly ctx: JobContext) {}

  slotsListed(slots: AvailableSlot[], now: Date, timezone: string, rangeDays: number): void {
    if (slots.length === 0) {
      this.push('');
      return;
    }

    const window =
      rangeDays <= 14 ? 'Next 2 weeks' : rangeDays <= 30 ? 'Next month' : 'Next 3 months';
    const last = slots.reduce(
      (latest, slot) => (slot.startTime.getTime() > latest.getTime() ? slot.startTime : latest),
      slots[0]!.startTime,
    );
    const start = formatDate(now, timezone, { month: 'short', day: '2-digit' });
    const end = formatDate(last, timezone, { month: 'short', day: '2-digit' });
    const plural = slots.length === 1 ? 'slot' : 'slots';

    this.push(`**${window}**\n\n[[${slots.length}]] available ${plural} · *${start} - ${end}*`);
  }

  appointmentBooked(slot: AvailableSlot, timezone: string): void {
    const date = formatDate(slot.startTime, timezone, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: '2-digit',
    });
    const time = formatDate(slot.startTime, timezone, {
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
      hour12: false,
    });

    this.push(`**Booked: ${date}**\n\nat [[${time}]]`);
  }

  private push(payload: string): void {
    const participants = this.ctx.room.remoteParticipants.values() as Iterable<{
      identity: string;
    }>;
    for (const participant of participants) {
      void this.pushTo(participant.identity, payload);
    }
  }

  private async pushTo(identity: string, payload: string): Promise<void> {
    try {
      await this.ctx.room.localParticipant?.performRpc({
        destinationIdentity: identity,
        method: VIEW_METHOD,
        payload,
      });
    } catch (error) {
      console.error(`UI push to ${identity} failed`, error);
    }
  }
}
