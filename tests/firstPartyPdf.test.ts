import { expect, it } from 'vitest';
import { readFirstPartyPage } from '../src/ai/siteFirstParty.js';

function fixturePdf() {
  const stream = 'BT /F1 12 Tf 50 700 Td (Workshop hours Saturday 10-16) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n` + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

it('reads a real PDF through the production child parser and preserves source provenance', async () => {
  const url = 'https://bakautprof.ru/documents/hours.pdf?branch=2';
  const controller = new AbortController();
  const result = await readFirstPartyPage(url, {
    baseUrl: 'https://bakautprof.ru', signal: controller.signal,
    fetchBytes: async (target, options) => {
      expect(options.signal).toBe(controller.signal);
      return { url: target, status: 200, headers: new Headers({ 'content-type': 'application/pdf' }), bytes: fixturePdf() };
    }
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.page.text).toContain('Workshop hours Saturday 10-16');
  expect(result.page).toMatchObject({ canonicalUrl: url, format: 'pdf', sourceTruncated: false, readRange: { complete: true } });
});
