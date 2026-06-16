<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Hotel Receptionist Example

A phone-oriented hotel front-desk agent for The LiveKit Hotel.

The example demonstrates room booking, restaurant reservations, booking verification and changes, card collection/update, policy lookup, privacy-safe guest messages, wake-up calls, concierge requests, group inquiries, and overbooking recovery.

Run it from the repository root with:

```bash
pnpm build && node ./examples/src/hotel-receptionist/hotel_receptionist.ts dev
```

Set `HOTEL_TODAY=YYYY-MM-DD` for deterministic relative-date behavior during manual runs.
