import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../src/manifest.js';
import { render } from '../src/render.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const manifestPath = join(repoRoot, 'plugins', 'render-manifest.yaml');
if (!existsSync(manifestPath)) {
  console.error(`no manifest at ${manifestPath}`);
  process.exit(1);
}

const mode = process.argv.includes('--check') ? 'check' : 'write';
const result = render(repoRoot, loadManifest(manifestPath), mode);

for (const p of result.problems) console.error(`✗ ${p}`);
for (const m of result.mismatches) console.error(`✗ ${m}`);
if (result.problems.length > 0 || result.mismatches.length > 0) {
  process.exit(1);
}
console.log(mode === 'write' ? `rendered ${result.written} files` : 'check: adapters match');
