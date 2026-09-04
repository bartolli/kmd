import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import type { RenderManifest } from './render.js';

const replacementPair = z.tuple([z.string(), z.string()]);

const dialectSchema = z.union([
  z.literal('claude').transform(() => ({ kind: 'claude' }) as const),
  z.object({ kind: z.literal('claude') }),
  z.object({
    kind: z.literal('codex'),
    slashAliases: z.array(z.string()).default([]),
    replacements: z.array(replacementPair).default([])
  }),
  z.object({
    kind: z.literal('coco'),
    slashAliases: z.array(z.string()).default([]),
    replacements: z.array(replacementPair).default([])
  })
]);

const exactEntrySchema = z.union([
  z.string().transform((path) => ({ path })),
  z.object({ path: z.string(), flavors: z.array(z.string()).optional() })
]);

const manifestSchema = z.object({
  sourceRoot: z.string(),
  flavors: z.record(z.string(), z.object({ dest: z.string(), dialect: dialectSchema })),
  shared: z.object({
    exact: z.array(exactEntrySchema).default([]),
    rendered: z.array(z.string()).default([])
  }),
  lintAllow: z.array(z.union([z.string(), z.object({ section: z.string() })])).optional(),
  versionSource: z.string().optional()
});

export function loadManifest(path: string): RenderManifest {
  const raw: unknown = parse(readFileSync(path, 'utf8'));
  return manifestSchema.parse(raw) as RenderManifest;
}
