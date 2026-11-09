<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Front desk

The front desk demo from the LiveKit homepage. Riley answers the phone at Juniper Health, Dr. Maya
Okafor's practice, to show how a voice agent checks who's calling before it opens a patient's
records. The clinic, its patients, and its calendar are made up.

## The calls

- **Inbound, front desk:** Riley finds the caller's chart by their date of birth and the spelling of
  their name, or registers them as a new patient. Then it books an appointment or moves one they
  already have.
- **Outbound, confirmation call:** Riley calls a patient about their next appointment, verifies
  them with a demo note that any date of birth will do, and confirms it. It takes a note for the
  doctor, or moves the appointment if the time no longer works.

The job metadata picks the call. `"direction": "outbound"` makes it the confirmation call, and
`"dial"`, with `"trunk"` and `"from"`, rings a real phone. Otherwise the agent waits for someone to
join the room.

## How it's built

- `frontdesk_agent.ts` is the entrypoint for the `homepage-front-desk` agent.
- `receptionist.ts` holds Riley's two roles, `Receptionist` and `ConfirmationCall`, with their
  instructions and tools.
- `clinic.ts` is the made-up clinic: its charts, calendar, and appointments. It publishes each
  change as a `clinic.*` attribute for the demo page.
- `clinic_data.ts` is the exact runtime seed for the clinic, patients, open times, and appointments.
- `simulation.ts` grades a simulated call against the scenario's `expected` userdata.
- `suggested_replies.ts` publishes the page's "try saying" suggestions.
- `phone.ts` rings a real phone for an outbound call.

The voice pipeline runs on LiveKit Inference: `assemblyai/universal-3-6-pro` for speech to text,
Gemma 4 31B (`google/gemma-4-31b-it`) as the LLM, Rime Coda (`rime/coda`) for the voice, and the
LiveKit turn detector. Suggested replies also use Gemma 4 31B. Background voice cancellation
provides the target SDK's available call audio enhancement.

The demo page reads the `clinic.*` attributes, so changing their shape needs a matching frontend
change.

## Run it locally

```console
pnpm build
lk app env --write --destination .env.local
node examples/dist/homepage/frontdesk/frontdesk_agent.js dev
```

## Tests and simulations

From the repository root:

```console
pnpm exec vitest run examples/src/homepage/frontdesk/verification.test.ts examples/src/homepage/frontdesk/confirmation_call.test.ts
lk agent simulate text --scenarios examples/src/homepage/frontdesk/scenarios.yaml
```

The quiet-caller scenario needs real silence, so it is in `scenarios-audio.yaml`.
