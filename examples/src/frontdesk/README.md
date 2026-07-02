<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Frontdesk Example

A front desk agent demonstrating customer service with calendar integration and appointment management.

For setup instructions and more details, see the [main README](../../../README.md).

## Overview

In this example, you can schedule appointments with a fake calendar, or with Cal.com when `CAL_API_KEY` is set. The session begins with the agent saying, "Hello, I can help you schedule an appointment!"

### Scheduling Appointments

The LLM should call `listAvailableSlots` before `scheduleAppointment`, since `slotId` is a required argument.

`listAvailableSlots` returns slots like:

```bash
ST_abc123 - Saturday, January 1, 2000 at 02:00 PM UTC (in 5 days)
```

The slots are also cached as a lookup table for `scheduleAppointment`.

If the slot is invalid, the tool raises a `ToolError` so the LLM can self-correct instead of passing a hallucinated answer.

### Calendar Integration

The example uses `FakeCalendar` by default so it can run locally without external setup. When `CAL_API_KEY` is present, it switches to `CalComCalendar` and books real Cal.com slots through the same `Calendar` interface.

The TypeScript example does not include the Python `GetEmailTask` workflow yet, so `scheduleAppointment` currently uses a placeholder attendee email before calling the calendar API.
