import type { Options } from 'tsup';

const defaultOptions: Options = {
  entry: ['src/**/*.ts'],
  format: ['cjs', 'esm'],
  splitting: false,
  sourcemap: true,
  // for the type maps to work, we use tsc's declaration-only command on the success callback
  dts: false,
  clean: true,
  target: 'node16',
  bundle: false,
  shims: true,
  esbuildOptions: (options, context) => {
    if (context.format === 'esm') {
      options.packages = 'external';
    }
  },
  plugins: [
    {
      // https://github.com/egoist/tsup/issues/953#issuecomment-2294998890
      // ensuring that all local requires/imports in `.cjs` files import from `.cjs` files.
      // require('./path') → require('./path.cjs') in `.cjs` files
      // require('../path') → require('../path.cjs') in `.cjs` files
      // from './path' → from './path.cjs' in `.cjs` files
      // from '../path' → from '../path.cjs' in `.cjs` files
      // (0, import_node_child_process.fork)(new URL("./path.js" → (0, import_node_child_process.fork)(new URL("./path.cjs" in `.cjs` files
      name: 'fix-cjs-imports',
      renderChunk(code) {
        if (this.format === 'cjs') {
          const regexCjs = /require\((?<quote>['"])(?<import>\.[^'"]+)\.js['"]\)/g;
          const regexDynamic = /import\((?<quote>['"])(?<import>\.[^'"]+)\.js['"]\)/g;
          const regexEsm = /from(?<space>[\s]*)(?<quote>['"])(?<import>\.[^'"]+)\.js['"]/g;
          return {
            code: code
              .replace(regexCjs, 'require($<quote>$<import>.cjs$<quote>)')
              .replace(regexDynamic, 'import($<quote>$<import>.cjs$<quote>)')
              .replace(regexEsm, 'from$<space>$<quote>$<import>.cjs$<quote>'),
          };
        }
      },
    },
  ],
};
export default defaultOptions;
