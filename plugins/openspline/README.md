# OpenSpline virtual avatars

```ts
import * as openspline from '@livekit/agents-plugin-openspline';

const avatar = new openspline.AvatarSession({ avatarId: 'YOUR_AVATAR_ID' });
await avatar.start(session, ctx.room);
```

Set `OPENSPLINE_API_KEY` and the standard `LIVEKIT_*` environment variables. Start the avatar before the agent session. For a local GPU service, unset the Cloud key and use `{ portrait: 'portrait.jpg' }`.

Requires OpenSpline Node SDK 0.1.2. [Setup, options and recorded demos](https://docs.openspline.dev/connectors/livekit).
