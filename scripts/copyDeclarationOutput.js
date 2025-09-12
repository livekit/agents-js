// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
// @ts-check
import fs from 'fs';
import path from 'path';

/**
 * @param {string} dir
 * @param {(filePath: string) => void} callback
 */
const walkDir = (dir, callback) => {
  fs.readdirSync(dir).forEach((f) => {
    const dirPath = path.join(dir, f);
    const isDirectory = fs.statSync(dirPath).isDirectory();
    isDirectory ? walkDir(dirPath, callback) : callback(path.join(dir, f));
  });
};

/**
 * @param {string} dir
 * @param {(filePath: string) => void} callback
 */
walkDir('dist', (filePath) => {
  if (filePath.endsWith('.d.ts')) {
    const newPath = filePath.replace(/\.d\.ts$/, '.d.cts');
    fs.copyFileSync(filePath, newPath);
  }
});
console.log('copied declaration .d.ts files to .d.cts files');
