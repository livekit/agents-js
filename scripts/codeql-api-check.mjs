// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
// @ts-check

/**
 * Public-API checks backed by CodeQL, replacing API Extractor. Runs two queries
 * (see `codeql/queries/`) and compares each against a committed snapshot, failing only
 * on drift — so the existing surface/debt is tracked and regressions are blocked, much
 * like API Extractor's `.api.md` report:
 *
 *   1. api-surface       — names exported from each published package entry point
 *                          (`codeql/api-surface.snapshot.txt`).
 *   2. forgotten-exports — types referenced by the public API but not themselves exported
 *                          (`codeql/forgotten-exports.snapshot.txt`).
 *
 * Requires the CodeQL CLI (`codeql`) on PATH: https://github.com/github/codeql-cli-binaries
 *
 *   node scripts/codeql-api-check.mjs            # check (fails on drift from snapshots)
 *   node scripts/codeql-api-check.mjs --update   # refresh both snapshots
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const queriesDir = path.join(repoRoot, 'codeql', 'queries');
const surfaceSnapshot = path.join(repoRoot, 'codeql', 'api-surface.snapshot.txt');
const forgottenSnapshot = path.join(repoRoot, 'codeql', 'forgotten-exports.snapshot.txt');
const dbDir = path.join(repoRoot, '.codeql', 'db');
const workDir = path.join(repoRoot, '.codeql');

const update = process.argv.includes('--update');

/** @param {string} msg */
const fail = (msg) => {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
};

const ensureCodeql = () => {
  const r = spawnSync('codeql', ['version', '--format=terse'], { encoding: 'utf8' });
  if (r.status !== 0) {
    fail(
      'CodeQL CLI not found on PATH.\n' +
        '  Install it from https://github.com/github/codeql-cli-binaries (or `brew install codeql`),\n' +
        '  then run `codeql pack install` inside ./codeql once to fetch query dependencies.',
    );
  }
  return r.stdout.trim();
};

/** @param {string[]} args */
const codeql = (args) =>
  execFileSync('codeql', args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] });

const createDatabase = () => {
  fs.mkdirSync(workDir, { recursive: true });
  const config = path.join(workDir, 'extraction-config.yml');
  fs.writeFileSync(
    config,
    [
      'paths:',
      '  - agents/src',
      '  - plugins/*/src',
      'paths-ignore:',
      '  - "**/*.test.ts"',
      '',
    ].join('\n'),
  );
  console.log('• Building CodeQL database (source only)…');
  codeql([
    'database',
    'create',
    dbDir,
    '--language=javascript',
    '--source-root=.',
    `--codescanning-config=${config}`,
    '--overwrite',
    '--quiet',
  ]);
};

/** Parse one CodeQL CSV row into fields, handling quoted commas. @param {string} line */
const parseCsv = (line) => {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') inQuotes = false;
      else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
};

/** Maps a repo-relative file path to its owning package root, e.g. `plugins/cartesia`. */
const packageRoot = (file) => {
  const p = file.replace(/^\//, '');
  const m = p.match(/^(agents|plugins\/[^/]+)\//);
  return m ? m[1] : p;
};

/** Runs the api-surface query and returns sorted "package<TAB>name" lines. */
const computeApiSurface = () => {
  const bqrs = path.join(workDir, 'api-surface.bqrs');
  const csv = path.join(workDir, 'api-surface.csv');
  codeql([
    'query',
    'run',
    `--database=${dbDir}`,
    `--output=${bqrs}`,
    '--threads=0',
    path.join(queriesDir, 'api-surface.ql'),
  ]);
  codeql(['bqrs', 'decode', '--format=csv', '--no-titles', `--output=${csv}`, bqrs]);
  return fs
    .readFileSync(csv, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => parseCsv(l).join('\t'))
    .sort();
};

/**
 * Runs the forgotten-exports query. Returns the location-independent snapshot lines
 * (`package<TAB>message`, sorted/unique) plus a printable `file:line — message` list.
 * @returns {{ snapshot: string[], printable: string[] }}
 */
const computeForgottenExports = () => {
  const out = path.join(workDir, 'forgotten-exports.csv');
  codeql([
    'database',
    'analyze',
    dbDir,
    path.join(queriesDir, 'forgotten-exports.ql'),
    '--format=csv',
    `--output=${out}`,
    '--rerun',
    '--threads=0',
    '--quiet',
  ]);
  const rows = fs
    .readFileSync(out, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map(parseCsv);
  const snapshot = new Set();
  const printable = [];
  for (const cols of rows) {
    // columns: name, description, severity, message, path, startLine, ...
    const [, , , message, file, line] = cols;
    snapshot.add(`${packageRoot(file)}\t${message}`);
    printable.push(`${file.replace(/^\//, '')}:${line} — ${message}`);
  }
  return { snapshot: [...snapshot].sort(), printable: printable.sort() };
};

/**
 * Compares computed lines against a committed snapshot file.
 * @returns {boolean} true if they match
 */
const diffSnapshot = (label, file, lines) => {
  const current = lines.join('\n') + (lines.length ? '\n' : '');
  if (update) {
    fs.writeFileSync(file, current);
    console.log(`• ${label}: wrote ${path.relative(repoRoot, file)} (${lines.length} entries)`);
    return true;
  }
  const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (previous === current) {
    console.log(`• ${label}: matches snapshot ✓ (${lines.length} entries)`);
    return true;
  }
  const prev = new Set(previous.split('\n').filter(Boolean));
  const next = new Set(lines);
  const added = lines.filter((l) => !prev.has(l));
  const removed = [...prev].filter((l) => !next.has(l));
  console.log(`• ${label}: drift from committed snapshot:`);
  for (const l of added) console.log(`    + ${l.replace(/\t/g, ' → ')}`);
  for (const l of removed) console.log(`    - ${l.replace(/\t/g, ' → ')}`);
  console.log('  Run `pnpm api:update` if this change is intended.');
  return false;
};

const main = () => {
  console.log(`Using ${ensureCodeql()}`);
  createDatabase();

  const surface = computeApiSurface();
  const forgotten = computeForgottenExports();

  const surfaceOk = diffSnapshot('api-surface', surfaceSnapshot, surface);
  const forgottenOk = diffSnapshot('forgotten-exports', forgottenSnapshot, forgotten.snapshot);

  if (!update && !forgottenOk) {
    console.log('\nforgotten-export locations:');
    for (const l of forgotten.printable) console.log(`    ${l}`);
  }

  if (update) return;
  if (!surfaceOk || !forgottenOk) fail('CodeQL API checks failed (snapshot drift).');
  console.log('\n✓ CodeQL API checks passed.');
};

main();
