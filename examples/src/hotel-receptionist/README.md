<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Hotel Receptionist Example

A phone-oriented hotel front-desk agent for The LiveKit Hotel.

The example demonstrates room booking, restaurant reservations, booking verification and changes, card collection/update, policy lookup, privacy-safe guest messages, wake-up calls, concierge requests, group inquiries, and overbooking recovery.

For setup instructions and more details, see the [main README](../../../README.md).

The example is split across three files: [`hotel_db.ts`](./hotel_db.ts) is the in-memory inventory and booking store (seeded with demo bookings), [`policies.ts`](./policies.ts) builds the `lookupPolicy` tool from the hotel's policy text, and [`hotel_receptionist.ts`](./hotel_receptionist.ts) defines `HotelReceptionistAgent` and the `GetCardTask` card-capture workflow.

Set `HOTEL_TODAY=YYYY-MM-DD` for deterministic relative-date behavior during manual runs.
