import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertCatalogCsvInput, importCatalogCsv } from '../src/catalog/csvImport.js';

vi.mock('../src/ai/openaiClient.js', () => ({
  createEmbedding: vi.fn(async () => null)
}));

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'chatai-csv-'));
  temporaryRoots.push(parent);
  const allowedRoot = path.join(parent, 'imports');
  await fs.mkdir(allowedRoot);
  return { parent, allowedRoot };
}

describe('catalog CSV input boundary', () => {
  it('accepts only regular CSV files inside the configured import root', async () => {
    const { allowedRoot } = await fixture();
    const filePath = path.join(allowedRoot, 'catalog.csv');
    await fs.writeFile(filePath, 'name,price\nGenerator,100\n', 'utf8');

    await expect(assertCatalogCsvInput(filePath, { allowedRoot })).resolves.toBe(await fs.realpath(filePath));
  });

  it('rejects traversal/outside files and non-CSV extensions', async () => {
    const { parent, allowedRoot } = await fixture();
    const outside = path.join(parent, 'outside.csv');
    const wrongExtension = path.join(allowedRoot, 'catalog.txt');
    await fs.writeFile(outside, 'name\nOutside\n', 'utf8');
    await fs.writeFile(wrongExtension, 'name\nWrong\n', 'utf8');

    await expect(assertCatalogCsvInput(outside, { allowedRoot })).rejects.toThrow('catalog_csv_outside_import_root');
    await expect(assertCatalogCsvInput(wrongExtension, { allowedRoot })).rejects.toThrow('catalog_csv_extension_required');
  });

  it('fails a CSV import when an in-loop heartbeat update fails', async () => {
    const { allowedRoot } = await fixture();
    const filePath = path.join(allowedRoot, 'catalog.csv');
    await fs.writeFile(filePath, 'name,price\nGenerator,100\n', 'utf8');
    let currentTime = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
    const heartbeatError = new Error('CSV heartbeat failed');
    const finishCatalogSource = vi.fn(async () => undefined);
    const repository = {
      startCatalogSource: vi.fn(async () => 'csv-heartbeat-run'),
      heartbeatCatalogSource: vi.fn(async () => {
        throw heartbeatError;
      }),
      finishCatalogSource,
      upsertProduct: vi.fn(async () => {
        currentTime = 20_000;
      })
    };

    try {
      await expect(importCatalogCsv(filePath, repository as never, {
        allowedRoot
      })).rejects.toBe(heartbeatError);
    } finally {
      nowSpy.mockRestore();
    }

    expect(repository.heartbeatCatalogSource).toHaveBeenCalledOnce();
    expect(finishCatalogSource).toHaveBeenCalledWith(
      'csv-heartbeat-run',
      'failed',
      expect.objectContaining({ imported: 1, coverageComplete: false }),
      expect.stringContaining('CSV heartbeat failed'),
      expect.objectContaining({ coverageComplete: false, failedItemCount: 1 })
    );
  });
});
