<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Azure plugin for LiveKit Agents

The Agents Framework is designed for building realtime, programmable
participants that run on servers. Use it to create conversational, multi-modal
voice agents that can see, hear, and understand.

This package contains the Azure plugin, which supports speech recognition and
Microsoft Foundry decisions.
Refer to the [documentation](https://docs.livekit.io/agents/overview/) for
information on how to use it, or browse the [API
reference](https://docs.livekit.io/agents-js/). See the
[repository](https://github.com/livekit/agents-js) for more information about
the framework as a whole.

## Decision model contract

`DecisionModel` uses
[Microsoft-Decision-1](https://ai.azure.com/catalog/models/Microsoft-Decision-1)
deployed in Microsoft Foundry through the resource's System One endpoint
(`POST <resource endpoint>/providers/microsoft/v1/systemone`). It answers a batch
of probability, choice, and score decisions about the same input in one request:

```ts
import { llm } from '@livekit/agents';
import { DecisionModel } from '@livekit/agents-plugin-azure';

const model = new DecisionModel();
const response = await model.evaluate({
  input: chatCtx,
  decisions: {
    handoff: new llm.Probability('The caller requests a human.'),
    intent: new llm.Choice('Intent?', { booking: 'Reservation', other: 'Other' }),
  },
});
```

Configure the full endpoint and Foundry deployment name with constructor options
or the corresponding environment variables:

| Environment variable                | Constructor option                         |
| ----------------------------------- | ------------------------------------------ |
| `MICROSOFT_AI_DECISION_URL`         | `url`                                      |
| `MICROSOFT_AI_DECISION_API_KEY`     | `apiKey`                                   |
| `MICROSOFT_AI_DECISION_AUTH_HEADER` | `authHeader`: `api-key` or `Authorization` |
| `MICROSOFT_AI_DECISION_MODEL`       | `model` (Foundry deployment name)          |

For example, the URL is
`https://<resource>.services.ai.azure.com/providers/microsoft/v1/systemone`.
TLS is required except for loopback development endpoints. The resource key is
sent as the raw `api-key` header by default; set `authHeader: 'Authorization'`
to send an Entra ID token as `Authorization: Bearer ...`.

The request body is `{ model, state, questions }`: a conversation is sent as its
transcript in `state`, and each decision as a named `noul`, `choice`, or `score`
question. An answer the model declines or that fails validation is reported in
`response.errors` without dropping the rest of the batch. Non-200 responses
raise `APIStatusError` with the response body and request ID; 408, 429, and 5xx
responses are retried according to `connOptions`.
