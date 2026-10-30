<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# TypeSafe plugin for LiveKit Agents

Support for [TypeSafe](https://typesafe.ai) Jev decision models. Jev evaluates probability
questions, named choices, and ordered scores over a conversation in one request.

## Installation

```bash
pnpm add @livekit/agents-plugin-typesafe
```

## Pre-requisites

Set `TYPESAFE_API_KEY` for the TypeSafe API, or `OPENROUTER_API_KEY` to use Jev through
OpenRouter's Decisions API.

## Usage

```typescript
import { llm } from '@livekit/agents';
import { DecisionModel } from '@livekit/agents-plugin-typesafe';

const model = new DecisionModel({ model: 'jev-latest' });
// or: DecisionModel.withOpenRouter()
const context = llm.ChatContext.empty();
context.addMessage({ role: 'user', content: 'Please let me speak to a person.' });
const response = await model.evaluate({
  input: context,
  decisions: {
    handoff: new llm.Probability('The caller requests a human.'),
    intent: new llm.Choice('What does the caller want?', {
      booking: 'Make a reservation',
      other: 'Anything else',
    }),
    frustration: new llm.Score('How frustrated is the caller?', ['Calm', 'Annoyed', 'Angry']),
  },
});
for (const [name, result] of Object.entries(response.results)) {
  console.log(name, result.value);
}
```

`input` also accepts a string, which is sent as-is. Each requested decision appears in
either `response.results` or `response.errors`. Request failures and malformed responses
throw.

## Models

`jev-latest` is the most recent stable release and `jev-preview` the most recent release
overall; TypeSafe moves both aliases as new versions ship. Pin `jev-1.14.0` or
`jev-1.13.0` for a fixed version.

## Notes

- Jev rounds probabilities and scores to two decimal places. Results keep the provider's
  values.
- Score answers must return a legend that matches the requested levels.
- `providerData.confidence` describes how concentrated the distribution is, not the
  probability that the answer is correct.
- A conversation is sent as a `role: text` transcript of user and assistant messages.
  System and developer messages, agent instructions, and non-text content are never sent.
