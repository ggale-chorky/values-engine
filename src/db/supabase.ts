import { createClient } from '@supabase/supabase-js';

/** Trusted Node scripts only. No client is created and no env file read on import. */
export function createServerClient(env: NodeJS.ProcessEnv = process.env) {
  if (typeof globalThis === 'object' && 'window' in globalThis) throw new Error('Supabase server client requires Node.js.');
  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_SECRET_KEY?.trim();
  if (!url) throw new Error('SUPABASE_URL is required.');
  if (!key) throw new Error('SUPABASE_SECRET_KEY is required.');
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
  } catch { throw new Error('SUPABASE_URL must be a valid HTTP(S) URL.'); }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}
