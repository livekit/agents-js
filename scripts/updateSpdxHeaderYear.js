// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const TARGET_YEAR = '2026';
const OUTDATED_YEARS = new Set(['2024', '2025']);
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'coverage', '.turbo']);
const HEADER_SCAN_LIMIT = 1024;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * @param {string} dir
 * @param {(filePath: string) => void} callback
 */
const walkDir = (dir, callback) => {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) {
        walkDir(entryPath, callback);
      }
      return;
    }

    if (entry.isFile()) {
      callback(entryPath);
    }
  });
};

/**
 * @param {string} content
 * @returns {string | null}
 */
const updateHeaderYear = (content) => {
  const headerChunk = content.slice(0, HEADER_SCAN_LIMIT);

  const lineCommentMatch = headerChunk.match(
    /^(?<bom>\uFEFF?)(?<shebang>#![^\r\n]*(?:\r?\n))?(?<prefix>(?:\/\/|#)\s?SPDX-FileCopyrightText:\s*)(?<year>\d{4})(?<suffix>\s+LiveKit, Inc\.)/,
  );
  if (lineCommentMatch?.groups?.year && OUTDATED_YEARS.has(lineCommentMatch.groups.year)) {
    return content.replace(
      lineCommentMatch[0],
      `${lineCommentMatch.groups.bom}${lineCommentMatch.groups.shebang ?? ''}${lineCommentMatch.groups.prefix}${TARGET_YEAR}${lineCommentMatch.groups.suffix}`,
    );
  }

  const htmlCommentMatch = headerChunk.match(
    /^(?<bom>\uFEFF?)<!--\s*\r?\n(?<prefix>SPDX-FileCopyrightText:\s*)(?<year>\d{4})(?<suffix>\s+LiveKit, Inc\.)/,
  );
  if (htmlCommentMatch?.groups?.year && OUTDATED_YEARS.has(htmlCommentMatch.groups.year)) {
    return content.replace(
      htmlCommentMatch[0],
      `${htmlCommentMatch.groups.bom}<!--\n${htmlCommentMatch.groups.prefix}${TARGET_YEAR}${htmlCommentMatch.groups.suffix}`,
    );
  }

  return null;
};

const updatedFiles = [];

walkDir(repoRoot, (filePath) => {
  const content = fs.readFileSync(filePath, 'utf8');
  const updatedContent = updateHeaderYear(content);

  if (updatedContent !== null && updatedContent !== content) {
    fs.writeFileSync(filePath, updatedContent);
    updatedFiles.push(path.relative(repoRoot, filePath));
  }
});

updatedFiles.sort();

if (updatedFiles.length === 0) {
  console.log('No outdated SPDX header years found.');
} else {
  console.log(`Updated ${updatedFiles.length} file(s):`);
  updatedFiles.forEach((filePath) => {
    console.log(filePath);
  });
}
