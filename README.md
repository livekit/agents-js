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
| [@livekit/agents-plugin-deepgram](https://www.npmjs.com/package/@livekit/agents-plugin-deepgram)     | STT, TTS      |
| [@livekit/agents-plugin-elevenlabs](https://www.npmjs.com/package/@livekit/agents-plugin-elevenlabs) | TTS           |
| [@livekit/agents-plugin-cartesia](https://www.npmjs.com/package/@livekit/agents-plugin-cartesia)     | TTS           |
| [@livekit/agents-plugin-neuphonic](https://www.npmjs.com/package/@livekit/agents-plugin-neuphonic)   | TTS           |
| [@livekit/agents-plugin-resemble](https://www.npmjs.com/package/@livekit/agents-plugin-resemble)     | TTS           |
| [@livekit/agents-plugin-rime](https://www.npmjs.com/package/@livekit/agents-plugin-rime)             | TTS           |
| [@livekit/agents-plugin-inworld](https://www.npmjs.com/package/@livekit/agents-plugin-inworld)       | TTS           |
| [@livekit/agents-plugin-silero](https://www.npmjs.com/package/@livekit/agents-plugin-silero)         | VAD           |
| [@livekit/agents-plugin-livekit](https://www.npmjs.com/package/@livekit/agents-plugin-livekit)       | EOU           |
| [@livekit/agents-plugin-anam](https://www.npmjs.com/package/@livekit/agents-plugin-anam)             | Avatar        |
| [@livekit/agents-plugin-bey](https://www.npmjs.com/package/@livekit/agents-plugin-bey)               | Avatar        |
| [@livekit/agents-plugin-lemonslice](https://www.npmjs.com/package/@livekit/agents-plugin-lemonslice) | Avatar        |
| [@livekit/agents-plugin-xai](https://www.npmjs.com/package/@livekit/agents-plugin-xai)               | LLM, TTS      |

## Docs and guides

Documentation on the framework and how to use it can be found [here](https://docs.livekit.io/agents/)

## Recommended starter app

Kickstart a complete voice AI pipeline (LLM, STT, TTS) with the LiveKit Agents Starter for Node.js:

- [livekit-examples/agent-starter-node](https://github.com/livekit-examples/agent-starter-node)

It includes a ready-made assistant, multilingual turn detection, background noise cancellation, metrics/logging, and a production-ready Dockerfile. Start fast, then tailor it with your preferred models and plugins.

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
  inference,
} from '@livekit/agents';
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
    const agent = new voice.Agent({
      instructions: 'You are a friendly voice assistant built by LiveKit.',
      tools: { lookupWeather },
    });

    const session = new voice.AgentSession({
      // Speech-to-text (STT) is your agent's ears, turning the user's speech into text that the LLM can understand
      // See all available models at https://docs.livekit.io/agents/models/stt/
      // stt: new inference.STT({ model: 'assemblyai/universal-streaming:en', language: 'en' }),
      stt: 'assemblyai/universal-streaming:en',
      // A Large Language Model (LLM) is your agent's brain, processing user input and generating a response
      // See all available models at https://docs.livekit.io/agents/models/llm/
      // llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
      llm: 'openai/gpt-4.1-mini',
      // Text-to-speech (TTS) is your agent's voice, turning the LLM's text into speech that the user can hear
      // See all available models as well as voice selections at https://docs.livekit.io/agents/models/tts/
      // tts: new inference.TTS({ model: 'cartesia/sonic-2:9626c31c-bec5-4cca-baa8-f8ba9e84c8bc', voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc' }),
      tts: 'cartesia/sonic-2:9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      // VAD and turn detection are used to determine when the user is speaking and when the agent should respond
      // See more at https://docs.livekit.io/agents/build/turns
      vad: ctx.proc.userData.vad! as silero.VAD,
      turnDetection: new livekit.turnDetector.MultilingualModel(),
      // to use realtime model, replace the stt, llm, tts and vad with the following
      // llm: new openai.realtime.RealtimeModel(),
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

No third-party API keys are required for this example. It runs out of the box via the [LiveKit Inference Gateway](https://docs.livekit.io/agents/models/#inference).

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

## Contributing

To contribute to this project:

1. Fork the [agents-js repository](https://github.com/livekit/agents-js)
2. Create a new branch based on the `main` branch
3. Make your changes
4. Submit a pull request
5. Make sure to complete the pre-review checklist before tagging reviewers

### Testing changes and plugins

To test any changes or plugins:

1. Build the project:
   ```bash
   pnpm build
   ```

2. Edit `./examples/src/basic_agent.ts` as necessary for any plugin changes

3. Run the basic agent with debug logging:
   ```bash
   node ./examples/src/basic_agent.ts dev --log-level=debug
   ```

### Testing agent connectivity

To connect and talk to your agent:

1. Go to the [LiveKit dashboard sandbox section](https://cloud.livekit.io/projects/<your-project-id>/sandbox)
2. Launch a sandbox app called "Web Voice Agent"
3. Run your agent and make sure all LiveKit API keys are configured correctly
4. Click the "START CALL" blue button on the sandbox UI to test the connection and talk to your agent

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
