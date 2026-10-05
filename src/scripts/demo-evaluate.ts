import { evaluateProduct } from '../evaluation/evaluate-product.js';
import { createDemoFixtures } from '../evaluation/fixtures/gender-pay-demo.js';

for (const fixture of createDemoFixtures()) {
  const evaluation = evaluateProduct(fixture.input);
  const detail = evaluation.result === 'UNKNOWN'
    ? evaluation.reason
    : `${evaluation.observed_value} ${evaluation.result === 'PASS' ? '<=' : '>'} ${evaluation.threshold}`;
  console.log(`${fixture.name} -> ${evaluation.result} (${detail})`);
}
