// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { PrismPeer } from './test_helpers.js';

it.each(['esm', 'cjs'])(
  'connects from the built %s package and retains TTS exports',
  async (format) => {
    const peer = await new PrismPeer().start();
    try {
      const load =
        format === 'esm'
          ? "const { realtime, TTS } = await import('./dist/index.js'); const core = await import('@livekit/agents');"
          : "const { realtime, TTS } = require('./dist/index.cjs'); const core = require('@livekit/agents');";
      const script = `${load}
      core.initializeLogger({ pretty: false, level: 'silent' });
      if (typeof TTS !== 'function') throw new Error('Missing TTS');
      const model = new realtime.RealtimeModel({ apiKey: 'test', endpoint: process.argv[1] });
      const session = model.session();
      await session.updateInstructions('Packaging check');
      if (model.sessionInfo.voice !== 'test') throw new Error('Connection failed');
      await model.close();
      console.log('connected');`;
      const wrapped =
        format === 'cjs'
          ? `(async () => { ${script} })().catch(error => { console.error(error); process.exitCode = 1; });`
          : script;
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [...(format === 'esm' ? ['--input-type=module'] : []), '-e', wrapped, peer.endpoint],
        { cwd: fileURLToPath(new URL('../..', import.meta.url)), timeout: 5000 },
      );
      expect(stdout).toContain('connected');
    } finally {
      await peer.close();
    }
  },
);
