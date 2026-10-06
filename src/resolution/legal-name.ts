/** Formatting equivalence only; no fuzzy/brand-name-based identity inference. */
export function normaliseLegalName(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase()
    .replace(/\bLTD\b/g, 'LIMITED').replace(/&/g, 'AND').replace(/[^A-Z0-9]/g, '');
}


/** Legal-name boundaries also include LLC so adjacent overseas entities stay separate. */
export function legalNamePattern(): RegExp { return /\b[\p{Lu}][\p{L}\p{M}\p{N}'’&().-]*(?:\s+(?:[\p{Lu}(][\p{L}\p{M}\p{N}'’&().-]*|and|of|the|&)){0,18}\s+(?:LIMITED|Limited|LTD|Ltd|PLC|plc|LLP|llp|LLC|Llc|llc)\b/gu; }
