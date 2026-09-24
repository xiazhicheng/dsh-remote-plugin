import { defineConfig } from 'tsdown';

// Builds the Host plugin: src/index.ts -> lib/index.js (+ lib/types/index.d.ts).
// The repo also commits lib/ so the bundle installs and loads without a build
// step; run `pnpm build` to regenerate it after editing the source.
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node20',
  clean: true,
  dts: true,
  outDir: 'lib',
  unbundle: true,
});
