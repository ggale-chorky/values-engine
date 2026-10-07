import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import * as dotenv from 'dotenv';
import * as supabase from '../src/db/supabase.js';
import { configuredClient, loadServerEnvironment, SERVER_ENV_PATH } from '../src/runtime/server-config.js';
import { configuredClient as cliClient } from '../src/scripts/db-cli.js';
import { configuredBrandDecision } from '../src/runtime/brand-decision.js';
import * as decision from '../src/decision/evaluate-brand-decision.js';
import { main as cli } from '../src/scripts/decision-brand.js';

vi.mock('dotenv', { spy: true });

const cleanups: string[] = [];
afterEach(async () => { vi.mocked(dotenv.config).mockReset(); vi.restoreAllMocks(); for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true }); });

it('reproduces cwd-dependent dotenv failure and fixes it with an explicit project path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'values-bootstrap-')); cleanups.push(root);
  const project = join(root, 'project'); const host = join(root, 'inspector');
  await mkdir(project); await mkdir(host);
  const envPath = join(project, '.env');
  await writeFile(envPath, 'SUPABASE_URL=https://example.test\nSUPABASE_SECRET_KEY=test-only\n');
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(project);
  const cliEnv: NodeJS.ProcessEnv = {};
  dotenv.config({ processEnv: cliEnv, quiet: true });
  expect(cliEnv.SUPABASE_SECRET_KEY).toBe('test-only');
  cwd.mockReturnValue(host);
  const oldMcpEnv: NodeJS.ProcessEnv = {};
  dotenv.config({ processEnv: oldMcpEnv, quiet: true });
  expect(oldMcpEnv.SUPABASE_SECRET_KEY).toBeUndefined();
  expect(loadServerEnvironment({}, envPath)).toEqual(cliEnv);
  expect(SERVER_ENV_PATH).toBe(fileURLToPath(new URL('../.env', import.meta.url)));
});

it('preserves inherited configuration and does not mutate process environment or log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'values-bootstrap-')); cleanups.push(root);
  const envPath = join(root, '.env');
  await writeFile(envPath, 'SUPABASE_URL=https://file.example.test\nSUPABASE_SECRET_KEY=file-test-only\n');
  const inherited = { SUPABASE_URL: 'https://inherited.example.test', SUPABASE_SECRET_KEY: 'inherited-test-only' };
  const log = vi.spyOn(console, 'log'); const stdout = vi.spyOn(process.stdout, 'write');
  expect(loadServerEnvironment(inherited, envPath)).toEqual(inherited);
  expect(inherited.SUPABASE_SECRET_KEY).toBe('inherited-test-only');
  expect(log).not.toHaveBeenCalled(); expect(stdout).not.toHaveBeenCalled();
});

it('CLI and MCP share bootstrap, load the environment before constructing clients, and delegate once each', async () => {
  expect(cliClient).toBe(configuredClient);
  const steps: string[] = [];
  vi.spyOn(dotenv, 'config').mockImplementation(options => {
    steps.push('environment');
    expect(options?.path).toBe(SERVER_ENV_PATH); expect(options?.quiet).toBe(true);
    options!.processEnv!.SUPABASE_URL = 'https://example.test'; options!.processEnv!.SUPABASE_SECRET_KEY = 'test-only';
    return { parsed: {} };
  });
  const client = supabase.createServerClient({ SUPABASE_URL: 'https://example.test', SUPABASE_SECRET_KEY: 'test-only' });
  vi.spyOn(supabase, 'createServerClient').mockImplementation(env => {
    steps.push('client'); expect(env?.SUPABASE_SECRET_KEY).toBe('test-only'); return client;
  });
  const evaluate = vi.spyOn(decision, 'evaluateBrandDecision').mockResolvedValue({ decision: 'UNKNOWN' } as decision.BrandDecision);
  await cli(['--brand', 'Example', '--policy', 'Policy'], { log: vi.fn() });
  await configuredBrandDecision({ brand: 'Example', policy: 'Policy' });
  expect(steps).toEqual(['environment', 'client', 'environment', 'client']);
  expect(evaluate).toHaveBeenCalledTimes(2);
  expect(evaluate.mock.calls.map(call => call[0])).toEqual([{ brand: 'Example', policy: 'Policy' }, { brand: 'Example', policy: 'Policy' }]);
});

it('sanitizes bootstrap errors without stdout logging', async () => {
  vi.spyOn(dotenv, 'config').mockImplementation(() => { throw new Error('SECRET=do-not-log'); });
  const create = vi.spyOn(supabase, 'createServerClient'); const stdout = vi.spyOn(process.stdout, 'write');
  await expect(configuredClient()).rejects.toThrow('Database configuration requires valid SUPABASE_URL and SUPABASE_SECRET_KEY.');
  expect(create).not.toHaveBeenCalled(); expect(stdout).not.toHaveBeenCalled();
});

it('uses inherited configuration when no env file exists', () => {
  const environment = { SUPABASE_URL: 'https://example.test', SUPABASE_SECRET_KEY: 'test-only' };
  expect(loadServerEnvironment(environment, '/nonexistent-values-test/.env')).toEqual(environment);
});
