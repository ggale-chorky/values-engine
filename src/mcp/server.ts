import { reportMcpFailure } from '../runtime/mcp-diagnostics.js';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import type { BrandDecision } from '../decision/evaluate-brand-decision.js';
import { configuredBrandDecision } from '../runtime/brand-decision.js';
import { isMain } from '../scripts/db-cli.js';

export type DecisionService = (input: { brand: string; policy: string }) => Promise<BrandDecision>;

export function createMcpServer(decide: DecisionService = configuredBrandDecision) {
  const server = new McpServer({ name: 'values-engine', version: '1.0.0' });
  server.registerTool('evaluate_brand_policy', {
    description: 'Evaluate a brand against a persisted purchasing policy (UUID or exact name), using verified entity relationships and existing evidence. Returns PASS, FAIL or UNKNOWN with provenance.',
    inputSchema: z.object({ brand: z.string().trim().min(1), policy: z.string().trim().min(1) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async input => {
    let stage: 'mcp_handler' | 'response_serialization' = 'mcp_handler';
    try {
      const decision = await decide(input);
      stage = 'response_serialization';
      return { structuredContent: { ...decision }, content: [{ type: 'text' as const, text: JSON.stringify(decision) }] };
    } catch (error) {
      reportMcpFailure(error, stage);
      return { isError: true, content: [{ type: 'text' as const, text: 'Unable to evaluate the brand policy. Check the brand/policy inputs and server configuration.' }] };
    }
  });
  return server;
}

export function main() {
  return serveStdio(() => createMcpServer(), {
    onerror: () => { console.error('MCP stdio error.'); },
  });
}
if (isMain(import.meta.url)) {
  try { main(); }
  catch { console.error('MCP server failed to start.'); process.exitCode = 1; }
}
