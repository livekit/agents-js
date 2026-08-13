# Expressive agent

A free-form voice agent that demonstrates [expressive mode](https://docs.livekit.io/agents/models/tts/expressive/).
There is no task and no tool: you talk to it like a friend, and it matches your
register. Tell it good news and it gets excited; tell it something went wrong
and it drops the energy.

Expressive mode is the single `expressive: true` flag on `AgentSession`. With it
enabled the framework injects the TTS provider's markup guide into the LLM
prompt, so the model emits inline delivery tags (emotion, pacing, non-verbal
sounds) that the TTS renders and the transcript never shows.

## Architecture

- `expressive_agent.ts` is the composition root: session setup and the server entrypoint.
- `prompt.ts` holds the persona only. It steers _what_ the agent says, and
  expressive mode owns _how_ it sounds, so the two never restate each other.

The pipeline uses LiveKit Inference with Gemini 2.5 Flash, AssemblyAI Universal-3.5 Pro,
Fish Audio S2.1 Pro, and the LiveKit turn detector.

## Run locally

Provide LiveKit Cloud credentials in the environment (`LIVEKIT_URL`,
`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`), then from the repository root:

```bash
pnpm build
node ./examples/src/expressive-agent/expressive_agent.ts dev --log-level=debug
```

Use `console` instead of `dev` to talk to it in the terminal.

## Trying it with and without expressive

The comparison is the point of the demo. Run it once with `expressive: true` and
once with `expressive: false`, and say the same thing to each. The words come out
much the same; the delivery does not.

Expressive mode requires an `inference.TTS` model that declares a markup
dialect. Fish Audio, Inworld TTS 2, Cartesia Sonic 3, and xAI qualify; providers
without a dialect synthesize normally and the flag stays inert. To hear another
one, swap the `tts` model in `expressive_agent.ts`:

| Provider   | Model                   | Voice                                  |
| ---------- | ----------------------- | -------------------------------------- |
| Fish Audio | `fishaudio/s2.1-pro`    | `51b44863613e405a896f7f4294c6e6d0`     |
| Inworld    | `inworld/inworld-tts-2` | `Ashley`                               |
| Cartesia   | `cartesia/sonic-3`      | `9626c31c-bec5-4cca-baa8-f8ba9e84c8bc` |
| xAI        | `xai/tts-1`             | `eve`                                  |

Note that xAI steers delivery through prosody and sound tags but has no
expression tag, so it publishes no `lk.expression`. Its speech is expressive;
a frontend mood indicator just has nothing to read.
