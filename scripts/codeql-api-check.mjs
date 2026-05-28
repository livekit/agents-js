// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
// @ts-check

/**
 * Public-API checks backed by CodeQL, replacing API Extractor. Runs several queries
 * (see `codeql/queries/`) and compares each against a committed snapshot, failing only
 * on drift — so the existing surface/debt is tracked and regressions are blocked, much
 * like API Extractor's `.api.md` report:
 *
 *   1. api-surface                 — names exported from each published package entry point
 *                                    (`codeql/api-surface.snapshot.txt`).
 *   2. api-signatures              — parameter list + return-type annotation of every public
 *                                    callable, so signature drift shows up as a diff
 *                                    (`codeql/api-signatures.snapshot.txt`).
 *   3. forgotten-exports           — types referenced by the public API but not themselves
 *                                    exported (`codeql/forgotten-exports.snapshot.txt`).
 *   4. implicit-public-return-types — exported functions / public methods with no explicit
 *                                    return type (`codeql/implicit-public-return-types.snapshot.txt`).
 *                                    These are the blind spot for #3: CodeQL's TS resolver
 *                                    can't see compiler-inferred types, so an un-annotated
 *                                    return can smuggle an internal type into the public API.
 *
 * Requires the CodeQL CLI (`codeql`) on PATH: https://github.com/github/codeql-cli-binaries
 *
 *   node scripts/codeql-api-check.mjs            # check (fails on drift from snapshots)
 *   node scripts/codeql-api-check.mjs --update   # refresh all snapshots
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const queriesDir = path.join(repoRoot, 'codeql', 'queries');
const dbDir = path.join(repoRoot, '.codeql', 'db');
const workDir = path.join(repoRoot, '.codeql');

/**
 * `@kind table` queries that emit a deterministic snapshot of public-API state. Each row of the
 * CSV is joined with tabs and sorted lexicographically before diffing.
 */
const tableQueries = [
  {
    label: 'api-surface',
    file: 'api-surface.ql',
    snapshot: path.join(repoRoot, 'codeql', 'api-surface.snapshot.txt'),
  },
];

const signaturesSnapshot = path.join(repoRoot, 'codeql', 'api-signatures.snapshot.txt');

/**
 * `@kind problem` queries, keyed by the `@name` they emit in the analyze CSV. Each is
 * snapshotted to its own baseline and diffed independently.
 */
