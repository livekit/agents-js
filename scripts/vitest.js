// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const CATEGORY_FLAGS = new Set(['unit', 'plugin', 'realtime', 'stt', 'tts', 'evals', 'docs']);
const TARGETED_FLAGS = new Set(['plugin', 'realtime', 'stt', 'tts']);
const TARGET_RE = /^[a-z0-9-]+$/;

function parseArgs(args) {
  const vitestArgs = [];
  const selected = {};
  let listCategories = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--list-categories') {
      listCategories = true;
      continue;
    }
    if (arg === '--allow-uncategorized') {
      continue;
    }
    if (!arg.startsWith('--')) {
      vitestArgs.push(arg);
      continue;
    }

    const flag = arg.slice(2);
    if (!CATEGORY_FLAGS.has(flag)) {
      vitestArgs.push(arg);
      continue;
    }

    let target = true;
    const next = args[i + 1];
    if (TARGETED_FLAGS.has(flag) && next && !next.startsWith('-') && TARGET_RE.test(next)) {
      target = next;
      i += 1;
    }
    selected[flag] = target;
  }

  return { vitestArgs, selected, listCategories };
}

function walkTestFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      files.push(...walkTestFiles(path));
    } else if (entry.endsWith('.test.ts')) {
      files.push(path);
    }
  }
  return files;
}

function categoriesFor(path) {
  const normalized = path.split(sep).join('/');
  const categories = [];
  if (normalized.startsWith('agents/')) categories.push('unit');
  const plugin = normalized.match(/^plugins\/([^/]+)\/src\//)?.[1];
  if (plugin) categories.push(`plugin:${plugin}`);
  if (normalized.includes('/stt') || normalized.startsWith('agents/src/stt/')) {
    categories.push(plugin ? `stt:${plugin}` : 'stt');
  }
  if (normalized.includes('/tts') || normalized.startsWith('agents/src/tts/')) {
    categories.push(plugin ? `tts:${plugin}` : 'tts');
  }
  if (normalized.includes('/realtime/')) {
    categories.push(plugin ? `realtime:${plugin}` : 'realtime');
  }
  return categories;
}

function printCategories() {
  const root = process.cwd();
  const grouped = new Map();
  for (const file of walkTestFiles(root)) {
    const rel = relative(root, file).split(sep).join('/');
    for (const category of categoriesFor(rel)) {
      if (!grouped.has(category)) grouped.set(category, []);
      grouped.get(category).push(rel);
    }
  }

  console.log('\nTest categories (select with --<category>):\n');
  for (const category of ['unit', 'plugin', 'stt', 'tts', 'realtime', 'evals', 'docs']) {
    const entries = [...grouped.entries()].filter(
      ([key]) => key === category || key.startsWith(`${category}:`),
    );
    const files = new Set(entries.flatMap(([, paths]) => paths));
    console.log(`  ${category.padEnd(8)} ${files.size} module${files.size === 1 ? '' : 's'}`);
    for (const file of [...files].sort()) console.log(`             - ${file}`);
  }
}

const { vitestArgs, selected, listCategories } = parseArgs(process.argv.slice(2));

if (listCategories) {
  printCategories();
  process.exit(0);
}

const env = { ...process.env };
if (Object.keys(selected).length > 0) {
  env.LIVEKIT_TEST_SELECTION = JSON.stringify(selected);
}

const result = spawnSync('pnpm', ['exec', 'vitest', 'run', ...vitestArgs], {
  env,
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
