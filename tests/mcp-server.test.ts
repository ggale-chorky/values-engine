import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { afterEach, expect, it, vi } from 'vitest';
import { createMcpServer } from '../src/mcp/server.js';
import type { BrandDecision } from '../src/decision/evaluate-brand-decision.js';
import { configuredBrandDecision } from '../src/runtime/brand-decision.js';
import * as decisions from '../src/decision/evaluate-brand-decision.js';
import * as config from '../src/scripts/db-cli.js';
import { createClient } from '@supabase/supabase-js';

const close: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of close.splice(0)) await fn(); vi.restoreAllMocks(); });
function result(decision: BrandDecision['decision']): BrandDecision {
  return { decision, reason: decision === 'UNKNOWN' ? 'missing_evidence' : decision === 'PASS' ? 'threshold_met' : 'threshold_exceeded',
    policy: { id: 'policy', name: 'Policy' }, rule: { criterion: 'uk_median_gender_pay_gap', operator: '<=', threshold: 10 },
    subject: { brand: 'Example' }, entity: { legal_name: null, company_number: null, relationship_type: null, verification_status: null },
    evidence: { observed_value: null, unit: null, reporting_period: null, source_name: null, source_url: 'https://example.test/evidence?id=1', evidence_id: null },
    scope: 'Scope supplied unchanged by Decision Service', explanation: 'Explanation supplied unchanged by Decision Service' };
}
// Local SDK transport only. No external MCP client, credentials or database.
async function session(decide = vi.fn().mockResolvedValue(result('PASS'))) {
  const input = new PassThrough(); const output = new PassThrough();
  const server = createMcpServer(decide);
  close.push(() => server.close());
  let buffer = ''; let nextId = 0;
  const pending = new Map<number, (message: any) => void>();
  output.on('data', chunk => {
    buffer += String(chunk);
    while (buffer.includes('\n')) {
      const line = buffer.slice(0, buffer.indexOf('\n')); buffer = buffer.slice(buffer.indexOf('\n') + 1);
      const message = JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id);
    }
  });
  await server.connect(new StdioServerTransport(input, output));
  async function request(method: string, params: Record<string, unknown>) {
    const id = ++nextId;
    const response = new Promise<any>(resolve => pending.set(id, resolve));
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return response;
  }
  await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'local-test', version: '1' } });
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  return { request, decide };
}
it('registers exactly one read-only tool and the required input schema', async () => {
  const { request } = await session(); const response = await request('tools/list', {});
  expect(response.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['evaluate_brand_policy']);
  expect(response.result.tools[0]).toMatchObject({ annotations: { readOnlyHint: true }, inputSchema: { required: ['brand', 'policy'], additionalProperties: false } });
});
it.each(['PASS', 'FAIL', 'UNKNOWN'] as const)('passes %s through identically as structured content and concise JSON', async decision => {
  const value = result(decision); const decide = vi.fn().mockResolvedValue(value);
  const { request } = await session(decide);
  const response = await request('tools/call', { name: 'evaluate_brand_policy', arguments: { brand: 'Example', policy: 'Policy' } });
  expect(decide).toHaveBeenCalledExactlyOnceWith({ brand: 'Example', policy: 'Policy' });
  expect(response.result).toEqual({ structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] });
  expect(response.result.structuredContent.entity.legal_name).toBeNull();
  expect(response.result.structuredContent.evidence.source_url).toBe('https://example.test/evidence?id=1');
});
it.each(['missing_evidence', 'no_verified_commerce_entity', 'ambiguous_legal_entity', 'unsupported_rule'] as const)('keeps %s as a normal UNKNOWN result', async reason => {
  const value = { ...result('UNKNOWN'), reason };
  const { request } = await session(vi.fn().mockResolvedValue(value));
  const response = await request('tools/call', { name: 'evaluate_brand_policy', arguments: { brand: 'Example', policy: 'Policy' } });
  expect(response.result.structuredContent).toEqual(value); expect(response.result.isError).toBeUndefined();
});
it.each([{}, { brand: '', policy: 'Policy' }, { brand: ' ', policy: 'Policy' }, { brand: 'Example', policy: '' },
  { brand: 1, policy: 'Policy' }, { brand: 'Example', policy: 'Policy', threshold: 99 }])('rejects malformed arguments %j without delegation', async args => {
  const { request, decide } = await session();
  const response = await request('tools/call', { name: 'evaluate_brand_policy', arguments: args });
  expect(Boolean(response.error || response.result?.isError)).toBe(true); expect(decide).not.toHaveBeenCalled();
});
it('sanitizes internal errors with no application stdout logging', async () => {
  const stdout = vi.spyOn(process.stdout, 'write'); const log = vi.spyOn(console, 'log');
  const { request, decide } = await session(vi.fn().mockRejectedValue(new Error('SECRET_KEY=private stack trace')));
  const response = await request('tools/call', { name: 'evaluate_brand_policy', arguments: { brand: 'Example', policy: 'Policy' } });
  expect(response.result.isError).toBe(true); expect(JSON.stringify(response)).not.toContain('SECRET');
  expect(decide).toHaveBeenCalledTimes(1); expect(log).not.toHaveBeenCalled(); expect(stdout).not.toHaveBeenCalled();
});
it('runtime delegates exactly once to the existing Decision Service without direct queries', async () => {
  const fetch = vi.fn();
  vi.spyOn(config, 'configuredClient').mockResolvedValue(createClient('https://example.test', 'test-only', { global: { fetch } }));
  const value = result('PASS'); const evaluate = vi.spyOn(decisions, 'evaluateBrandDecision').mockResolvedValue(value);
  expect(await configuredBrandDecision({ brand: 'Example', policy: 'Policy' })).toBe(value);
  expect(evaluate).toHaveBeenCalledExactlyOnceWith({ brand: 'Example', policy: 'Policy' }, { db: { read: expect.any(Function) } });
  expect(fetch).not.toHaveBeenCalled();
});
it('has no threshold/evidence/DB logic in the MCP layer and silences npm banners', async () => {
  const source = await readFile(new URL('../src/mcp/server.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/supabase|\.from\(|\.rpc\(|\.read\(|threshold|evaluateRule|selectPolicy/);
  expect(source).not.toMatch(/console\.log|process\.stdout\.write/);
  expect(await readFile(new URL('../.npmrc', import.meta.url), 'utf8')).toContain('loglevel=silent');
});
