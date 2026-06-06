/**
 * Export everything from index.ts, but override the PDFiumLibrary class with a new one that uses a
 * wasm binary from a CDN
 */
export * from "./index.js";
import { PDFiumLibrary as _PDFiumLibrary } from "./library.js";
import PDFiumModule from "./vendor/pdfium.esm.js";
export declare class PDFiumLibrary extends _PDFiumLibrary {
    static _cache: ArrayBuffer | null;
    static init(options?: {
        disableCDNWarning?: boolean;
    }): Promise<_PDFiumLibrary>;
}
export { PDFiumModule };
