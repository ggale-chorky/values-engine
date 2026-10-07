import { annotateFailure } from './mcp-diagnostics.js';
import type { RuntimeDiagnostic } from './mcp-diagnostics.js';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { DataError } from '../db/rows.js';
import { createServerClient } from '../db/supabase.js';

// Both src/runtime and built dist/runtime are two levels below the project root.
// Never depend on an MCP host's working directory or load its unrelated .env.
export const SERVER_ENV_PATH = fileURLToPath(new URL('../../.env', import.meta.url));

export function loadServerEnvironment(inherited: NodeJS.ProcessEnv = process.env, envPath = SERVER_ENV_PATH): NodeJS.ProcessEnv {
  const environment = { ...inherited };
  config({ path: envPath, processEnv: environment, override: false, quiet: true });
  return environment;
}

/** Shared CLI/MCP bootstrap. No environment loading or client construction on import. */
export async function configuredClient(observe?: (presence: RuntimeDiagnostic) => void) {
  const presence: RuntimeDiagnostic = { stage: 'runtime_init' };
  try {
    const environment = loadServerEnvironment();
    presence.supabase_url_present = Boolean(environment.SUPABASE_URL?.trim());
    presence.supabase_secret_key_present = Boolean(environment.SUPABASE_SECRET_KEY?.trim());
    observe?.(presence);
    return createServerClient(environment);
  } catch {
    const error = new DataError('Database configuration requires valid SUPABASE_URL and SUPABASE_SECRET_KEY.');
    annotateFailure(error, presence);
    throw error;
  }
}
