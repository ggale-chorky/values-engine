import { z } from 'zod';

export const DEMO_POLICY = 'My purchasing policy';
export const FAILURE_MESSAGE = 'Values Engine couldn’t complete the check. Please try again.';
const text = z.string().nullable();
export const decisionViewSchema = z.object({
  decision: z.enum(['PASS', 'FAIL', 'UNKNOWN']), reason: z.string().min(1),
  policy: z.object({ id: text, name: z.literal(DEMO_POLICY) }),
  rule: z.object({ criterion: text, operator: text, threshold: z.number().finite().nullable() }),
  subject: z.object({ brand: z.string() }),
  entity: z.object({ legal_name: text, company_number: text, relationship_type: z.union([z.string(), z.array(z.string())]).nullable(), verification_status: text }),
  evidence: z.object({ observed_value: z.number().finite().nullable(), unit: text, reporting_period: text, source_name: text, source_url: text, evidence_id: text }),
  scope: z.string().min(1), explanation: z.string(),
});
export type DecisionView = z.infer<typeof decisionViewSchema>;
export function safeSourceUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
const show = (value: string | number | null) => escapeHtml(value === null ? 'Not available' : String(value));
export function policySummary(rule: DecisionView['rule']) {
  const criterion = rule.criterion === 'uk_median_gender_pay_gap' ? 'UK median gender pay gap' : rule.criterion ?? 'Criterion unavailable';
  return `${criterion} ${rule.operator === '<=' ? '≤' : rule.operator ?? '—'} ${rule.threshold === null ? 'Not available' : `${rule.threshold}%`}`;
}
export function policyCard(rule: DecisionView['rule']) {
  return {
    criterion: rule.criterion === 'uk_median_gender_pay_gap' ? 'Gender pay gap' : rule.criterion ?? 'Criterion unavailable',
    threshold: rule.threshold === null ? 'Not available' : `${rule.operator === '<=' ? '≤' : rule.operator ?? '—'} ${rule.threshold}%`,
  };
}

/** Plain-text presentation only. Never interpret model Markdown as HTML. */
export function assistantPlainText(answer: string): string {
  return answer
    .replace(/\r\n?/g, '\n')
    .replace(/^\s*(?:`{3,}|~{3,}).*$/gm, '')
    .replace(/!?\[([^\]]+)\]\([^\n]*?\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?)/gm, '')
    .replace(/^\s*(?:[-+*•]\s+|\d+[.)]\s+)/gm, '')
    .replace(/\*|`|~~|__/g, '')
    .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1$2')
    .replace(/^\s*(?:-{3,}|_{3,})\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const unknownReasons: Record<string, string> = {
  missing_evidence: 'We don’t yet have sufficient verified gender-pay evidence for the business associated with this brand.',
  no_verified_commerce_entity: 'We haven’t yet verified which UK business to assess for this brand.',
  ambiguous_legal_entity: 'More than one UK business is linked to this brand. We need to clarify which one to assess.',
  ambiguous_evidence: 'The latest reporting period has more than one verified record. We need to clarify the evidence before assessing it.',
  brand_not_found: 'We don’t yet have a verified match for this brand.', ambiguous_brand: 'This name matches more than one brand. We need to confirm which one you mean.',
  unsupported_rule: 'The selected policy contains a rule that this version of Values Engine cannot evaluate.',
  invalid_rule: 'The selected policy does not have a complete, supported rule.', inactive_policy: 'The selected policy is inactive.',
};

/** Presentation only: the status comes from MCP, never from the answer or a comparison. */
export function renderResult(decision: DecisionView, answer: string) {
  const unknown = decision.decision === 'UNKNOWN';
  const title = unknown ? 'NOT ENOUGH VERIFIED DATA' : decision.decision;
  const subtitle = unknown ? 'We don’t have enough verified data to assess this brand yet.' : decision.decision === 'PASS'
    ? `${decision.subject.brand} fits your purchasing policy.` : `${decision.subject.brand} does not fit your purchasing policy.`;
  const symbol = unknown ? '?' : decision.decision === 'PASS' ? '✓' : '×';
  const source = safeSourceUrl(decision.evidence.source_url);
  const fields: [string, string | number | null][] = [
    ['Brand', decision.subject.brand], ['Verified UK commerce entity', decision.entity.legal_name],
    ['Policy criterion', decision.rule.criterion === 'uk_median_gender_pay_gap' ? 'UK median gender pay gap' : decision.rule.criterion],
    ['Your rule', decision.rule.threshold === null ? null : `${decision.rule.operator === '<=' ? '≤' : decision.rule.operator ?? ''} ${decision.rule.threshold}%`],
    ['Reported value', decision.evidence.observed_value === null ? null : `${decision.evidence.observed_value}${decision.evidence.unit === 'percent' ? '%' : ''}`],
    ['Reporting period', decision.evidence.reporting_period], ['Evidence source', decision.evidence.source_name],
  ];
  return `<article class="result ${decision.decision.toLowerCase()}" data-decision="${decision.decision}">
    <header class="result-head"><span class="status-symbol" aria-hidden="true">${symbol}</span><div><p class="eyebrow">${title}</p><h2>${escapeHtml(subtitle)}</h2></div></header>
    ${unknown ? `<p class="unknown-copy">${escapeHtml(unknownReasons[decision.reason] ?? 'We’ll assess this brand when enough verified information is available.')}</p><p class="no-guess">No guess made.</p>` : ''}
    <div class="evidence"><div class="section-label">${unknown ? 'What we know' : 'Behind this decision'}</div><dl>${fields.map(([label, value]) => `<div><dt>${label}</dt><dd>${show(value)}</dd></div>`).join('')}</dl>
    ${source ? `<a class="source-link" href="${escapeHtml(source)}" target="_blank" rel="noopener noreferrer">Read the source <span aria-hidden="true">↗</span></a>` : ''}</div>
    <details><summary>What exactly was evaluated?</summary><p>${escapeHtml(decision.scope)}</p></details>
    <section class="assistant"><p class="section-label">What your shopping assistant says</p><p>${escapeHtml(assistantPlainText(answer))}</p></section>
  </article>`;
}
