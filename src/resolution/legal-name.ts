/** Formatting equivalence only; no fuzzy/brand-name-based identity inference. */
export function normaliseLegalName(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase()
    .replace(/\bLTD\b/g, 'LIMITED').replace(/&/g, 'AND').replace(/[^A-Z0-9]/g, '');
}

