import { STT } from '@livekit/agents-plugin-openai';
import { tts } from '@livekit/agents-plugins-test';
import { describe } from 'vitest';
import { TTS } from './tts.js';

describe('Rime TTS', async () => {
  await tts(new TTS(), new STT());
});
