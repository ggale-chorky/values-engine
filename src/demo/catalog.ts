export const DEMO_POLICY_NAME = 'Demo UK Gender Pay Policy';
export const DEMO_RULE = { criterion: 'uk_median_gender_pay_gap', operator: '<=', threshold_numeric: 10,
  threshold_text: null, action: 'REQUIRE', unknown_handling: 'UNKNOWN' } as const;

// First-party source pages inspected 2026-10-05. These support UK operation,
// not ultimate ownership. Product names below are demonstration records only.
export const DEMO_CATALOG = [
  { brand: 'Charlotte Tilbury', company_number: '08037372', product: 'Charlotte Tilbury Magic Cream',
    source_name: 'Charlotte Tilbury UK Terms & Conditions',
    source_url: 'https://www.charlottetilbury.com/uk/help/terms-and-conditions' },
  { brand: 'Estée Lauder', company_number: '00659213', product: 'Estée Lauder Advanced Night Repair',
    source_name: 'Estée Lauder UK Loyalty Terms & Conditions',
    source_url: 'https://www.esteelauder.co.uk/terms-conditions-loyalty' },
  { brand: 'Vichy', company_number: '00271555', product: 'Vichy Minéral 89',
    source_name: 'Vichy UK Terms of Use', source_url: 'https://www.vichy.co.uk/terms-of-use' },
] as const;
