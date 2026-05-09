// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareBootstrap, validateAgentEntryFile } from './bin.js';

describe('lk-agent bootstrapper', () => {
  it('resolves the entry path and rewrites argv for cli.runApp', () => {
    const prepared = prepareBootstrap(
      ['/usr/local/bin/node', '/repo/node_modules/.bin/lk-agent', 'dist/main.js', 'dev'],
      '/repo',
    );

    expect(prepared.agentPath).toBe(resolve('/repo', 'dist/main.js'));
    expect(prepared.argv).toEqual(['/usr/local/bin/node', resolve('/repo', 'dist/main.js'), 'dev']);
  });

  it('preserves command arguments after the LiveKit command', () => {
    const prepared = prepareBootstrap(
      [
        '/usr/local/bin/node',
        '/repo/node_modules/.bin/lk-agent',
        './main.js',
        'connect',
        '--room',
        'demo',
      ],
      '/repo',
    );

    expect(prepared.argv).toEqual([
      '/usr/local/bin/node',
      resolve('/repo', './main.js'),
      'connect',
      '--room',
      'demo',
    ]);
  });

  it('rejects invocations without an entry file', () => {
    expect(() =>
      prepareBootstrap(['/usr/local/bin/node', '/repo/node_modules/.bin/lk-agent'], '/repo'),
    ).toThrow('Usage: lk-agent <entry> <command> [...args]');
  });

  it('rejects invocations without a LiveKit command', () => {
    expect(() =>
      prepareBootstrap(
        ['/usr/local/bin/node', '/repo/node_modules/.bin/lk-agent', 'dist/main.js'],
        '/repo',
      ),
    ).toThrow('Usage: lk-agent <entry> <command> [...args]');
  });

  it('rejects a missing agent entry file before import', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lk-agent-'));
    const missing = join(dir, 'missing.js');

    await expect(validateAgentEntryFile(missing)).rejects.toThrow(
      `Agent entry file does not exist: ${missing}`,
    );
  });

  it('rejects an agent entry path that is not a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lk-agent-'));
    const entryDir = join(dir, 'entry');
    await mkdir(entryDir);

    await expect(validateAgentEntryFile(entryDir)).rejects.toThrow(
      `Agent entry path is not a file: ${entryDir}`,
    );
  });

  it('accepts an existing agent entry file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lk-agent-'));
    const entry = join(dir, 'main.js');
    await writeFile(entry, 'export default {};');

    await expect(validateAgentEntryFile(entry)).resolves.toBeUndefined();
  });
});
