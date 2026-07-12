#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
// vendored single-file ESM build — plugin installs must not require npm install
import yaml from './vendor/js-yaml.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;

let event;
try {
  event = JSON.parse(input);
} catch {
  process.exit(0);
}

const tool = event.tool_name;
if (tool !== 'Write' && tool !== 'Edit') process.exit(0);

const filePath = event.tool_input?.file_path;
if (!filePath || !filePath.endsWith('.md')) process.exit(0);

const vaultRoot = process.argv[2];
if (!vaultRoot || !filePath.startsWith(vaultRoot)) process.exit(0);

const rel = filePath.slice(vaultRoot.length).replace(/^\//, '');
if (!/^(projects|research|notes)\//.test(rel)) process.exit(0);

let content = '';
if (tool === 'Write') {
  content = event.tool_input.content || '';
} else {
  if (!existsSync(filePath)) process.exit(0);
  let current;
  try {
    current = readFileSync(filePath, 'utf8');
  } catch {
    process.exit(0);
  }
  const old = event.tool_input.old_string ?? '';
  const neu = event.tool_input.new_string ?? '';
  if (event.tool_input.replace_all) {
    content = current.split(old).join(neu);
  } else {
    const idx = current.indexOf(old);
    if (idx === -1) process.exit(0);
    content = current.slice(0, idx) + neu + current.slice(idx + old.length);
  }
}

if (!content.startsWith('---')) process.exit(0);
const fmEnd = content.indexOf('\n---', 4);
if (fmEnd === -1) process.exit(0);
const fm = content.slice(4, fmEnd);

try {
  yaml.load(fm);
  process.exit(0);
} catch (e) {
  const msg = String(e.message || e).split('\n')[0];
  process.stderr.write(
    `Wiki frontmatter YAML invalid in ${filePath}:\n  ${msg}\n` +
      `Hint: wrap multi-sentence summary/description fields in double quotes.\n` +
      `See ~/.claude/rules/wiki-frontmatter.md for the full rule.\n`
  );
  process.exit(2);
}
