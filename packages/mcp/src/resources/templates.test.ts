import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { registerTemplateResources, TEMPLATES } from './templates.js';

function captureMcp() {
  const handlers = new Map<string, (uri: URL) => Promise<unknown>>();
  const mcp = {
    registerResource: vi.fn(
      (_name: string, uri: string, _meta: unknown, handler: (uri: URL) => Promise<unknown>) => {
        handlers.set(uri, handler);
      }
    )
  } as unknown as McpServer;
  return { mcp, handlers };
}

describe('TEMPLATES array', () => {
  it('has exactly 11 entries matching the vault template set', () => {
    expect(TEMPLATES).toHaveLength(11);
  });

  it('every URI follows wiki://template/{domain}/{kind} or wiki://template/{kind}', () => {
    for (const tmpl of TEMPLATES) {
      expect(tmpl.uri).toMatch(/^wiki:\/\/template\/[\w-]+(\/[\w-]+)?$/);
    }
  });

  it('has no duplicate URIs', () => {
    const uris = TEMPLATES.map((t) => t.uri);
    expect(new Set(uris).size).toBe(uris.length);
  });
});

describe('wiki://templates index resource', () => {
  it('is registered alongside the 11 individual templates', () => {
    const { mcp } = captureMcp();
    registerTemplateResources(mcp, '/fake-vault');

    expect(mcp.registerResource).toHaveBeenCalledTimes(12);
  });

  it('returns markdown listing every template name and URI', async () => {
    const { mcp, handlers } = captureMcp();
    registerTemplateResources(mcp, '/fake-vault');

    const handler = handlers.get('wiki://templates');
    expect(handler).toBeDefined();

    const result = (await handler?.(new URL('wiki://templates'))) as {
      contents: Array<{ text: string }>;
    };
    const text = result.contents[0]?.text;

    expect(text).toContain('# Wiki Templates');
    for (const tmpl of TEMPLATES) {
      expect(text).toContain(tmpl.name);
      expect(text).toContain(tmpl.uri);
    }
  });
});
