import { PDFParse } from 'pdf-parse';

const maximumPages = 80;
const maximumTextChars = 250_000;

type PdfTextChildInput = {
  bytes: Uint8Array;
  maxPages: number;
  maxTextChars: number;
};

type PdfTextChildResult =
  | {
      ok: true;
      text: string;
      totalPages: number;
      parsedPages: number;
      truncated: boolean;
    }
  | {
      ok: false;
      error: 'parse_failed';
    };

function boundedPositiveInteger(value: unknown, maximum: number) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(1, Math.trunc(value)))
    : maximum;
}

async function parsePdf(input: PdfTextChildInput): Promise<PdfTextChildResult> {
  const maxPages = boundedPositiveInteger(input.maxPages, maximumPages);
  const maxTextChars = boundedPositiveInteger(input.maxTextChars, maximumTextChars);
  if (!(input.bytes instanceof Uint8Array)) return { ok: false, error: 'parse_failed' };

  let parser: PDFParse | undefined;
  try {
    parser = new PDFParse({
      data: input.bytes,
      isEvalSupported: false,
      useSystemFonts: false,
      stopAtErrors: true
    });
    const parsed = await parser.getText({
      first: maxPages,
      pageJoiner: '\n-- page_number of total_number --\n'
    });
    const text = parsed.text.slice(0, maxTextChars);
    return {
      ok: true,
      text,
      totalPages: parsed.total,
      parsedPages: parsed.pages.length,
      truncated: parsed.total > parsed.pages.length || parsed.text.length > maxTextChars
    };
  } catch {
    return { ok: false, error: 'parse_failed' };
  } finally {
    await parser?.destroy().catch(() => undefined);
  }
}

process.once('message', (message: PdfTextChildInput) => {
  void (async () => {
    const result = await parsePdf(message);
    if (!process.send) return;
    process.send(result, () => process.disconnect());
  })();
});