const problemQueries = [
  {
    name: 'Forgotten export',
    label: 'forgotten-exports',
    file: 'forgotten-exports.ql',
    snapshot: path.join(repoRoot, 'codeql', 'forgotten-exports.snapshot.txt'),
  },
  {
    name: 'Missing return type on public API',
    label: 'implicit-public-return-types',
    file: 'implicit-public-return-types.ql',
    snapshot: path.join(repoRoot, 'codeql', 'implicit-public-return-types.snapshot.txt'),
  },
  {
    name: '`any`/`unknown` in public API',
    label: 'any-in-public-api',
    file: 'any-in-public-api.ql',
    snapshot: path.join(repoRoot, 'codeql', 'any-in-public-api.snapshot.txt'),
  },
  {
    name: 'Public API leaks an undeclared dependency',
    label: 'undeclared-dependency-leak',
    file: 'undeclared-dependency-leak.ql',
    snapshot: path.join(repoRoot, 'codeql', 'undeclared-dependency-leak.snapshot.txt'),
  },
];

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
  // Remove any prior database; `--overwrite` alone has been observed to reuse stale extraction.
  fs.rmSync(dbDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  const config = path.join(workDir, 'extraction-config.yml');
  fs.writeFileSync(
    config,
    [
      'paths:',
      '  - agents/src',
      '  - plugins/*/src',
      // package manifests, so the undeclared-dependency query can read declared deps
      '  - agents/package.json',
      '  - plugins/*/package.json',
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

/**
 * Parse full CodeQL CSV content into rows of fields, honoring quoted commas, escaped quotes,
 * and quoted fields that span multiple physical lines (CodeQL embeds newlines in descriptions).
 * @param {string} content
 * @returns {string[][]}
 */
const parseCsvRows = (content) => {
  const rows = [];
  let row = [];
  let cur = '';
  let inQuotes = false;
  const endRow = () => {
    row.push(cur);
    cur = '';
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (inQuotes) {
      if (c === '"' && content[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') inQuotes = false;
      else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && content[i + 1] === '\n') i++;
      endRow();
    } else cur += c;
  }
  if (cur !== '' || row.length > 0) endRow();
  return rows;
};

/** Maps a repo-relative file path to its owning package root, e.g. `plugins/cartesia`. */
const packageRoot = (file) => {
  const p = file.replace(/^\//, '');
  const m = p.match(/^(agents|plugins\/[^/]+)\//);
  return m ? m[1] : p;
};

/**
 * Runs the api-signatures query (which emits AST locations rather than text, since CodeQL's
 * `TypeExpr.toString()` truncates long types) and reconstructs full signature strings by
 * slicing each annotation out of the source file. Returns sorted `package<TAB>signature` lines.
 */
const computeApiSignatures = () => {
  const bqrs = path.join(workDir, 'api-signatures.bqrs');
  const csv = path.join(workDir, 'api-signatures.csv');
  codeql([
    'query',
    'run',
    `--database=${dbDir}`,
    `--output=${bqrs}`,
    '--threads=0',
    path.join(queriesDir, 'api-signatures.ql'),
  ]);
  codeql(['bqrs', 'decode', '--format=csv', '--no-titles', `--output=${csv}`, bqrs]);
  const rows = parseCsvRows(fs.readFileSync(csv, 'utf8'));
  /** @type {Map<string, string[]>} */
  const fileCache = new Map();
  const readFileLines = (relPath) => {
    let lines = fileCache.get(relPath);
    if (!lines) {
      const abs = path.join(repoRoot, relPath.replace(/^\//, ''));
      lines = fs.readFileSync(abs, 'utf8').split('\n');
      fileCache.set(relPath, lines);
    }
    return lines;
  };
  // CodeQL locations are 1-based with end column inclusive — convert to JS slice indices.
  const sliceRange = (file, sLine, sCol, eLine, eCol) => {
    const lines = readFileLines(file);
    if (sLine === eLine) return lines[sLine - 1].slice(sCol - 1, eCol);
    const parts = [lines[sLine - 1].slice(sCol - 1)];
    for (let i = sLine; i < eLine - 1; i++) parts.push(lines[i]);
    parts.push(lines[eLine - 1].slice(0, eCol));
    return parts.join('\n');
  };
  /** @type {Map<string, { package: string, qname: string, slots: Array<{slot:string,text:string}> }>} */
  const groups = new Map();
  const sliceOrEmpty = (file, sLine, sCol, eLine, eCol) =>
    file === ''
      ? ''
      : sliceRange(file, +sLine, +sCol, +eLine, +eCol)
          // strip block comments (e.g. JSDoc inside an inline type literal) and line comments
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .replace(/\/\/[^\n]*/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
  // Group by (package, qname, funcKey) so overloaded methods (same qname, distinct source
  // location) stay separate signatures instead of collapsing into one merged row.
  for (const cols of rows) {
    const [
      pkg, qname, funcKey, slot, flags,
      bFile, bSLine, bSCol, bELine, bECol,
      tFile, tSLine, tSCol, tELine, tECol,
    ] = cols;
    const key = pkg + '|' + qname + '|' + funcKey;
    let group = groups.get(key);
    if (!group) {
      group = { package: pkg, qname, slots: [] };
      groups.set(key, group);
    }
    let text;
    if (slot === 'return') {
      text = tFile === '' ? '<inferred>' : sliceOrEmpty(tFile, tSLine, tSCol, tELine, tECol);
    } else {
      const binding = sliceOrEmpty(bFile, bSLine, bSCol, bELine, bECol);
      const isRest = flags.includes('rest');
      const isOpt = flags.includes('opt');
      const restPrefix = isRest && !binding.startsWith('...') ? '...' : '';
      const optMark = isOpt ? '?' : '';
      const typeSuffix =
        tFile === ''
          ? ': <unannotated>'
          : ': ' + sliceOrEmpty(tFile, tSLine, tSCol, tELine, tECol);
      text = restPrefix + binding + optMark + typeSuffix;
    }
    group.slots.push({ slot, text });
  }
  const out = [];
  for (const g of groups.values()) {
    g.slots.sort((a, b) => a.slot.localeCompare(b.slot));
    const params = [];
    let ret = '<inferred>';
    for (const s of g.slots) {
      if (s.slot === 'return') ret = s.text;
      else params.push(s.text);
    }
    out.push(`${g.package}\t${g.qname}(${params.join(', ')}): ${ret}`);
  }
  return out.sort();
};

/** Runs a `@kind table` query and returns its CSV rows joined with tabs and sorted. */
const computeTable = (file, label) => {
  const bqrs = path.join(workDir, `${label}.bqrs`);
  const csv = path.join(workDir, `${label}.csv`);
  codeql([
    'query',
    'run',
    `--database=${dbDir}`,
    `--output=${bqrs}`,
    '--threads=0',
    path.join(queriesDir, file),
  ]);
  codeql(['bqrs', 'decode', '--format=csv', '--no-titles', `--output=${csv}`, bqrs]);
  return parseCsvRows(fs.readFileSync(csv, 'utf8'))
    .map((cols) => cols.join('\t'))
    .sort();
};

/**
 * Runs every `@kind problem` query in one analyze pass and groups results by `@name`.
 * Each group yields location-independent snapshot lines (`package<TAB>message`,
 * sorted/unique) plus a printable `file:line — message` list.
 * @returns {Map<string, { snapshot: string[], printable: string[] }>}
 */
const runProblemQueries = () => {
  const out = path.join(workDir, 'problems.csv');
  codeql([
    'database',
    'analyze',
    dbDir,
    ...problemQueries.map((q) => path.join(queriesDir, q.file)),
    '--format=csv',
    `--output=${out}`,
    '--rerun',
    '--threads=0',
    '--quiet',
  ]);
  /** @type {Map<string, { snapshot: Set<string>, printable: string[] }>} */
  const byName = new Map();
  for (const cols of parseCsvRows(fs.readFileSync(out, 'utf8'))) {
    // columns: name, description, severity, message, path, startLine, ...
    const [name, , , message, file, line] = cols;
    if (!byName.has(name)) byName.set(name, { snapshot: new Set(), printable: [] });
    const g = byName.get(name);
    g.snapshot.add(`${packageRoot(file)}\t${message}`);
    g.printable.push(`${file.replace(/^\//, '')}:${line} — ${message}`);
  }
  return new Map(
    [...byName].map(([name, g]) => [
      name,
      { snapshot: [...g.snapshot].sort(), printable: g.printable.sort() },
    ]),
  );
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

  const problems = runProblemQueries();

  let ok = true;
  for (const q of tableQueries) {
    const lines = computeTable(q.file, q.label);
    ok = diffSnapshot(q.label, q.snapshot, lines) && ok;
  }
  ok = diffSnapshot('api-signatures', signaturesSnapshot, computeApiSignatures()) && ok;

  for (const q of problemQueries) {
    const result = problems.get(q.name) ?? { snapshot: [], printable: [] };
    const matched = diffSnapshot(q.label, q.snapshot, result.snapshot);
    if (!update && !matched) {
      console.log(`\n${q.label} locations:`);
      for (const l of result.printable) console.log(`    ${l}`);
    }
    ok = ok && matched;
  }

  if (update) return;
  if (!ok) fail('CodeQL API checks failed (snapshot drift).');
  console.log('\n✓ CodeQL API checks passed.');
};

main();
