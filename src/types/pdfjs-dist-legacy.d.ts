declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export function getDocument(options: {
    data: Uint8Array;
    disableFontFace?: boolean;
    isEvalSupported?: boolean;
    useWorkerFetch?: boolean;
  }): {
    promise: Promise<{
      numPages: number;
      getPage(pageNumber: number): Promise<{
        getTextContent(): Promise<{
          items: Array<{ str?: string }>;
        }>;
      }>;
      destroy?: () => Promise<void> | void;
    }>;
  };
}
