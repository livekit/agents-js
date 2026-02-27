<!--
SPDX-FileCopyrightText: 2024 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->
# Cartesia plugin for LiveKit Agents

The Agents Framework is designed for building realtime, programmable
participants that run on servers. Use it to create conversational, multi-modal
voice agents that can see, hear, and understand.

This package contains the Cartesia plugin, which allows for voice synthesis.
Refer to the [documentation](https://docs.livekit.io/agents/overview/) for
information on how to use it, or browse the [API
reference](https://docs.livekit.io/agents-js/modules/plugins_agents_plugin_cartesia.html).
See the [repository](https://github.com/livekit/agents-js) for more information
about the framework as a whole.

## Troubleshooting

If you see `AggregateError` / `ETIMEDOUT` on the first Cartesia connection in Node.js (often due to IPv6/IPv4 “happy eyeballs”), you can mitigate it by:

- Setting a longer Node autoselection attempt timeout (example): `NODE_OPTIONS="--network-family-autoselection-attempt-timeout=5000"`
- Increasing the agent session TTS connect timeout via `connOptions.ttsConnOptions.timeoutMs`
