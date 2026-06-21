import { z } from 'zod';

const EnvSchema = z.object({
  WIKI_VAULT: z.string().min(1).describe('Absolute path to the Obsidian vault root'),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
    .default('info')
    .describe('Pino log level. Logs go to stderr to keep the stdio JSON-RPC stream clean.'),
  SERVER_NAME: z.string().default('wiki-mcp'),
  SERVER_VERSION: z.string().default('0.0.0')
});

export interface Config {
  readonly wikiVault: string;
  readonly logLevel: z.infer<typeof EnvSchema>['LOG_LEVEL'];
  readonly serverName: string;
  readonly serverVersion: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return {
    wikiVault: parsed.data.WIKI_VAULT,
    logLevel: parsed.data.LOG_LEVEL,
    serverName: parsed.data.SERVER_NAME,
    serverVersion: parsed.data.SERVER_VERSION
  };
}
