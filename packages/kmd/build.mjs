import { build } from 'esbuild';

await build({
  entryPoints: ['bin/kmd.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/kmd.mjs',
  external: ['@modelcontextprotocol/sdk', 'pino', 'yaml', 'zod'],
  sourcemap: true
});
