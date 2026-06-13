import { defineConfig } from 'tsup';
import { copyFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import defaults from '../tsup.config';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  ...defaults,
  // todo CJS build disabled for now
  format: ['esm'],
  plugins: [
    ...(defaults.plugins || []),
    {
      name: 'copy-wasm',
      async buildEnd() {
        // Copy WASM file to dist
        const wasmSrc = join(__dirname, 'src/tokenize/blingfire/blingfire.wasm');
        const wasmDest = join(__dirname, 'dist/tokenize/blingfire/blingfire.wasm');
        await mkdir(join(__dirname, 'dist/tokenize/blingfire'), { recursive: true });
        await copyFile(wasmSrc, wasmDest);
        console.log('Copied blingfire.wasm to dist');
      },
    },
  ],
});

