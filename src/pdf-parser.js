const path = require('path');
const fs = require('fs');
const { getKordoc } = require('./kordoc-loader');
const { localOcrHook, localVisionAnalyze } = require('./ocr-vision');
const { writeDebugLog } = require('./globals');

const projectRoot = path.resolve(__dirname, '..');

function toArrayBuffer(buf) {
    const ab = new ArrayBuffer(buf.length);
    const view = new Uint8Array(ab);
    for (let i = 0; i < buf.length; ++i) view[i] = buf[i];
    return ab;
}

function parsePageRange(rangeStr, maxPages) {
    const pages = new Set();
    const parts = String(rangeStr).split(',');
    for (const part of parts) {
        if (part.includes('-')) {
            const [startStr, endStr] = part.split('-');
            const start = parseInt(startStr, 10);
            const end = parseInt(endStr, 10);
            const s = Math.max(1, isNaN(start) ? 1 : start);
            const e = Math.min(maxPages, isNaN(end) ? maxPages : end);
            for (let i = s; i <= e; i++) pages.add(i);
        } else {
            const p = parseInt(part, 10);
            if (!isNaN(p) && p >= 1 && p <= maxPages) pages.add(p);
        }
    }
    return pages;
}

async function parsePdfHybrid(safePath, fileBuf, pageRangeStr = null) {
    const kd = await getKordoc();
    const isVisionActive = process.env.IS_VISION_MODEL && String(process.env.IS_VISION_MODEL).trim() === '1';

    console.log(`[parsePdfHybrid] 📄 Pass 1 (텍스트 레이어 추출) 시도...`);
    const arrayBuf = toArrayBuffer(fileBuf);
    const pass1Result = await kd.parse(arrayBuf);

    let totalChars = 0;
    let pageTexts = {};
    let pageCount = pass1Result.pageCount || (pass1Result.metadata && pass1Result.metadata.pageCount) || 1;

    if (pass1Result.success) {
        if (pass1Result.pages && pass1Result.pages.length > 0) {
            pageCount = pass1Result.pages.length;
            for (let i = 0; i < pass1Result.pages.length; i++) {
                const pageNum = i + 1;
                const page = pass1Result.pages[i];
                const pageText = page.markdown || page.text || "";
                pageTexts[pageNum] = pageText;
                totalChars += pageText.replace(/\s/g, "").length;
            }
        } else if (pass1Result.blocks && pass1Result.blocks.length > 0) {
            const blocksByPage = {};
            pass1Result.blocks.forEach(b => {
                const pageNum = b.pageNumber || (b.bbox && b.bbox.page) || 1;
                if (!blocksByPage[pageNum]) blocksByPage[pageNum] = [];
                blocksByPage[pageNum].push(b);
            });
            const pageKeys = Object.keys(blocksByPage).map(Number).sort((a, b) => a - b);
            if (pageKeys.length > 0) {
                pageCount = Math.max(...pageKeys);
                for (const pageNum of pageKeys) {
                    let pageText = '';
                    try {
                        pageText = kd.blocksToMarkdown(blocksByPage[pageNum]);
                    } catch (e) {
                        pageText = blocksByPage[pageNum].map(b => b.text || '').join('\n');
                    }
                    pageTexts[pageNum] = pageText;
                    totalChars += pageText.replace(/\s/g, "").length;
                }
            }
        }
    }

    const isImageBased = !pass1Result.success || (totalChars / Math.max(pageCount, 1) < 10);
    console.log(`[parsePdfHybrid] 분석 완료 -> 디지털 본문 문자수: ${totalChars}, 이미지 기반 판정: ${isImageBased}`);

    let targetPages = [];
    if (pageRangeStr) {
        const pagesSet = parsePageRange(pageRangeStr, pageCount);
        targetPages = Array.from(pagesSet).sort((a, b) => a - b);
    } else {
        for (let i = 1; i <= pageCount; i++) targetPages.push(i);
    }

    let structuredLines = [];

    if (!isImageBased) {
        console.log(`[parsePdfHybrid] ⚡ 디지털 PDF 판정: 텍스트 레이어를 사용하며 시각 분석 명세를 융합합니다.`);
        let doc = null;
        if (isVisionActive) {
            try {
                const pdfjsPath = 'file:///' + path.resolve(projectRoot, 'node_modules', 'pdfjs-dist', 'legacy/build/pdf.mjs').replace(/\\/g, '/');
                const pdfjs = await import(pdfjsPath);
                const loadingTask = pdfjs.getDocument({
                    data: new Uint8Array(fileBuf),
                    useSystemFonts: true,
                    disableFontFace: true,
                    isEvalSupported: false,
                    disableWorker: true
                });
                doc = await loadingTask.promise;
            } catch (loadErr) {
                console.warn(`[parsePdfHybrid] pdfjs 로드 실패, 시각 분석을 건너뜁니다: ${loadErr.message}`);
            }
        }

        try {
            for (const pageNum of targetPages) {
                let pageMarkdown = `\n\n---\n## 📄 제 ${pageNum} 페이지\n\n`;
                const textContent = pageTexts[pageNum] || "";
                if (textContent.trim()) {
                    pageMarkdown += textContent.trim() + "\n\n";
                }

                if (isVisionActive && doc) {
                    try {
                        writeDebugLog(`[parsePdfHybrid] Rendering page ${pageNum}/${pageCount} for vision-only analysis`);
                        const page = await doc.getPage(pageNum);
                        const scale = 2;
                        const viewport = page.getViewport({ scale });
                        const canvas = require('canvas').createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
                        const ctx = canvas.getContext("2d");

                        ctx.fillStyle = '#ffffff';
                        ctx.fillRect(0, 0, canvas.width, canvas.height);

                        await page.render({ canvasContext: ctx, viewport }).promise;
                        const pngBuf = canvas.toBuffer("image/png");

                        writeDebugLog(`[parsePdfHybrid] Running vision-only analyzer on page ${pageNum}`);
                        const visionDesc = await localVisionAnalyze(pngBuf, `p${pageNum}`);
                        if (visionDesc && !visionDesc.includes("No visual elements") && visionDesc.trim().length > 5) {
                            pageMarkdown += `> 📷 **[시각 자료 및 그래픽 분석 명세]**\n> ${visionDesc.trim().replace(/\n/g, '\n> ')}\n\n`;
                        }
                    } catch (visionErr) {
                        writeDebugLog(`[parsePdfHybrid] Page ${pageNum} vision analysis skipped/failed: ${visionErr.message}`);
                    }
                }
                structuredLines.push(pageMarkdown);
            }
        } finally {
            if (doc) {
                try {
                    await doc.destroy();
                } catch (destroyErr) {
                    writeDebugLog(`[parsePdfHybrid] doc.destroy 실패 (디지털): ${destroyErr.message}`);
                }
            }
        }
    } else {
        console.log(`[parsePdfHybrid] 🖼️ 이미지 기반/스캔 PDF 판정: 강제 전체 OCR 및 비전 파이프라인 가동...`);
        const pdfjsPath = 'file:///' + path.resolve(projectRoot, 'node_modules', 'pdfjs-dist', 'legacy/build/pdf.mjs').replace(/\\/g, '/');
        const pdfjs = await import(pdfjsPath);
        const loadingTask = pdfjs.getDocument({
            data: new Uint8Array(fileBuf),
            useSystemFonts: true,
            disableFontFace: true,
            isEvalSupported: false,
            disableWorker: true
        });
        const doc = await loadingTask.promise;

        try {
            const realPageCount = doc.numPages;
            if (realPageCount > pageCount) {
                console.log(`[parsePdfHybrid] 📃 실제 페이지 수 재조정: kordoc 추정치 ${pageCount} → pdfjs 확인값 ${realPageCount}`);
                pageCount = realPageCount;
                if (pageRangeStr) {
                    const pagesSet = parsePageRange(pageRangeStr, pageCount);
                    targetPages = Array.from(pagesSet).sort((a, b) => a - b);
                } else {
                    targetPages = [];
                    for (let i = 1; i <= pageCount; i++) targetPages.push(i);
                }
            }

            for (const pageNum of targetPages) {
                writeDebugLog(`[parsePdfHybrid] Rendering & OCR for page ${pageNum}/${pageCount}`);
                const page = await doc.getPage(pageNum);
                const scale = 2;
                const viewport = page.getViewport({ scale });
                const canvas = require('canvas').createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
                const ctx = canvas.getContext("2d");

                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);

                await page.render({ canvasContext: ctx, viewport }).promise;
                const pngBuf = canvas.toBuffer("image/png");

                const pageMarkdown = await localOcrHook(pngBuf, pageNum, "image/png");
                structuredLines.push(pageMarkdown);
            }
        } finally {
            if (doc) {
                try {
                    await doc.destroy();
                } catch (destroyErr) {
                    writeDebugLog(`[parsePdfHybrid] doc.destroy 실패 (스캔): ${destroyErr.message}`);
                }
            }
        }
    }

    const finalMarkdown = structuredLines.join("\n");
    return {
        success: true,
        fileType: "pdf",
        pageCount: pageCount,
        metadata: { title: path.basename(safePath), pageCount: pageCount },
        isImageBased: isImageBased,
        markdown: finalMarkdown,
        warnings: []
    };
}

module.exports = {
    toArrayBuffer,
    parsePageRange,
    parsePdfHybrid
};
