<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Card verification

The card verification demo from the LiveKit homepage. Avery plays a card services agent at
Kestrel Bank, a made-up bank, to show how a voice agent verifies a caller before it touches their
account.

Nothing is real. Any name and birthday work, and the card's last four digits decide the check:
`1111` passes and anything else, like `0000`, fails. Three failed checks lock the caller out for
the rest of the call.

## The calls

- **Inbound, card services:** Avery verifies the caller, then looks into a charge they don't
  recognize, locks a lost card, or sets a travel notice. A charge they didn't make locks the card
  and opens a loss prevention case. Anything else goes to a card specialist.
- **Outbound, fraud alert:** Avery calls about a flagged purchase abroad, confirms the cardholder
  by name and birthday, and asks whether they made it. If they didn't, the card is locked and the
  case goes to loss prevention.

The job metadata picks the call. `"direction": "outbound"` makes it the fraud alert, and `"dial"`,
with `"trunk"` and `"from"`, rings a real phone. Otherwise the agent waits for someone to join the
room.

## How it's built

- `card_auth_agent.ts` is the entrypoint for the `card-verification` agent.
- `card_services.ts` holds Avery's two roles, `CardServices` and `FraudAlert`.
- `bank.ts` is the made-up bank and publishes each change as an `auth.*` attribute.
- `simulation.ts` grades calls against scenario `expected` userdata.
- `suggested_replies.ts` publishes the page's "try saying" suggestions.
- `phone.ts` rings a real phone for an outbound call.

The voice pipeline runs on LiveKit Inference: `assemblyai/universal-3-6-pro` for speech to text,
Gemma 4 31B (`google/gemma-4-31b-it`) as the LLM, Rime Coda (`rime/coda`) for the voice, and the
LiveKit turn detector. Suggested replies also use Gemma 4 31B, and LiveKit background voice
cancellation cleans up the caller's audio.

The demo page reads the `auth.*` attributes, so changing their shape needs a matching change to the
page.

## Run it locally

From the repository root:

```console
pnpm build
node examples/dist/homepage/card-auth/card_auth_agent.js dev
```

Then talk to it in the [Agent Console](https://docs.livekit.io/testing/agent-console/).

## Tests and simulations

```console
pnpm exec vitest run examples/src/homepage/card-auth/verification.test.ts
lk agent simulate text examples/dist/homepage/card-auth/card_auth_agent.js --scenarios examples/src/homepage/card-auth/scenarios.yaml
```

Each scenario's `expected` userdata says what the bank should end up with. The quiet-caller scenario
needs real silence, so run it in audio mode with `scenarios-audio.yaml`.
