<!--
SPDX-FileCopyrightText: 2024 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

<!--BEGIN_BANNER_IMAGE-->

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="/.github/banner_dark.png">
  <source media="(prefers-color-scheme: light)" srcset="/.github/banner_light.png">
  <img style="width:100%;" alt="The LiveKit icon, the name of the repository and some sample code in the background." src="https://raw.githubusercontent.com/livekit/agents-js/main/.github/banner_light.png">
</picture>

<!--END_BANNER_IMAGE-->

# LiveKit Agents for Node.js

<!--BEGIN_DESCRIPTION-->

The Agent Framework is designed for building realtime, programmable participants that run on
servers. Use it to create conversational, multi-modal voice agents that can see, hear, and
understand.

This is a Node.js distribution of the [LiveKit Agents framework](https://livekit.io/agents),
originally written in Python.

<!--END_DESCRIPTION-->

## ✨ [NEW] In-house phrase endpointing model

We’ve trained a new, open weights phrase endpointing model that significantly improves end-of-turn
detection and conversational flow between voice agents and users by reducing agent interruptions.
Optimized to run on CPUs, it’s available via [`@livekit/agents-plugin-livekit`](plugins/livekit)
package.

> [!WARNING]
> This SDK is in beta. During this period, you may encounter bugs, and the APIs may change.
>
> For production, we recommend using the [more mature version](https://github.com/livekit/agents)
> of this framework, built with Python, which supports a larger number of integrations.
>
> We welcome and appreciate any feedback or contributions. You can create issues here or chat live
> with us in the [LiveKit Community Slack](https://livekit.io/join-slack).

## Installation

To install the core Agents library:

```bash
pnpm install @livekit/agents
```

The framework includes a variety of plugins that make it easy to process streaming input or generate
output. For example, there are plugins for converting text-to-speech or running inference with
popular LLMs. To install a plugin:

```bash
pnpm install @livekit/agents-plugin-openai
```

The following plugins are available today:

| Plugin                                                                                               | Features                    |
|------------------------------------------------------------------------------------------------------|-----------------------------|
| [@livekit/agents-plugin-openai](https://www.npmjs.com/package/@livekit/agents-plugin-openai)         | STT, LLM, TTS, Realtime API |
| [@livekit/agents-plugin-deepgram](https://www.npmjs.com/package/@livekit/agents-plugin-deepgram)     | STT                         |
| [@livekit/agents-plugin-elevenlabs](https://www.npmjs.com/package/@livekit/agents-plugin-elevenlabs) | TTS                         |
| [@livekit/agents-plugin-cartesia](https://www.npmjs.com/package/@livekit/agents-plugin-cartesia)     | TTS                         |
| [@livekit/agents-plugin-resemble](https://www.npmjs.com/package/@livekit/agents-plugin-resemble)     | TTS                         |
| [@livekit/agents-plugin-neuphonic](https://www.npmjs.com/package/@livekit/agents-plugin-neuphonic)   | TTS                         |
| [@livekit/agents-plugin-silero](https://www.npmjs.com/package/@livekit/agents-plugin-silero)         | VAD                         |
| [@livekit/agents-plugin-livekit](https://www.npmjs.com/package/@livekit/agents-plugin-livekit)       | End-of-turn detection       |

## Usage

First, a few concepts:

- **Agent**: A function that defines the workflow of a programmable, server-side participant. This
  is your application code.
- **Worker**: A container process responsible for managing job queuing with LiveKit server. Each
  worker is capable of running multiple agents simultaneously.
- **Plugin**: A library class that performs a specific task, *e.g.* speech-to-text, from a specific
  provider. An agent can compose multiple plugins together to perform more complex tasks.

Your main file for an agent is built of two parts:

- The boilerplate code that runs when you run this file, creating a new worker to orchestrate jobs
- The code that is exported when this file is imported into Agents, to be ran on all jobs (which
  includes your entrypoint function, and an optional prewarm function)

Refer to the [minimal voice assistant](/examples/src/multimodal_agent.ts) example to understand
how to build a simple voice assistant with function calling using OpenAI's model.

## Running

The framework exposes a CLI interface to run your agent. To get started, you'll need the following
environment variables set:

- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- any additional provider API keys (e.g. `OPENAI_API_KEY`)

The following command will start the worker and wait for users to connect to your LiveKit server:

```bash
node my_agent.js start
```

To run the worker in dev mode (outputting colourful pretty-printed debug logs), run it using `dev`:

```bash
node my_agent.js dev
```

### Using playground for your agent UI

To ease the process of building and testing an agent, we've developed a versatile web frontend
called "playground". You can use or modify this app to suit your specific requirements. It can also
serve as a starting point for a completely custom agent application.

- [Hosted playground](https://agents-playground.livekit.io)
- [Source code](https://github.com/livekit/agents-playground)
- [Playground docs](https://docs.livekit.io/agents/playground)

### Joining a specific room

To join a LiveKit room that's already active, you can use the `connect` command:

```bash
node my_agent.ts connect --room <my-room>
```

### FAQ

#### What happens when I run my agent?

When you follow the steps above to run your agent, a worker is started that opens an authenticated
WebSocket connection to a LiveKit server instance(defined by your `LIVEKIT_URL` and authenticated
with an access token).

No agents are actually running at this point. Instead, the worker is waiting for LiveKit server to
give it a job.

When a room is created, the server notifies one of the registered workers about a new job.
The notified worker can decide whether or not to accept it. If the worker accepts the job, the
worker will instantiate your agent as a participant and have it join the room where it can start
subscribing to tracks. A worker can manage multiple agent instances simultaneously.

If a notified worker rejects the job or does not accept within a predetermined timeout period, the
server will route the job request to another available worker.

#### What happens when I SIGTERM a worker?

The orchestration system was designed for production use cases. Unlike the typical web server, an
agent is a stateful program, so it's important that a worker isn't terminated while active sessions
are ongoing.

When calling SIGTERM on a worker, the worker will signal to LiveKit server that it no longer wants
additional jobs. It will also auto-reject any new job requests that get through before the server
signal is received. The worker will remain alive while it manages any agents connected to rooms.

## License

This project is licensed under `Apache-2.0`, and is [REUSE-3.2](https://reuse.software) compliant.
Refer to [the license](LICENSES/Apache-2.0.txt) for details.
<!--BEGIN_REPO_NAV-->
<br/><table>
<thead><tr><th colspan="2">LiveKit Ecosystem</th></tr></thead>
<tbody>
<tr><td>LiveKit SDKs</td><td><a href="https://github.com/livekit/client-sdk-js">Browser</a> · <a href="https://github.com/livekit/client-sdk-swift">iOS/macOS/visionOS</a> · <a href="https://github.com/livekit/client-sdk-android">Android</a> · <a href="https://github.com/livekit/client-sdk-flutter">Flutter</a> · <a href="https://github.com/livekit/client-sdk-react-native">React Native</a> · <a href="https://github.com/livekit/rust-sdks">Rust</a> · <a href="https://github.com/livekit/node-sdks">Node.js</a> · <a href="https://github.com/livekit/python-sdks">Python</a> · <a href="https://github.com/livekit/client-sdk-unity">Unity</a> · <a href="https://github.com/livekit/client-sdk-unity-web">Unity (WebGL)</a></td></tr><tr></tr>
<tr><td>Server APIs</td><td><a href="https://github.com/livekit/node-sdks">Node.js</a> · <a href="https://github.com/livekit/server-sdk-go">Golang</a> · <a href="https://github.com/livekit/server-sdk-ruby">Ruby</a> · <a href="https://github.com/livekit/server-sdk-kotlin">Java/Kotlin</a> · <a href="https://github.com/livekit/python-sdks">Python</a> · <a href="https://github.com/livekit/rust-sdks">Rust</a> · <a href="https://github.com/agence104/livekit-server-sdk-php">PHP (community)</a> · <a href="https://github.com/pabloFuente/livekit-server-sdk-dotnet">.NET (community)</a></td></tr><tr></tr>
<tr><td>UI Components</td><td><a href="https://github.com/livekit/components-js">React</a> · <a href="https://github.com/livekit/components-android">Android Compose</a> · <a href="https://github.com/livekit/components-swift">SwiftUI</a></td></tr><tr></tr>
<tr><td>Agents Frameworks</td><td><a href="https://github.com/livekit/agents">Python</a> · <b>Node.js</b> · <a href="https://github.com/livekit/agent-playground">Playground</a></td></tr><tr></tr>
<tr><td>Services</td><td><a href="https://github.com/livekit/livekit">LiveKit server</a> · <a href="https://github.com/livekit/egress">Egress</a> · <a href="https://github.com/livekit/ingress">Ingress</a> · <a href="https://github.com/livekit/sip">SIP</a></td></tr><tr></tr>
<tr><td>Resources</td><td><a href="https://docs.livekit.io">Docs</a> · <a href="https://github.com/livekit-examples">Example apps</a> · <a href="https://livekit.io/cloud">Cloud</a> · <a href="https://docs.livekit.io/home/self-hosting/deployment">Self-hosting</a> · <a href="https://github.com/livekit/livekit-cli">CLI</a></td></tr>
</tbody>
</table>
<!--END_REPO_NAV-->
