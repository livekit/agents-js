import { initializeLogger } from '@livekit/agents';
import { downloadFileToCacheDir } from '@livekit/agents-plugin-livekit';

initializeLogger({ pretty: true, level: 'debug' });

const result = await downloadFileToCacheDir({
  repo: 'livekit/turn-detector',
  path: 'onnx/model_q8.onnx',
  revision: 'v1.2.2-en',
  localFileOnly: true,
});

console.log(result);
