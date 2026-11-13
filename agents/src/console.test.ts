// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runConsole } from './console.js';
import { EOT_INFERENCE_METHOD } from './inference/eot/runner.js';
import { InferenceRunner } from './inference_runner.js';
import { InferenceProcExecutor } from './ipc/inference_proc_executor.js';

vi.mock('./inference/_warmup.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  _getLocalInferenceModule: () => ({}),
}));

describe('runConsole', () => {
  let dir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('registers the local EOT runner before it creates the inference process', async () => {
    dir = await mkdtemp(join(tmpdir(), 'console-test-'));
    const agentPath = join(dir, 'agent.ts');
    const generator = fileURLToPath(new URL('./generator.ts', import.meta.url));
    await writeFile(
      agentPath,
      `import { defineAgent } from ${JSON.stringify(generator)};\n` +
        `export default defineAgent({ entry: async () => { throw new Error('entry ran'); } });\n`,
    );
    const runnersAtCreate: string[][] = [];
    vi.spyOn(InferenceProcExecutor, 'createIfNeeded').mockImplementation(() => {
      runnersAtCreate.push(Object.keys(InferenceRunner.registeredRunners));
      return undefined;
    });

    await expect(
      runConsole({ agentPath, connectAddr: '127.0.0.1:1', record: false }),
    ).rejects.toThrow('entry ran');

    expect(runnersAtCreate).toEqual([[EOT_INFERENCE_METHOD]]);
  });
});
