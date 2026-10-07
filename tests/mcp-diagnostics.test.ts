import { afterEach, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { DataError } from '../src/db/rows.js';
import { annotateFailure, reportMcpFailure } from '../src/runtime/mcp-diagnostics.js';
import * as runtime from '../src/runtime/brand-decision.js';
import * as config from '../src/scripts/db-cli.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it('is disabled by default', () => {
  vi.stubEnv('VALUES_ENGINE_MCP_DEBUG', undefined);
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  reportMcpFailure(new Error('private'));
  expect(stderr).not.toHaveBeenCalled();
});
it('only prints allowed messages, fixed classes and presence booleans to stderr', () => {
  vi.stubEnv('VALUES_ENGINE_MCP_DEBUG', '1');
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  const stdout = vi.spyOn(process.stdout, 'write');
  const error = new DataError('SUPABASE_SECRET_KEY=private https://private.example.test Authorization: Bearer secret');
  error.name = 'API_KEY=hidden';
  annotateFailure(error, { stage: 'runtime_init', supabase_url_present: true, supabase_secret_key_present: false });
  reportMcpFailure(error);
  expect(JSON.parse(stderr.mock.calls[0]![0])).toEqual({ diagnostic: 'values_engine_mcp_failure', stage: 'runtime_init',
    supabase_url_present: true, supabase_secret_key_present: false, error_class: 'DataError', message: 'Unexpected failure; details redacted.' });
  expect(stdout).not.toHaveBeenCalled();
});
it('retains safe policy lookup details from the actual adapter without added reads', async () => {
  vi.stubEnv('VALUES_ENGINE_MCP_DEBUG', '1');
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetch = vi.fn().mockResolvedValue(new Response('[]', { headers: { 'Content-Type': 'application/json' } }));
  vi.spyOn(config, 'configuredClient').mockImplementation(async observe => {
    observe?.({ stage: 'runtime_init', supabase_url_present: true, supabase_secret_key_present: true });
    return createClient('https://example.test', 'test-only', { global: { fetch } });
  });
  await runtime.configuredBrandDecision({ brand: 'Example', policy: 'Missing' }).catch(reportMcpFailure);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(stderr.mock.calls[0]![0])).toMatchObject({ stage: 'policy_lookup', message: 'Policy not found.', supabase_secret_key_present: true });
});
