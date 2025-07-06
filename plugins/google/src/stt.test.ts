import { initializeLogger } from '@livekit/agents';
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import { describe } from 'vitest';
import { STT } from './stt.js';

describe('Google', async () => {
  initializeLogger({ pretty: false });
  await stt(new STT(), await VAD.load(), { nonStreaming: false });
});
