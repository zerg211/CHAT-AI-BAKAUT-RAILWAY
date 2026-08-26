import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('electric-start reconciliation migration', () => {
  it('repairs only the three catalog-backed contradictions and invalidates their embeddings', async () => {
    const sql = await fs.readFile(
      path.join(process.cwd(), 'sql', '024_reconcile_electric_start_sources.sql'),
      'utf8'
    );

    expect(sql).toContain("specs - 'электростартер'");
    expect(sql).toContain("product_key = 'g3500i'");
    expect(sql).toContain("product_key = 'g4000is'");
    expect(sql).toContain("product_key = 'et5500is'");
    expect(sql).toContain("status = 'superseded'");
    expect(sql).toContain('embedding = NULL');
    expect(sql).toContain('source_content_hash = encode(');
    expect(sql).toContain('catalog_source_hash = product.source_content_hash');
    expect(sql).not.toContain('DELETE FROM verified_product_facts');
  });

  it('removes the stale starter text left in the catalog cards', async () => {
    const sql = await fs.readFile(
      path.join(process.cwd(), 'sql', '025_reconcile_electric_start_catalog_values.sql'),
      'utf8'
    );

    expect(sql).toContain("jsonb_build_object('стартер', 'ручной стартер')");
    expect(sql).toContain("value = 'ручной и электростартер'");
    expect(sql).toContain("value = 'ручной стартер'");
    expect(sql).toContain('embedding = NULL');
    expect(sql).toContain('source_content_hash = encode(');
    expect(sql).toContain('catalog_source_hash = product.source_content_hash');
  });
});
