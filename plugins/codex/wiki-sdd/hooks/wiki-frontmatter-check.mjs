#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
// Vendored ESM build keeps plugin installs independent of npm install.
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
if (!['Write', 'Edit', 'apply_patch'].includes(tool)) process.exit(0);

const vaultRoot = resolve(
  process.env.WIKI_VAULT || join(homedir(), 'llm-wiki', 'vault')
);
const cwd = event.cwd || process.cwd();

function wikiPath(rawPath) {
  if (!rawPath) return null;
  const filePath = resolve(cwd, rawPath);
  const rel = relative(vaultRoot, filePath);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  if (!/^(projects|research|notes)[/\\]/.test(rel)) return null;
  return filePath.endsWith('.md') ? filePath : null;
}

function applyUpdate(original, lines) {
  const hunks = [];
  let current = [];
  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (current.length) hunks.push(current);
      current = [];
    } else if (/^[ +\-]/.test(line)) {
      current.push(line);
    }
  }
  if (current.length) hunks.push(current);

  let content = original;
  let cursor = 0;
  for (const hunk of hunks) {
    const before = hunk
      .filter((line) => line[0] === ' ' || line[0] === '-')
      .map((line) => line.slice(1))
      .join('\n');
    const after = hunk
      .filter((line) => line[0] === ' ' || line[0] === '+')
      .map((line) => line.slice(1))
      .join('\n');
    if (!before) {
      if (content.length !== 0) return null;
      content = after;
      cursor = after.length;
      continue;
    }
    const index = content.indexOf(before, cursor);
    if (index === -1) return null;
    content = content.slice(0, index) + after + content.slice(index + before.length);
    cursor = index + after.length;
  }
  return content;
}

function patchedFiles(patch) {
  const sections = patch.split(/(?=^\*\*\* (?:Add|Update|Delete) File: )/m);
  const files = [];
  for (const section of sections) {
    const match = section.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/m);
    if (!match || match[1] === 'Delete') continue;
    const filePath = wikiPath(match[2].trim());
    if (!filePath) continue;
    const lines = section.split('\n').slice(1);
    if (match[1] === 'Add') {
      const content = lines
        .filter((line) => line.startsWith('+'))
        .map((line) => line.slice(1))
        .join('\n');
      files.push([filePath, content]);
      continue;
    }
    if (!existsSync(filePath)) continue;
    try {
      const content = applyUpdate(readFileSync(filePath, 'utf8'), lines);
      if (content !== null) files.push([filePath, content]);
    } catch {
      continue;
    }
  }
  return files;
}

let files = [];
if (tool === 'apply_patch') {
  const toolInput = event.tool_input;
  const patch =
    typeof toolInput === 'string'
      ? toolInput
      : toolInput?.patch || toolInput?.input || toolInput?.command;
  if (typeof patch === 'string') files = patchedFiles(patch);
} else {
  const filePath = wikiPath(event.tool_input?.file_path);
  if (!filePath) process.exit(0);
  if (tool === 'Write') {
    files = [[filePath, event.tool_input.content || '']];
  } else if (existsSync(filePath)) {
    try {
      const current = readFileSync(filePath, 'utf8');
      const old = event.tool_input.old_string ?? '';
      const neu = event.tool_input.new_string ?? '';
      const content = event.tool_input.replace_all
        ? current.split(old).join(neu)
        : current.replace(old, neu);
      files = [[filePath, content]];
    } catch {
      process.exit(0);
    }
  }
}

for (const [filePath, content] of files) {
  if (!content.startsWith('---')) continue;
  const fmEnd = content.indexOf('\n---', 4);
  if (fmEnd === -1) continue;
  try {
    yaml.load(content.slice(4, fmEnd));
  } catch (error) {
    const msg = String(error.message || error).split('\n')[0];
    process.stderr.write(
      `Wiki frontmatter YAML invalid in ${filePath}:\n  ${msg}\n` +
        `Hint: wrap prose-bearing frontmatter scalars in double quotes.\n` +
        `See wiki://authoring for the full rule.\n`
    );
    process.exit(2);
  }
}

process.exit(0);
