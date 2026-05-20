import { defineConfig } from 'tsdown';
import defaults from '../tsdown.config.ts';

export default defineConfig({
  ...defaults,
  entry: ['src/index.ts', 'src/cli.ts'],
});
