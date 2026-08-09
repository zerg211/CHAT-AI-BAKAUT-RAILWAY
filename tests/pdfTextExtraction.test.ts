import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  extractPdfText,
  PdfTextExtractionError,
  type PdfTextChildFactory,
  type PdfTextChildLaunchOptions,
  type PdfTextChildLike
} from '../src/ai/pdfTextExtraction.js';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  pid = 1234;
  send = vi.fn((_message: unknown, callback?: (error: Error | null) => void) => {
    callback?.(null);
    return true;
  });
  kill = vi.fn((_signal?: NodeJS.Signals | number) => {
    queueMicrotask(() => {
      this.exitCode = 1;
      this.emit('exit', null, 'SIGKILL');
    });
    return true;
  });

  complete(message: unknown) {
    this.emit('message', message);
    queueMicrotask(() => {
      this.exitCode = 0;
      this.emit('exit', 0, null);
    });
  }
}

function factoryReturning(child: FakeChild, capture?: (options: PdfTextChildLaunchOptions) => void) {
  return vi.fn((_modulePath: string, _args: readonly string[], options: PdfTextChildLaunchOptions) => {
    capture?.(options);
    return child as unknown as PdfTextChildLike;
  }) as unknown as PdfTextChildFactory;
}

function successfulMessage(text: string) {
  return {
    ok: true,
    text,
    totalPages: 1,
    parsedPages: 1,
    truncated: false
  };
}

const productionLikePdfChildSource = `
import { PDFParse } from 'pdf-parse';
process.once('message', (input) => {
  void (async () => {
    let parser;
    let result;
    try {
      parser = new PDFParse({
        data: input.bytes,
        isEvalSupported: false,
        useSystemFonts: false,
        stopAtErrors: true
      });
      const parsed = await parser.getText({ first: input.maxPages });
      result = {
        ok: true,
        text: parsed.text.slice(0, input.maxTextChars),
        totalPages: parsed.total,
        parsedPages: parsed.pages.length,
        truncated: parsed.total > parsed.pages.length || parsed.text.length > input.maxTextChars
      };
    } catch {
      result = { ok: false, error: 'parse_failed' };
    } finally {
      await parser?.destroy().catch(() => undefined);
    }
    process.send(result, () => process.disconnect());
  })();
});
`;

const productionLikePdfChildFactory: PdfTextChildFactory = (_modulePath, _args, options) => {
  const resourceArgs: string[] = [];
  for (let index = 0; index < options.execArgv.length; index += 1) {
    if (options.execArgv[index] === '--import') {
      index += 1;
      continue;
    }
    resourceArgs.push(options.execArgv[index]);
  }
  return spawn(process.execPath, [
    ...resourceArgs,
    '--input-type=module',
    '--eval',
    productionLikePdfChildSource
  ], {
    env: options.env,
    serialization: options.serialization,
    stdio: options.stdio,
    windowsHide: options.windowsHide
  }) as unknown as PdfTextChildLike;
};

