import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { runShoppingPolicyDemo } from '../demo/shopping-policy-agent.js';
import { loadServerEnvironment } from '../runtime/server-config.js';
import { BROWSER_SCRIPT, PAGE, STYLES } from './page.js';
import { decisionViewSchema, DEMO_POLICY, FAILURE_MESSAGE, policyCard, policySummary, renderResult, safeSourceUrl } from './result.js';

export interface WebDependencies {
  runDemo?: typeof runShoppingPolicyDemo;
  environment?: () => NodeJS.ProcessEnv;
}
const inputSchema = z.object({ question: z.string().trim().min(1).max(800) }).strict();
function send(response: ServerResponse, status: number, body: string, type = 'application/json') {
  response.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
  response.end(body);
}
async function readQuestion(request: IncomingMessage) {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new Error('Invalid request');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > 8192) throw new Error('Request too large');
    chunks.push(Buffer.from(chunk));
  }
  return inputSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

/** Local presentation server. All evaluations travel through the existing agent and MCP. */
export function createDemoWebServer(dependencies: WebDependencies = {}) {
  let busy = false;
  return createServer(async (request, response) => {
    const failure = (status: number) => send(response, status, JSON.stringify({ error: FAILURE_MESSAGE }));
    // Only serve the loopback origin; cross-origin pages cannot initiate paid demo calls.
    const host = `127.0.0.1:${request.socket.localPort}`;
    if (request.headers.host !== host || (request.headers.origin && request.headers.origin !== `http://${host}`)) return failure(403);
    if (request.method === 'GET' && request.url === '/') return send(response, 200, PAGE, 'text/html');
    if (request.method === 'GET' && request.url === '/styles.css') return send(response, 200, STYLES, 'text/css');
    if (request.method === 'GET' && request.url === '/app.js') return send(response, 200, BROWSER_SCRIPT, 'text/javascript');
    if (request.url !== '/api/check') return failure(404);
    if (request.method !== 'POST') return failure(405);
    let input;
    try { input = await readQuestion(request); } catch { return failure(400); }
    if (busy) return failure(409);
    busy = true;
    try {
      const env = (dependencies.environment ?? loadServerEnvironment)();
      let evidence: unknown;
      let observations = 0;
      const demo = await (dependencies.runDemo ?? runShoppingPolicyDemo)({ question: input.question, policy: DEMO_POLICY }, {
        apiKey: env.OPENAI_API_KEY,
        onDecision(value) { observations++; evidence = value; },
      });
      const decision = decisionViewSchema.parse(evidence);
      if (observations !== 1 || demo.tool_called !== true || demo.tool_name !== 'evaluate_brand_policy' || demo.policy !== DEMO_POLICY
        || demo.question !== input.question || demo.decision !== decision.decision || demo.reason !== decision.reason
        || typeof demo.answer !== 'string' || !demo.answer.trim()) throw new Error('Invalid demo result');
      decision.evidence.source_url = safeSourceUrl(decision.evidence.source_url);
      // Explicit allowlist: never serialize the environment, raw SDK objects or incidental fields.
      const payload = { result: { ...decision, answer: demo.answer },
        metadata: { tool_called: true, tool_name: demo.tool_name, selected_policy: DEMO_POLICY, provenance: 'mcp_tool_response' },
        policy_summary: policySummary(decision.rule), policy_card: policyCard(decision.rule), html: renderResult(decision, demo.answer) };
      const serialized = JSON.stringify(payload);
      const privateValues = [env.OPENAI_API_KEY, env.SUPABASE_SECRET_KEY, env.SUPABASE_URL, env.COMPANIES_HOUSE_API_KEY, env.DATABASE_URL].filter((value): value is string => Boolean(value));
      if (privateValues.some(value => serialized.includes(value) || serialized.includes(JSON.stringify(value).slice(1, -1)))) throw new Error('Private output');
      send(response, 200, serialized);
    } catch { failure(502); }
    finally { busy = false; }
  });
}
