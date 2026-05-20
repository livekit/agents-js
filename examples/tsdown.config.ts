import { defineConfig } from 'tsdown';
import defaults from '../tsdown.config.ts';

export default defineConfig({
  ...defaults,
  entry: 'src/**/*.ts',
});