describe('PDF text extraction child-process isolation', () => {
  it('passes bounded parser inputs and process memory limits', async () => {
    const child = new FakeChild();
    let childOptions: PdfTextChildLaunchOptions | undefined;
    const childFactory = factoryReturning(child, (options) => {
      childOptions = options;
      queueMicrotask(() => child.complete({
        ...successfulMessage('bounded PDF text'),
        totalPages: 100,
        parsedPages: 80,
        truncated: true
      }));
    });

    const result = await extractPdfText(new Uint8Array([1, 2, 3]), {
      maxPages: 800,
      maxTextChars: 2_500_000,
      childFactory
    });

    expect(result).toEqual({
      text: 'bounded PDF text',
      totalPages: 100,
      parsedPages: 80,
      truncated: true
    });
    expect(child.send).toHaveBeenCalledWith(expect.objectContaining({
      maxPages: 80,
      maxTextChars: 250000
    }), expect.any(Function));
    expect(childOptions?.execArgv).toEqual(expect.arrayContaining([
      '--max-old-space-size=256',
      '--max-semi-space-size=32',
      '--stack-size=2048'
    ]));
    expect(childOptions?.serialization).toBe('advanced');
    expect(childOptions?.stdio).toEqual(['ignore', 'ignore', 'ignore', 'ipc']);
    expect(childOptions?.windowsHide).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('hard-kills a child process when parsing times out', async () => {
    const child = new FakeChild();
    const extraction = extractPdfText(new Uint8Array([1]), {
      timeoutMs: 5,
      childFactory: factoryReturning(child)
    });

    await expect(extraction).rejects.toEqual(new PdfTextExtractionError('timed_out'));
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });

  it('hard-kills a child process when the research signal aborts', async () => {
    const child = new FakeChild();
    const controller = new AbortController();
    const childFactory = factoryReturning(child);
    const extraction = extractPdfText(new Uint8Array([1]), {
      signal: controller.signal,
      childFactory
    });

    await vi.waitFor(() => expect(childFactory).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(extraction).rejects.toMatchObject({ name: 'AbortError' });
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });

  it('stops a real CPU-bound process at the hard timeout', async () => {
    let child: ChildProcess | undefined;
    const childFactory = (() => {
      child = spawn(process.execPath, ['-e', 'while (true) {}'], { stdio: 'ignore' });
      Object.defineProperty(child, 'send', {
        value: vi.fn((_message: unknown, callback?: (error: Error | null) => void) => {
          callback?.(null);
          return true;
        })
      });
      vi.spyOn(child, 'kill');
      return child as unknown as PdfTextChildLike;
    }) as PdfTextChildFactory;

    await expect(extractPdfText(new Uint8Array([1]), {
      timeoutMs: 25,
      childFactory
    })).rejects.toEqual(new PdfTextExtractionError('timed_out'));
    expect(child?.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });

  it('runs one child, bounds three waiters, and rejects an unbounded fifth request', async () => {
    const children = [new FakeChild(), new FakeChild(), new FakeChild(), new FakeChild()];
    let createdChildren = 0;
    const childFactory = vi.fn(() =>
      children[createdChildren++] as unknown as PdfTextChildLike
    ) as unknown as PdfTextChildFactory;

    const extractions = [0, 1, 2, 3, 4].map(() =>
      extractPdfText(new Uint8Array([1]), { childFactory })
    );
    await expect(extractions[4]).rejects.toEqual(new PdfTextExtractionError('busy'));
    expect(childFactory).toHaveBeenCalledTimes(1);

    children[0].complete(successfulMessage('first'));
    await vi.waitFor(() => expect(childFactory).toHaveBeenCalledTimes(2));
    children[1].complete(successfulMessage('second'));
    await vi.waitFor(() => expect(childFactory).toHaveBeenCalledTimes(3));
    children[2].complete(successfulMessage('third'));
    await vi.waitFor(() => expect(childFactory).toHaveBeenCalledTimes(4));
    children[3].complete(successfulMessage('fourth'));

    await expect(Promise.all(extractions.slice(0, 4))).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'first' }),
      expect.objectContaining({ text: 'second' }),
      expect.objectContaining({ text: 'third' }),
      expect.objectContaining({ text: 'fourth' })
    ]));
  });

  it('ignores late child messages after a timeout has settled', async () => {
    const child = new FakeChild();
    const extraction = extractPdfText(new Uint8Array([1]), {
      timeoutMs: 5,
      childFactory: factoryReturning(child)
    });

    await expect(extraction).rejects.toEqual(new PdfTextExtractionError('timed_out'));
    child.complete(successfulMessage('too late'));
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('contains malformed PDF parser crashes in the child process', async () => {
    const malformedPdf = new TextEncoder().encode('%PDF-1.7 invalid');
    const error = await extractPdfText(malformedPdf, { timeoutMs: 5_000 }).catch((caught) => caught);
    expect(error).toBeInstanceOf(PdfTextExtractionError);
    expect(['parse_failed', 'child_failed', 'timed_out']).toContain(error.code);
  }, 8_000);

  it('extracts text from a valid PDF in the real isolated child', async () => {
    const validPdf = new Uint8Array(Buffer.from(
      'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0NyA+PgpzdHJlYW0KQlQgL0YxIDE4IFRmIDcyIDcyMCBUZCAoSGVsbG8gQkFLQVVUIFBERikgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzMzggMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MDgKJSVFT0YK',
      'base64'
    ));

    await expect(extractPdfText(validPdf, {
      // This integration check includes cold TypeScript loader and child-process
      // startup while the full Vitest suite is CPU-bound. Keep the production
      // default independently covered by the deterministic timeout tests above.
      timeoutMs: 8_000,
      childFactory: productionLikePdfChildFactory
    })).resolves.toEqual({
      text: expect.stringContaining('Hello BAKAUT PDF'),
      totalPages: 1,
      parsedPages: 1,
      truncated: false
    });
  }, 12_000);
});
