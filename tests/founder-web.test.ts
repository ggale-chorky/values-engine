import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import type { Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { createDemoWebServer } from '../src/web/server.js';
import { DEMO_POLICY, FAILURE_MESSAGE, assistantPlainText, policyCard, renderResult, safeSourceUrl } from '../src/web/result.js';
import type { DecisionView } from '../src/web/result.js';
import { BROWSER_SCRIPT, PAGE, STYLES } from '../src/web/page.js';
import * as agent from '../src/demo/shopping-policy-agent.js';

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    if (!server.listening) return resolve();
    server.closeAllConnections(); server.close(error => error ? reject(error) : resolve());
  })));
});
function fixture(status: DecisionView['decision'] = 'PASS'): DecisionView {
  return { decision: status, reason: status === 'PASS' ? 'threshold_met' : status === 'FAIL' ? 'threshold_exceeded' : 'missing_evidence',
    policy: { id: 'policy-id', name: DEMO_POLICY }, rule: { criterion: 'uk_median_gender_pay_gap', operator: '<=', threshold: 10 },
    subject: { brand: 'Example' }, entity: { legal_name: 'EXAMPLE LIMITED', company_number: '00123456', relationship_type: 'seller', verification_status: 'human_verified' },
    evidence: { observed_value: status === 'FAIL' ? 18.95 : 7.4, unit: 'percent', reporting_period: '2025-26',
      source_name: 'UK Gender Pay Gap Service', source_url: 'https://example.test/report?x=1&y=2', evidence_id: 'evidence-id' },
    scope: 'Evaluation applies to the verified UK commerce entity associated with the brand; it does not assert that this entity is the ultimate parent, manufacturer, brand owner, or employer unless separately evidenced.',
    explanation: 'A deterministic explanation.' };
}
function mockDemo(value = fixture()) {
  return vi.fn<typeof agent.runShoppingPolicyDemo>().mockImplementation(async (input, deps) => {
    deps?.onDecision?.(value);
    return { ...input, tool_called: true, tool_name: 'evaluate_brand_policy', decision: value.decision, reason: value.reason, answer: 'Your shopping assistant explains the result.' };
  });
}
async function start(runDemo = mockDemo(), environment = () => ({ OPENAI_API_KEY: 'private-openai', SUPABASE_SECRET_KEY: 'private-supabase' })) {
  const server = createDemoWebServer({ runDemo, environment }); servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing local address');
  return { url: `http://127.0.0.1:${address.port}`, runDemo };
}
const post = (url: string, data: unknown) => fetch(`${url}/api/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
it('serves the polished local page and assets without loading credentials or evaluating', async () => {
  const environment = vi.fn(() => ({ OPENAI_API_KEY: 'private-openai', SUPABASE_SECRET_KEY: 'private-supabase' }));
  const { url, runDemo } = await start(mockDemo(), environment);
  const response = await fetch(url); const html = await response.text();
  expect(response.status).toBe(200); expect(html).toContain('Your money.'); expect(html).toContain('Your rules.');
  for (const name of ['Lush', 'Vichy', 'Molton Brown']) expect(html).toContain(`data-brand="${name}"`);
  expect(html).toContain('Gender pay gap'); expect(html).toContain('≤ 10%'); expect(html).toContain('Check my policy');
  expect((await fetch(`${url}/styles.css`)).status).toBe(200); expect((await fetch(`${url}/app.js`)).status).toBe(200);
  expect(environment).not.toHaveBeenCalled(); expect(runDemo).not.toHaveBeenCalled();
});
it.each([{}, { question: '' }, { question: ' ' }, { question: 1 }, { question: 'x'.repeat(801) }, { question: 'Hello', policy: 'Other' }])('rejects invalid browser input %j before invoking agent', async input => {
  const { url, runDemo } = await start(); expect((await post(url, input)).status).toBe(400); expect(runDemo).not.toHaveBeenCalled();
});
it.each(['PASS', 'FAIL', 'UNKNOWN'] as const)('renders %s from observed MCP content, with fixed policy and hidden provenance metadata', async status => {
  const value = fixture(status); const { url, runDemo } = await start(mockDemo(value));
  const response = await post(url, { question: 'Can I buy from Example?' }); const body = await response.json();
  expect(response.status).toBe(200);
  expect(runDemo).toHaveBeenCalledWith({ question: 'Can I buy from Example?', policy: DEMO_POLICY }, expect.objectContaining({ onDecision: expect.any(Function) }));
  expect(body.result.decision).toBe(status); expect(body.result.reason).toBe(value.reason);
  expect(body.metadata).toEqual({ tool_called: true, tool_name: 'evaluate_brand_policy', selected_policy: DEMO_POLICY, provenance: 'mcp_tool_response' });
  expect(body.html).toContain(`data-decision="${status}"`);
  expect(body.html).toContain(status === 'UNKNOWN' ? 'NOT ENOUGH VERIFIED DATA' : status === 'PASS' ? 'Example fits your purchasing policy.' : 'Example does not fit your purchasing policy.');
  expect(body.html).toContain('What your shopping assistant says'); expect(body.html).toContain(value.scope);
});
it('uses the actual existing agent service by default', async () => {
  const spy = vi.spyOn(agent, 'runShoppingPolicyDemo').mockImplementation(mockDemo());
  const server = createDemoWebServer({ environment: () => ({ OPENAI_API_KEY: 'private-openai' }) }); servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error();
  expect((await post(`http://127.0.0.1:${address.port}`, { question: 'Can I buy from Lush?' })).status).toBe(200);
  expect(spy).toHaveBeenCalledTimes(1);
});
it('does not fabricate missing UNKNOWN evidence or entity fields', async () => {
  const value = fixture('UNKNOWN'); value.entity.legal_name = null;
  value.evidence = { observed_value: null, unit: null, reporting_period: null, source_name: null, source_url: null, evidence_id: null };
  const { url } = await start(mockDemo(value)); const body = await (await post(url, { question: 'Example?' })).json();
  expect(body.result.evidence).toEqual(value.evidence); expect(body.result.entity.legal_name).toBeNull();
  expect(body.html).toContain('Not available'); expect(body.html).not.toContain('href=');
  expect(body.html).toContain('sufficient verified gender-pay evidence');
});
it.each([{ tool_called: false }, { tool_name: 'other' }, { tool_name: undefined }, { decision: 'FAIL' }, { reason: 'fabricated' }, { policy: 'Other' }])('fails safely for invalid agent metadata %j', async override => {
  const base = mockDemo(); const runDemo = vi.fn<typeof agent.runShoppingPolicyDemo>().mockImplementation(async (...args) => ({ ...await base(...args), ...override }) as Awaited<ReturnType<typeof agent.runShoppingPolicyDemo>>);
  const { url } = await start(runDemo); const response = await post(url, { question: 'Example?' });
  expect(response.status).toBe(502); expect(await response.json()).toEqual({ error: FAILURE_MESSAGE });
});
it('requires an actual observed MCP object, not just a claimed tool call', async () => {
  const runDemo = vi.fn<typeof agent.runShoppingPolicyDemo>().mockResolvedValue({ question: 'Example?', policy: DEMO_POLICY, tool_called: true, tool_name: 'evaluate_brand_policy', decision: 'PASS', reason: 'threshold_met', answer: 'PASS' });
  const { url } = await start(runDemo); expect((await post(url, { question: 'Example?' })).status).toBe(502);
});
it('sanitizes operational failures and serializes neither secrets nor incidental raw fields', async () => {
  const runDemo = mockDemo(); runDemo.mockRejectedValueOnce(new Error('private-openai private-supabase stack trace'));
  const { url } = await start(runDemo); const response = await post(url, { question: 'Example?' });
  expect(response.status).toBe(502); expect(await response.json()).toEqual({ error: FAILURE_MESSAGE });
  const value = { ...fixture(), OPENAI_API_KEY: 'private-openai', debug: { password: 'private-supabase' } };
  runDemo.mockImplementation(mockDemo(value)); const body = await (await post(url, { question: 'Example?' })).text();
  expect(body).not.toContain('private-openai'); expect(body).not.toContain('private-supabase'); expect(body).not.toContain('debug');
});
it('fails closed if an otherwise allowlisted answer contains a credential', async () => {
  const base = mockDemo(); const runDemo = vi.fn<typeof agent.runShoppingPolicyDemo>().mockImplementation(async (...args) => ({ ...await base(...args), answer: 'private-openai' }));
  const { url } = await start(runDemo); expect(await (await post(url, { question: 'Example?' })).json()).toEqual({ error: FAILURE_MESSAGE });
});
it.each(['javascript:alert(1)', 'data:text/html,hello', '/relative', 'https://user:password@example.test', '[source](https://example.test)'])('does not link unsafe source %s', value => {
  expect(safeSourceUrl(value)).toBeNull(); const result = fixture(); result.evidence.source_url = value;
  expect(renderResult(result, 'Answer')).not.toContain('href=');
});
it('escapes all returned text and uses raw safe absolute source links', () => {
  const value = fixture(); value.entity.legal_name = '<script>bad()</script>';
  const html = renderResult(value, '<img src=x onerror=alert(1)>');
  expect(html).not.toContain('<script>'); expect(html).not.toContain('<img');
  expect(html).toContain('&lt;script&gt;'); expect(html).toContain('href="https://example.test/report?x=1&amp;y=2"');
  expect(html).toContain('rel="noopener noreferrer"');
});
it('shows persisted thresholds even if they differ from the initial demo policy preview', async () => {
  const value = fixture(); value.rule.threshold = 3;
  const { url } = await start(mockDemo(value)); const body = await (await post(url, { question: 'Example?' })).json();
  expect(body.policy_summary).toBe('UK median gender pay gap ≤ 3%'); expect(body.result.decision).toBe('PASS');
});
it('prevents concurrent paid runs and rejects cross-origin calls', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const base = mockDemo(); const runDemo = vi.fn<typeof agent.runShoppingPolicyDemo>().mockImplementation(async (...args) => { await gate; return base(...args); });
  const { url } = await start(runDemo);
  const first = post(url, { question: 'Example?' });
  await vi.waitFor(() => expect(runDemo).toHaveBeenCalledTimes(1));
  expect((await post(url, { question: 'Example?' })).status).toBe(409);
  release(); expect((await first).status).toBe(200);
  expect((await fetch(`${url}/api/check`, { method: 'POST', headers: { Origin: 'https://other.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Example?' }) })).status).toBe(403);
});
it('web source imports no direct decision, evaluation, policy or database services', async () => {
  for (const file of ['server.ts', 'result.ts', 'page.ts']) {
    const source = await readFile(new URL(`../src/web/${file}`, import.meta.url), 'utf8');
    expect(source).not.toMatch(/from ['"].*(?:\/db\/|\/decision\/|\/evaluation\/|\/policies\/)/);
  }
});

it('browser shortcuts submit natural questions, lock controls while loading and render safe operational failure', async () => {
  const handlers: Record<string, (event?: any) => void> = {};
  const element = () => ({ disabled: false, hidden: true, value: '', innerHTML: '', textContent: '', dataset: { brand: 'Vichy' },
    addEventListener: vi.fn(), setAttribute: vi.fn(), focus: vi.fn(), scrollIntoView: vi.fn(), reportValidity: () => true });
  const form = element(), input = element(), shortcut = element(), submit = element(), progress = element(), error = element(), result = element(), policy = element(), empty = element();
  form.addEventListener.mockImplementation((name, fn) => { handlers[name] = fn; });
  shortcut.addEventListener.mockImplementation((_name, fn) => { handlers.click = fn; });
  const elements: Record<string, typeof form> = { form, '#question': input, '#progress': progress, '#error': error, '#result': result, '#policy-criterion': policy, '#policy-threshold': element(), '#empty': empty };
  let resolve!: (value: unknown) => void;
  const fetch = vi.fn(() => new Promise(done => { resolve = done; }));
  runInContext(BROWSER_SCRIPT, createContext({ document: { querySelector: (selector: string) => elements[selector], querySelectorAll: (selector: string) => selector === 'button' ? [shortcut, submit] : [shortcut] }, fetch, matchMedia: () => ({ matches: true }) }));
  handlers.click!(); expect(input.value).toBe('Can I buy from Vichy?'); expect(progress.hidden).toBe(false); expect(submit.disabled).toBe(true);
  handlers.submit!({ preventDefault() {} }); expect(fetch).toHaveBeenCalledTimes(1);
  resolve({ ok: false }); await vi.waitFor(() => expect(error.hidden).toBe(false));
  expect(progress.hidden).toBe(true); expect(submit.disabled).toBe(false); expect(result.hidden).toBe(true);
});

it.each([['Lush', 'PASS', 'Lush fits your purchasing policy.'], ['Vichy', 'FAIL', 'Vichy does not fit your purchasing policy.'], ['Different brand', 'PASS', 'Different brand fits your purchasing policy.']] as const)('uses dynamic verdict copy for %s', (brand, status, copy) => {
  const value = fixture(status); value.subject.brand = brand;
  expect(renderResult(value, 'Contradictory model prose must not set the status.')).toContain(`<h2>${copy}</h2>`);
});
it('escapes dynamic brand names in the primary verdict', () => {
  const value = fixture(); value.subject.brand = '<img src=x onerror=bad()>';
  const html = renderResult(value, 'Answer');
  expect(html).not.toContain('<img'); expect(html).toContain('&lt;img src=x onerror=bad()&gt; fits your purchasing policy.');
});
it.each(['missing_evidence', 'no_verified_commerce_entity', 'brand_not_found', 'ambiguous_legal_entity', 'new_reason'])('uses reason-aware UNKNOWN copy without availability claims for %s', reason => {
  const value = fixture('UNKNOWN'); value.reason = reason;
  const html = renderResult(value, 'Answer');
  expect(html).toContain('We don’t have enough verified data to assess this brand yet.');
  expect(html).toContain('No guess made.');
  expect(html).not.toContain('not yet available in Values Engine'); expect(html).not.toContain(reason);
});
it('renders Markdown as escaped plain text, keeping useful line breaks', () => {
  const answer = '## **Your result**\n- **Lush** fits.\n* _Verified evidence_ is available.\n1. Read [the source](https://example.test).\n\n`Never run <script>bad()</script>`';
  const plain = assistantPlainText(answer);
  expect(plain).toContain('Your result\nLush fits.\nVerified evidence is available.\nRead the source.');
  expect(plain).not.toMatch(/\*|`|^#|^[-+] |^\d+\. /m);
  const html = renderResult(fixture(), answer);
  expect(html).not.toContain('**'); expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
});
it('keeps policy-card threshold formatting tied to the returned rule', () => {
  expect(policyCard({ criterion: 'uk_median_gender_pay_gap', operator: '<=', threshold: 2.5 })).toEqual({ criterion: 'Gender pay gap', threshold: '≤ 2.5%' });
  expect(policyCard({ criterion: null, operator: null, threshold: null }).threshold).toBe('Not available');
  expect(BROWSER_SCRIPT).toContain("document.querySelector('#policy-threshold').textContent = data.policy_card.threshold");
  expect(PAGE).toContain('Applied whenever your AI shops.');
  const card = PAGE.slice(PAGE.indexOf('<aside'), PAGE.indexOf('</aside>'));
  expect(card).not.toContain('↗'); expect(card).not.toContain('<button');
});
it('retains keyboard focus indication without accidental mouse outline and keeps shortcuts outcome-free', () => {
  expect(STYLES).toContain('#result:focus:not(:focus-visible)');
  expect(STYLES).toContain('#result:focus-visible,#error:focus-visible{outline:2px solid var(--olive)');
  expect(PAGE).toContain('id="result" tabindex="-1" aria-live="polite"');
  expect(STYLES).toContain('min-height:44px');
  expect(BROWSER_SCRIPT).toContain("question.value = 'Can I buy from ' + button.dataset.brand + '?'");
  expect(BROWSER_SCRIPT).not.toMatch(/PASS|FAIL|UNKNOWN|Lush|Vichy|Molton Brown/);
});
