import { z } from 'zod';

const BaseEnvSchema = z.object({
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
    .default('info')
    .describe('Pino log level. Logs go to stderr to keep the stdio JSON-RPC stream clean.'),
  SERVER_NAME: z.string().default('wiki-mcp'),
  SERVER_VERSION: z.string().default('0.0.0')
});

const EnvSchema = BaseEnvSchema.extend({
  WIKI_VAULT: z.string().min(1).describe('Absolute path to the Obsidian vault root')
});

export interface Config {
  readonly wikiVault: string;
  readonly logLevel: z.infer<typeof EnvSchema>['LOG_LEVEL'];
  readonly serverName: string;
  readonly serverVersion: string;
}

function parseEnv<T>(schema: z.ZodType<T>, env: NodeJS.ProcessEnv): T {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const data = parseEnv(EnvSchema, env);
  return {
    wikiVault: data.WIKI_VAULT,
    logLevel: data.LOG_LEVEL,
    serverName: data.SERVER_NAME,
    serverVersion: data.SERVER_VERSION
  };
}

export type ServerEnv = Omit<Config, 'wikiVault'>;

/** Deferred-binding form: the vault root is not known until after initialize. */
export function loadServerEnv(env: NodeJS.ProcessEnv = process.env): ServerEnv {
  const data = parseEnv(BaseEnvSchema, env);
  return {
    logLevel: data.LOG_LEVEL,
    serverName: data.SERVER_NAME,
    serverVersion: data.SERVER_VERSION
  };
}
