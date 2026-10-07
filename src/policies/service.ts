import type { PolicyCreator } from './creation.js';
import type { ReadDatabase } from '../db/database.js';
import { DataError, parseRows, policyRow, ruleRow } from '../db/rows.js';
import { ruleProblem } from '../evaluation/evaluate-rule.js';
import type { PolicyRule } from '../evaluation/types.js';

export interface SelectedPolicy {
  id: string;
  name: string;
  rule: PolicyRule;
  problem: string | null;
}

export function validatePolicyInput(name: string, threshold: string): { name: string; threshold: number } {
  if (!name.trim()) throw new DataError('Policy name is required.');
  // Decimal percentages only; no coercion of blanks, hex, Infinity or trailing junk.
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(threshold.trim()) || !Number.isFinite(Number(threshold))) {
    throw new DataError('Threshold must be a finite numeric percentage.');
  }
  return { name: name.trim(), threshold: Number(threshold) };
}

/** One atomic database call; never attempt partial repair or automatic retries. */
export async function createPolicy(creator: PolicyCreator, name: string, threshold: string) {
  const input = validatePolicyInput(name, threshold);
  let identifiers;
  try {
    identifiers = await creator.create(input.name, input.threshold);
  } catch {
    throw new DataError('Policy creation RPC failed or its result could not be confirmed. Database errors roll back both rows; a lost response may mean the complete policy was created. No repair or retry was attempted.');
  }
  return { ...identifiers, policy_name: input.name, active: true, criterion: 'uk_median_gender_pay_gap', operator: '<=', threshold: input.threshold, unknown_handling: 'UNKNOWN' };
}

export async function selectPolicy(db: ReadDatabase, selector: string): Promise<SelectedPolicy> {
  const value = selector.trim();
  if (!value) throw new DataError('Policy name or UUID is required.');
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const policies = parseRows(policyRow, await db.read('policies', isUuid ? { id: value.toLowerCase() } : { name: value }), 'policies');
  if (!policies.length) throw new DataError('Policy not found.');
  if (policies.length !== 1) throw new DataError('Ambiguous policy name; select by UUID.');
  const policy = policies[0]!;
  const rows = await db.read('policy_rules', { policy_id: policy.id });
  const parsed = rows.length === 1 ? ruleRow.safeParse(rows[0]) : null;
  const valid = parsed?.success ? parsed.data : null;
  const rule: PolicyRule = valid ?? { criterion: '', operator: '', threshold_numeric: null };
  const problem = !policy.is_active ? 'inactive_policy'
    : !valid || valid.policy_id !== policy.id || valid.threshold_text !== null ? 'invalid_rule' : ruleProblem(rule);
  return { id: policy.id, name: policy.name, rule, problem };
}

/** Read-only listing retains policies with missing rules so incomplete creation is visible. */
export async function listPolicies(db: ReadDatabase) {
  const policies = await db.read('policies', {});
  const rules = await db.read('policy_rules', {});
  const sorted = [...policies].sort((a, b) => compare(String(a.name), String(b.name)) || compare(String(a.id), String(b.id)));
  return sorted.flatMap(policy => {
    const matches = rules.filter(rule => rule.policy_id === policy.id).sort((a, b) => compare(String(a.id), String(b.id)));
    return (matches.length ? matches : [null]).map(rule => ({ policy_id: policy.id, policy_name: policy.name,
      active: policy.is_active, criterion: rule?.criterion ?? null, operator: rule?.operator ?? null,
      threshold: rule?.threshold_numeric ?? rule?.threshold_text ?? null, unknown_handling: rule?.unknown_handling ?? null,
      created_at: policy.created_at ?? null }));
  });
}
function compare(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
