import {
  AutoSubscribe,
  type JobContext,
  JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  voice,
} from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const agent = new voice.Agent('test');
    await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
    const participant = await ctx.waitForParticipant();
    console.log('participant joined: ', participant.identity);

    const vad = ctx.proc.userData.vad! as silero.VAD;

    const session = new voice.AgentSession(vad);
    session.start(agent, ctx.room);
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
