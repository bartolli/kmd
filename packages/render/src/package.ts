import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';

// Agent Plugins 1.0.0: a client never retrieves a schema while loading a
// plugin, and neither does the check — both schemas are vendored.
const SCHEMAS = fileURLToPath(new URL('../schemas/1.0.0/', import.meta.url));

export interface PluginManifest {
  $schema: string;
  name: string;
  version?: string;
  description?: string;
  author?: { name?: string; email?: string; url?: string };
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  extensions?: Record<string, Record<string, unknown>>;
}

export interface PackageResult {
  problems: string[];
  manifest: PluginManifest | null;
}

// ajv ships CommonJS: the default import is module.exports, the class rides .default.
const Ajv2020 = ajv2020.default;

function compile(file: string): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true });
  return ajv.compile(JSON.parse(readFileSync(join(SCHEMAS, file), 'utf8')));
}

const validatePlugin = compile('plugin.schema.json');
const validateMcp = compile('mcp.schema.json');

function checkFile(
  sourceRoot: string,
  rel: string,
  validate: ValidateFunction
): { value: unknown; problems: string[] } {
  const path = join(sourceRoot, rel);
  if (!existsSync(path)) {
    return { value: null, problems: [`${rel}: missing — the source is the package`] };
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { value: null, problems: [`${rel}: not valid JSON`] };
  }
  if (validate(value)) return { value, problems: [] };
  const problems = (validate.errors ?? []).map((e) => {
    const extra =
      typeof e.params.additionalProperty === 'string' ? ` (${e.params.additionalProperty})` : '';
    return `${rel}: ${e.instancePath || '/'} ${e.message ?? 'invalid'}${extra}`;
  });
  return { value: null, problems };
}

export function validatePackage(sourceRoot: string): PackageResult {
  const plugin = checkFile(sourceRoot, 'plugin.json', validatePlugin);
  const mcp = checkFile(sourceRoot, 'mcp.json', validateMcp);
  return {
    problems: [...plugin.problems, ...mcp.problems],
    manifest: plugin.value as PluginManifest | null
  };
}
