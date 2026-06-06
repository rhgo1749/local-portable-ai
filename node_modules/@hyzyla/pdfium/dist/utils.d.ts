import type { PDFiumRenderFunction, PDFiumRenderOptions } from "./types.js";
export declare function convertBitmapToImage(options: {
    render: PDFiumRenderFunction;
} & PDFiumRenderOptions): Promise<Uint8Array>;
export declare function readUInt16LE(buffer: Uint8Array, offset?: number): number;
