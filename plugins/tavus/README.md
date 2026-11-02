# Tavus plugin for LiveKit Agents

Support for the [Tavus](https://tavus.io/) virtual avatar.

See the [Tavus integration docs](https://docs.livekit.io/agents/models/avatar/plugins/tavus/) for more information.

## Installation

```bash
npm install @livekit/agents-plugin-tavus
```

## Pre-requisites

You'll need an API key from Tavus. It can be set as an environment variable: `TAVUS_API_KEY`

## Avatar emotion

Once the avatar has joined the room, set its facial emotion with `setEmotion`. The avatar keeps it until the next call.

`start()` returns before the avatar joins the room, and an emotion sent before then is dropped, so wait for the avatar with `waitForJoin()` first.

```ts
const avatar = new tavus.AvatarSession({ faceId: '...' });
await avatar.start(session, ctx.room);
await avatar.waitForJoin();

await avatar.setEmotion('happiness');
```

To let the LLM choose the emotion, wrap it in a tool:

```ts
const setEmotion = llm.tool({
  description: 'Set the facial emotion of your avatar.',
  parameters: z.object({ emotion: z.enum(tavus.EMOTIONS) }),
  execute: async ({ emotion }) => avatar.setEmotion(emotion),
});
```
