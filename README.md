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

Looking for the Python library? Check out [Agents](https://github.com/livekit/agents).

<!--END_DESCRIPTION-->

## ✨ 1.0 Release ✨

This README reflects the 1.0 release. See the [migration guide](https://docs.livekit.io/agents/start/v0-migration/nodejs/) if you're trying to upgrade from `0.x`.

## Features

- **Flexible integrations**: A comprehensive ecosystem to mix and match the right STT, LLM, TTS, and Realtime API to suit your use case.
- **Extensive WebRTC clients**: Build client applications using LiveKit's open-source SDK ecosystem, supporting all major platforms.
- **Exchange data with clients**: Use [RPCs](https://docs.livekit.io/home/client/data/rpc/) and other [Data APIs](https://docs.livekit.io/home/client/data/) to seamlessly exchange data with clients.
- **Semantic turn detection**: Uses a transformer model to detect when a user is done with their turn, helps to reduce interruptions.
- **Open-source**: Fully open-source, allowing you to run the entire stack on your own servers, including [LiveKit server](https://github.com/livekit/livekit), one of the most widely used WebRTC media servers.

## Installation

The framework includes a variety of plugins that make it easy to process streaming input or generate
output. For example, there are plugins for converting text-to-speech or running inference with
popular LLMs.

- Install `pnpm` if you haven't already:

```bash
npm install -g pnpm
```

To install the core Agents library as well as plugins, run:

```bash
pnpm install @livekit/agents
```

Currently, only the following plugins are supported:

| Plugin                                                                                               | Features      |
| ---------------------------------------------------------------------------------------------------- | ------------- |
| [@livekit/agents-plugin-openai](https://www.npmjs.com/package/@livekit/agents-plugin-openai)         | LLM, TTS, STT |
| [@livekit/agents-plugin-google](https://www.npmjs.com/package/@livekit/agents-plugin-google)         | LLM, TTS      |
| [@livekit/agents-plugin-deepgram](https://www.npmjs.com/package/@livekit/agents-plugin-deepgram)     | STT           |
| [@livekit/agents-plugin-elevenlabs](https://www.npmjs.com/package/@livekit/agents-plugin-elevenlabs) | TTS           |
| [@livekit/agents-plugin-cartesia](https://www.npmjs.com/package/@livekit/agents-plugin-cartesia)     | TTS           |
| [@livekit/agents-plugin-neuphonic](https://www.npmjs.com/package/@livekit/agents-plugin-neuphonic)   | TTS           |
| [@livekit/agents-plugin-resemble](https://www.npmjs.com/package/@livekit/agents-plugin-resemble)     | TTS           |
| [@livekit/agents-plugin-silero](https://www.npmjs.com/package/@livekit/agents-plugin-silero)         | VAD           |
| [@livekit/agents-plugin-livekit](https://www.npmjs.com/package/@livekit/agents-plugin-livekit)       | EOU           |

## Docs and guides

Documentation on the framework and how to use it can be found [here](https://docs.livekit.io/agents/)

## Core concepts

- Agent: An LLM-based application with defined instructions.
- AgentSession: A container for agents that manages interactions with end users.
- entrypoint: The starting point for an interactive session, similar to a request handler in a web server.
- Worker: The main process that coordinates job scheduling and launches agents for user sessions.

## Usage

Checkout the [quickstart guide](https://docs.livekit.io/agents/start/voice-ai/)

### Simple voice agent

---

```ts
import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  llm,
  voice,
} from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const lookupWeather = llm.tool({
  description: 'Used to look up weather information.',
  parameters: z.object({
    location: z.string().describe('The location to look up weather information for'),
  }),
  execute: async ({ location }, { ctx }) => {
    return { weather: 'sunny', temperature: 70 };
  },
});

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    const agent = new voice.Agent({
      instructions: 'You are a friendly voice assistant built by LiveKit.',
      tools: { lookupWeather },
    });

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad! as silero.VAD,
      stt: new deepgram.STT(),
      llm: new openai.LLM(),
      tts: new elevenlabs.TTS(),
    });

    await session.start({
      agent,
      room: ctx.room,
    });

    await session.generateReply({
      instructions: 'greet the user and ask about their day',
    });
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
```

You'll need the following environment variables for this example:

- DEEPGRAM_API_KEY
- OPENAI_API_KEY
- ELEVEN_API_KEY

### Multi-agent handoff

---

This code snippet is abbreviated. For the full example, see [multi_agent.ts](examples/src/multi_agent.ts)

```ts
type StoryData = {
  name?: string;
  location?: string;
};

class IntroAgent extends voice.Agent<StoryData> {
  constructor() {
    super({
      instructions: `You are a story teller. Your goal is to gather a few pieces of information from the user to make the story personalized and engaging. Ask the user for their name and where they are from.`,
      tools: {
        informationGathered: llm.tool({
          description:
            'Called when the user has provided the information needed to make the story personalized and engaging.',
          parameters: z.object({
            name: z.string().describe('The name of the user'),
            location: z.string().describe('The location of the user'),
          }),
          execute: async ({ name, location }, { ctx }) => {
            ctx.userData.name = name;
            ctx.userData.location = location;

            return llm.handoff({
              agent: new StoryAgent(name, location),
              returns: "Let's start the story!",
            });
          },
        }),
      },
    });
  }

  // Use inheritance to create agent with custom hooks
  async onEnter() {
    this.session.generateReply({
      instructions: '"greet the user and gather information"',
    });
  }
}

class StoryAgent extends voice.Agent<StoryData> {
  constructor(name: string, location: string) {
    super({
      instructions: `You are a storyteller. Use the user's information in order to make the story personalized.
        The user's name is ${name}, from ${location}`,
    });
  }

  async onEnter() {
    this.session.generateReply();
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    const participant = await ctx.waitForParticipant();
    console.log('participant joined: ', participant.identity);

    const userdata: StoryData = {};

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad! as silero.VAD,
      stt: new deepgram.STT(),
      llm: new openai.LLM(),
      tts: new elevenlabs.TTS(),
      userData: userdata,
    });

    await session.start({
      agent: new IntroAgent(),
      room: ctx.room,
    });
  },
});
```

### Running your agent

The framework exposes a CLI interface to run your agent. To get started, you'll need the following
environment variables set:

- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- any additional provider API keys (e.g. `OPENAI_API_KEY`)

The following command will start the worker and wait for users to connect to your LiveKit server:

```bash
pnpm run build && node ./examples/src/restaurant_agent.ts dev
```

### Using playground for your agent UI

To ease the process of building and testing an agent, we've developed a versatile web frontend
called "playground". You can use or modify this app to suit your specific requirements. It can also
serve as a starting point for a completely custom agent application.

- [Hosted playground](https://agents-playground.livekit.io)
- [Source code](https://github.com/livekit/agents-playground)
- [Playground docs](https://docs.livekit.io/agents/playground)

### Running for production

```shell
pnpm run build && node ./examples/src/restaurant_agent.ts start
```

Runs the agent with production-ready optimizations.

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
