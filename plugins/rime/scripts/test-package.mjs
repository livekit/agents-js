// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
// Run after pnpm build. Network access is required for isolated npm installs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url));
const root = resolve(scripts, '../../..');
const temporary = mkdtempSync(join(tmpdir(), 'rime-package-'));
function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function pack(directory) {
  const output = run('pnpm', ['pack', '--pack-destination', temporary, '--json'], directory);
  return JSON.parse(output).filename;
}
try {
  const core = pack(join(root, 'agents'));
  const plugin = pack(join(root, 'plugins/rime'));
  const cwd = join(temporary, 'consumer');
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--legacy-peer-deps',
      core,
      plugin,
      '@livekit/rtc-node@1.1.0',
      'typescript@5.9.3',
      '@types/node@22',
      '@types/ws@8',
      '@types/json-schema',
      'zod@4',
    ],
    cwd,
  );
  copyFileSync(join(scripts, 'package-runtime.mjs'), join(cwd, 'runtime.mjs'));
  const cjs = readFileSync(
    join(cwd, 'node_modules/@livekit/agents-plugin-rime/dist/stt_sdk.cjs'),
    'utf8',
  );
  assert.match(cjs, /import\(specifier\)/);
  for (const extension of ['mts', 'cts']) {
    writeFileSync(
      join(cwd, `types.${extension}`),
      `import { TTS, STT, type STTOptions } from '@livekit/agents-plugin-rime';\nconst options: STTOptions = { mode: 'verbatim' };\nvoid TTS; void STT; void options;\n`,
    );
  }
  // Full declaration checking, including plugin imports, with no SDK installed.
  run(
    'node',
    [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--strict',
      '--module',
      'NodeNext',
      '--target',
      'ES2022',
      '--types',
      'node',
      'types.mts',
      'types.cts',
    ],
    cwd,
  );
  for (const format of ['esm', 'cjs'])
    process.stdout.write(
      run('node', ['--unhandled-rejections=strict', 'runtime.mjs', format, 'no-sdk'], cwd),
    );
  for (const version of ['0.1.0-alpha.18', '0.1.0-alpha.24']) {
    run(
      'npm',
      ['install', '--no-audit', '--no-fund', '--legacy-peer-deps', `@rimelabs/sdk@${version}`],
      cwd,
    );
    for (const format of ['esm', 'cjs'])
      process.stdout.write(
        `${version} ${run('node', ['--unhandled-rejections=strict', 'runtime.mjs', format, 'sdk'], cwd)}`,
      );
  }
  console.log(`Packed validation passed in ${cwd}`);
} catch (error) {
  process.stderr.write(error.stdout?.toString() ?? '');
  process.stderr.write(error.stderr?.toString() ?? '');
  throw error;
}
