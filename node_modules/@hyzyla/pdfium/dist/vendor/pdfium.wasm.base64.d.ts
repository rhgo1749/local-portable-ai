/**
 * Here, is the place where the base64-encoded PDFium WebAssembly binary will be injected by rollup as a constant string.
 *
 * Later, in the `PDFiumLibraryBase64` class, we will dynamically import this constant to initialize the PDFium library.
 * With this approach, the user doesn't need to provide the path to the WASM file. Everything is handled automatically
 * by the package, and any bundler that supports dynamic imports will treat this file as a separate chunk.
 */
export declare const PDFIUM_WASM_BASE64: string;
