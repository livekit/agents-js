import { defineConfig } from 'tsup';

export default defineConfig({
  define: { __PACKAGE_VERSION__: JSON.stringify(process.env.npm_package_version) },
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  // The SDK is ESM-only; bundle it for the CJS entry while keeping LiveKit's
  // registry external so both entries register on the caller's framework.
  noExternal: ['@openspline/node'],
  external: ['@livekit/agents', '@livekit/rtc-node', 'livekit-server-sdk', 'ws'],
});
