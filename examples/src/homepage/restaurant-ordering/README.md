<!-- SPDX-FileCopyrightText: 2026 LiveKit, Inc. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Restaurant ordering

The restaurant ordering demo from the LiveKit homepage. Gabby answers the phone at Zappi's
Pizzeria, a made-up neighborhood pizzeria in San Francisco, to show how a voice agent takes an
order, reads it back, and sends it to the kitchen.

The inbound call takes menu orders, answers allergen questions, arranges pickup or delivery, and
places the order after a read-back. The outbound call updates order #214 before Marco leaves,
including a same-price drink swap, breadsticks, driver notes, or cancellation.

`restaurant_ordering.ts` is the entrypoint, `order_desk.ts` contains both roles and their tools,
`pizzeria.ts` is the point of sale, `pizzeria_data.ts` is the exact menu seed, `simulation.ts`
grades scenarios, `suggested_replies.ts` drives the homepage suggestions, and `phone.ts` places
real outbound calls. The page consumes the published `restaurant.*` participant attributes.

The pipeline uses LiveKit Inference with AssemblyAI Universal-3 Pro, Gemma 4 31B, Fish Audio S2.1
Pro, the LiveKit turn detector, and the target runtime's background voice cancellation.

Run the example from the repository root after configuring LiveKit credentials:

```console
pnpm build
node examples/dist/homepage/restaurant-ordering/restaurant_ordering.js dev
```

Run its tests and simulations with:

```console
pnpm --filter livekit-agents-examples test -- src/homepage/restaurant-ordering/pizzeria.test.ts
lk agent simulate text --scenarios examples/src/homepage/restaurant-ordering/scenarios.yaml
```
