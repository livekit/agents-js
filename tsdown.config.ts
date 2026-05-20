import { readFileSync } from 'fs';
import { join } from 'path';
import type { Options } from 'tsdown';

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));

const defaultOptions: Options = {
  entry: ['src/**/index.ts'],
  format: ['cjs', 'esm'],
  publint: true,
  splitting: false,
  sourcemap: true,
  dts: true,
  clean: true,
  target: 'node16',
  unbundle: true,
  shims: true,
  fixedExtension: false,
  define: {
    __PACKAGE_NAME__: JSON.stringify(pkg.name),
    __PACKAGE_VERSION__: JSON.stringify(pkg.version),
  },
};
export default defaultOptions;
