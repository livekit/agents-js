# LemonSlice Avatar

A voice agent with a talking-head avatar you can swap mid-conversation. Pick a persona from the dropdown - Leila, Jess, a software engineer, a cat, a fox - and the agent's face, voice, and personality all change without dropping the call.

## What's in here

- 9 personas to choose from, each with its own face, voice, system prompt, and body-language hints.
- Live persona switching through the `set_avatar` RPC.
- Hero motions for Leila, Jess, and Mr Fox. The LLM can trigger wave, dance, or turn via tool calls, one motion at a time for about 6 seconds each. They wave automatically when the session starts.
- LiveKit Inference for STT and LLM, Cartesia for TTS, and LemonSlice for avatar video.

## Run

Set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and `LEMONSLICE_API_KEY`, then run:

```bash
pnpm build && node ./examples/dist/avatar/avatar.js dev
```

The agent reads the starting persona from job metadata. If no metadata is sent, it defaults to Leila.

## Files

- `avatar.ts` - entry point and `set_avatar` RPC
- `actions.ts` - pose controller for opening waves and LLM tool motions
- `personas.ts` - the 9 personas and shared prompt rules
- `hold_music.ts` - soft three-note hold tone during persona switches
