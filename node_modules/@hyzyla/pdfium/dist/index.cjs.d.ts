/**
 * Export everything from index.ts, but add
 */
export * from "./index.js";
import { PDFiumLibrary as _PDFiumLibrary } from "./library.js";
import PDFiumModule from "./vendor/pdfium.js";
export declare class PDFiumLibrary extends _PDFiumLibrary {
    static init(options?: {
        wasmBinary?: ArrayBuffer;
        wasmUrl?: string;
        instantiateWasm?: (imports: WebAssembly.Imports, successCallback: (module: WebAssembly.Module) => void) => WebAssembly.Exports;
    }): Promise<_PDFiumLibrary>;
}
export { PDFiumModule };
