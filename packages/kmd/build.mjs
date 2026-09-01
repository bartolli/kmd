import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['bin/kmd.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/kmd.mjs',
  external: ['@modelcontextprotocol/sdk', 'pino', 'yaml', 'zod'],
  sourcemap: true,
  // The stamp is the version of the code that runs: the hook resolver reads it
  // from the bundle head and --version reports it, so a source-linked install
  // whose package.json moved without a rebuild cannot pass the version floor.
  banner: { js: `// kmd-version=${version}` },
  define: { __KMD_VERSION__: JSON.stringify(version) }
});
