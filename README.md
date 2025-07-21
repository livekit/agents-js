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
## ✨ 1.0 Internal Beta Release ✨
This README reflects the 1.0 internal release. 

## Installation

The framework includes a variety of plugins that make it easy to process streaming input or generate
output. For example, there are plugins for converting text-to-speech or running inference with
popular LLMs.

To install the core Agents library as well as plugins in your workspace, run:

- Install `pnpm` if you haven't already:
```bash
npm install -g pnpm
```

- Install global dependencies:
```bash
pnpm install -g turbo typescript @types/node
```

- Prepare the environment variables:
```bash
export LIVEKIT_URL=your-livekit-url
export LIVEKIT_API_KEY=your-livekit-api-key
export LIVEKIT_API_SECRET=your-livekit-api-secret

export DEEPGRAM_API_KEY=your-deepgram-api-key
export OPENAI_API_KEY=your-openai-api-key
export ELEVEN_API_KEY=your-eleven-api-key
```

or directly save it to your `~/.zshrc` file to make it permanent.

- Build the workspace:
```bash
pnpm build
```

- Check to see if agent is working:
```bash
node ./examples/src/basic_agent.ts dev --log-level=info
```

- Open [Agent Playground](https://agents-playground.livekit.io), and connect to your LiveKit server having the same `LIVEKIT_URL` and `LIVEKIT_API_KEY` as you configured above.

- Click on "Connect" button, and you should expect to see agent been connected to the room.

Currently, only the following plugins are supported:

| Plugin                                                                                               | Features                    |
|------------------------------------------------------------------------------------------------------|-----------------------------|
| [@livekit/agents-plugin-openai](https://www.npmjs.com/package/@livekit/agents-plugin-openai)         | LLM                         |
| [@livekit/agents-plugin-deepgram](https://www.npmjs.com/package/@livekit/agents-plugin-deepgram)     | STT                         |
| [@livekit/agents-plugin-elevenlabs](https://www.npmjs.com/package/@livekit/agents-plugin-elevenlabs) | TTS                         |
| [@livekit/agents-plugin-silero](https://www.npmjs.com/package/@livekit/agents-plugin-silero)         | VAD                         |


## Usage

### Core concepts

- Agent: An LLM-based application with defined instructions.
- AgentSession: A container for agents that manages interactions with end users.
- entrypoint: The starting point for an interactive session, similar to a request handler in a web server.
- Worker: The main process that coordinates job scheduling and launches agents for user sessions.

You'll need the following environment variables for this example:

- DEEPGRAM_API_KEY
- OPENAI_API_KEY
- ELEVEN_API_KEY

### Current Dev 1.0 Status

We use `llm.tool` to define tools instead of using `@function_tool` decorator in python. Also, to follow idiomatic JS/TS, we use config-based approach to define agents instead of using inheritance (except for the agent hook functions, which is still under discussion on the best way to support). 

> Note: Only do class inheritance if you need to override the agent hook functions. For tool definition, instructions, llm, stt, tts, vad, etc., simply pass the config to the agent constructor. 

Here's an example of overriding the agent hook functions:

```ts
class MyAgent extends voice.Agent<UserData> {
  async onEnter() {
    // ...
  }

  async onExit() {
    // ...
  }

  async onUserTurnCompleted(chatCtx: ChatContext, newMessage: ChatMessage) {
    // ...
  }
}
```

and to fill out the instructions / tools, pass the config to the agent constructor:

```ts
const agent = new MyAgent({
  instructions: 'You are a helpful assistant.',
  tools: { ... },
});
```

Below are some simple examples to help you get started. For more complete examples, check out the code in the [examples](examples/src/) directory.

### Simple voice agent

---

```ts
import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  voice,
  llm,
} from '@livekit/agents';
import { z } from 'zod';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';

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
    const participant = await ctx.waitForParticipant();
    console.log('participant joined: ', participant.identity);

    const agent = new voice.Agent({
      instructions:
        "You are a friendly voice assistant built by LiveKit.",
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

### Multi-agent handoff

---

```ts
type StoryData = {
  name?: string;
  location?: string;
};

// Use inheritance to create agent with custom hooks
class IntroAgent extends voice.Agent<StoryData> {
  async onEnter() {
    this.session.generateReply({
      instructions: '"greet the user and gather information"',
    });
  }

  static create() {
    return new IntroAgent({
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

            const storyAgent = StoryAgent.create(name, location);
            return llm.handoff({ agent: storyAgent, returns: "Let's start the story!" });
          },
        }),
      },
    });
  }
}

class StoryAgent extends voice.Agent<StoryData> {
  async onEnter() {
    this.session.generateReply();
  }

  static create(name: string, location: string) {
    return new StoryAgent({
      instructions: `You are a storyteller. Use the user's information in order to make the story personalized.
        The user's name is ${name}, from ${location}`,
    });
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
      agent: IntroAgent.create(),
      room: ctx.room,
    });
  },
});
```

### Running

The framework exposes a CLI interface to run your agent. To get started, you'll need the following
environment variables set:

- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- any additional provider API keys (e.g. `OPENAI_API_KEY`)

The following command will start the worker and wait for users to connect to your LiveKit server:

```bash
pnpm run build && node ./examples/src/restaurant_agent.ts dev --log-level=debug
```

### Using playground for your agent UI

To ease the process of building and testing an agent, we've developed a versatile web frontend
called "playground". You can use or modify this app to suit your specific requirements. It can also
serve as a starting point for a completely custom agent application.

- [Hosted playground](https://agents-playground.livekit.io)
- [Source code](https://github.com/livekit/agents-playground)
- [Playground docs](https://docs.livekit.io/agents/playground)

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
