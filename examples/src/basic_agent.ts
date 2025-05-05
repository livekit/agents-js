import {
  AutoSubscribe,
  type JobContext,
  WorkerOptions,
  cli,
  defineAgent,
  voice,
} from '@livekit/agents';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    console.log(ctx);
    console.log('Hello, world!');
    const agent = new voice.Agent('test');
    await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
    const participant = await ctx.waitForParticipant();
    console.log('++++ Participant joined:', participant);

    const session = new voice.AgentSession({});
    session.start(agent, ctx.room, participant);
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
