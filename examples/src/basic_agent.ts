import { type JobContext, WorkerOptions, cli, defineAgent, voice } from '@livekit/agents';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    console.log(ctx);
    console.log('Hello, world!');
    const agent = new voice.Agent('test');
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
