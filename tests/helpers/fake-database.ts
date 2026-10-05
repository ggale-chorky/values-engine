import { randomUUID } from 'node:crypto';
import type { Filters, Row, SeedTable, Table, WriteDatabase } from '../../src/db/database.js';
import { DEMO_CATALOG } from '../../src/demo/catalog.js';

export class FakeDatabase implements WriteDatabase {
  tables: Record<Table, Row[]> = { products: [], brands: [], brand_entity_relationships: [], legal_entities: [], evidence: [], policies: [], policy_rules: [] };
  writes: { table: SeedTable; kind: 'insert' | 'update'; row: Row }[] = [];
  reads: { table: Table; filters: Filters }[] = [];
  failAfter: number | null = null;
  async read(table: Table, filters: Filters) {
    this.reads.push({ table, filters });
    return structuredClone(this.tables[table].filter(row => Object.entries(filters).every(([key, value]) => row[key] === value)));
  }
  async insert(table: SeedTable, row: Row) {
    if (this.failAfter === this.writes.length) throw new Error('Simulated interruption');
    this.writes.push({ table, kind: 'insert', row: structuredClone(row) });
    this.tables[table].push(structuredClone(row));
  }
  async update(table: SeedTable, id: string, row: Row) {
    this.writes.push({ table, kind: 'update', row: structuredClone(row) });
    const target = this.tables[table].find(item => item.id === id);
    if (!target) throw new Error('Missing fake row');
    Object.assign(target, structuredClone(row));
  }
}

export function importedDatabase() {
  const db = new FakeDatabase();
  DEMO_CATALOG.forEach((item, index) => {
    const id = randomUUID();
    db.tables.legal_entities.push({ id, jurisdiction: 'GB', company_number: item.company_number,
      canonical_name: ['CHARLOTTE TILBURY BEAUTY LIMITED', 'ESTEE LAUDER COSMETICS LIMITED', "L'OREAL (U.K.) LIMITED"][index] });
    db.tables.evidence.push({ id: randomUUID(), legal_entity_id: id, product_id: null, brand_id: null,
      claim_type: 'uk_median_gender_pay_gap', value_numeric: [-0.7, 10, 18.95][index], value_text: null, value_boolean: null,
      unit: 'percent', source_name: 'Local test government-source fixture', source_url: 'https://example.test/report',
      reporting_period: '2025-26', confidence: 1, verification_status: 'auto_verified' });
  });
  return db;
}
