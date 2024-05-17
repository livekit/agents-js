import { defineWorkspace } from 'vitest/config';

// defineWorkspace provides a nice type hinting DX
export default defineWorkspace([
  'packages/*',
  {
    test: {
      include: ['**/*.test.{ts,js}'],
      // it is recommended to define a name when using inline configs
      name: 'nodejs',
      environment: 'node',
    },
  },
]);
