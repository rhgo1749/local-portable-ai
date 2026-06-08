const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createWorker } = require('tesseract.js');

// 🎨 [Node-Canvas 전역 바인딩] pdfjs-dist의 Node 환경 안정성 확보
try {
    const canvas = require('canvas');
    global.Image = canvas.Image;
    global.Canvas = canvas.Canvas;
    global.DOMMatrix = canvas.DOMMatrix;
    global.Path2D = canvas.Path2D;
    global.CanvasPattern = canvas.CanvasPattern;
    global.createCanvas = canvas.createCanvas;
    global.ImageData = canvas.ImageData;
    console.log("[Canvas Bind] Node-Canvas global bindings registered successfully.");
} catch (e) {
    console.warn("[Canvas Bind Warn] Failed to bind canvas globals (PDF OCR rendering might fail):", e.message);
}

// 🎨 [런타임 표준 API 우회 패치] 안정적인 픽셀 버퍼 폴백 유도
const blockGlobals = ['createImageBitmap', 'ImageDecoder', 'OffscreenCanvas'];
blockGlobals.forEach(name => {
    try {
        global[name] = undefined;
        globalThis[name] = undefined;
        if (typeof self !== 'undefined') self[name] = undefined;
    } catch (e) {}
});
console.log("[Canvas Bind] Node-Canvas global API bypass registered for:", blockGlobals.join(', '));

const app = express();

// 📝 [디버그 파일 로거]
const logFile = path.join(__dirname, 'debug_mcp.log');
if (fs.existsSync(logFile)) {
    try { fs.unlinkSync(logFile); } catch (e) {}
}
function writeDebugLog(message) {
    try {
        const timestamp = new Date().toISOString();
        fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`, 'utf-8');
        console.log(`[DEBUG LOG] ${message}`);
    } catch (e) {}
}
writeDebugLog(`MCP Bridge Started. IS_VISION_MODEL: "${process.env.IS_VISION_MODEL}"`);

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, mcp-protocol-version');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

let lastParsedMarkdown = "";

// Dynamic Import Helper for kordoc
let kordoc = null;
async function getKordoc() {
    if (!kordoc) {
        const kordocPath = 'file:///' + path.resolve(__dirname, 'node_modules', 'kordoc', 'dist', 'index.js').replace(/\\/g, '/');
        kordoc = await import(kordocPath);
    }
    return kordoc;
}

// 🔐 [보안 샌드박싱] 접근 허용 경로 정의 및 검증 정규화
const allowedDirs = [
    path.resolve(path.join(__dirname, '작업공간')),
    path.resolve(path.join(process.cwd(), '작업공간'))  
].map(dir => {
    let norm = path.resolve(dir).toLowerCase().replace(/\\/g, '/');
    if (!norm.endsWith('/')) norm += '/';
    return norm;
});

const allowedWriteDirs = [...allowedDirs];

function sanitizeInputPath(rawPath) {
    if (!rawPath || typeof rawPath !== 'string') return rawPath;
    let clean = rawPath;
    clean = clean.replace(/ngo-window/gi, 'go-window');
    clean = clean.replace(/[\n\r\t]+/g, '/');
    clean = clean.replace(/\\n/g, '/').replace(/\\r/g, '/').replace(/\\t/g, '/');
    clean = clean.replace(/\\+/g, '/').replace(/\/+/g, '/');
    clean = clean.replace(/^([a-zA-Z]):\/?/g, '$1:/');
    return clean;
}

function validatePath(targetPath, checkExists = false) {
    if (!targetPath) throw new Error("파일 경로가 제공되지 않았습니다.");
    const cleanPath = sanitizeInputPath(targetPath);
    let resolved = path.resolve(cleanPath);
    
    if (checkExists && !fs.existsSync(resolved)) {
        const baseName = path.basename(resolved);
        if (baseName) {
            console.log(`[validatePath] 파일 없음: "${resolved}". 재귀 검색을 시작합니다...`);
            const foundFiles = findFilesRecursively(path.join(__dirname, '작업공간'), baseName);
            const exactMatches = foundFiles.filter(f => f.name.toLowerCase() === baseName.toLowerCase());
            
            if (exactMatches.length === 1) {
                resolved = path.resolve(__dirname, exactMatches[0].path);
                console.log(`[validatePath] 자동 복구 성공 -> "${resolved}"`);
            } else if (exactMatches.length > 1) {
                throw new Error(`[파일 중복] "${baseName}"이(가) 여러 경로에 존재합니다: ${exactMatches.map(f => f.path).join(", ")}`);
            } else {
                const partialMatches = foundFiles.filter(f => f.name.toLowerCase().includes(baseName.toLowerCase()));
                if (partialMatches.length === 1) {
                    resolved = path.resolve(__dirname, partialMatches[0].path);
                    console.log(`[validatePath] 부분 일치 자동 복구 성공 -> "${resolved}"`);
                } else if (partialMatches.length > 1) {
                    throw new Error(`[파일 모호함] 유사한 파일 목록: ${partialMatches.slice(0, 5).map(f => f.path).join(", ")}`);
                }
            }
        }
    }

    const normTarget = resolved.toLowerCase().replace(/\\/g, '/');
    const isAllowed = allowedDirs.some(allowedDir => {
        const normAllowed = allowedDir.endsWith('/') ? allowedDir : allowedDir + '/';
        const normTargetWithSlash = normTarget.endsWith('/') ? normTarget : normTarget + '/';
        return normTargetWithSlash.startsWith(normAllowed);
    });
    
    if (!isAllowed) {
        throw new Error(`[보안 제한] 경로 "${resolved}"는 허용된 디렉토리 영역 외부에 위치하므로 접근이 차단되었습니다.`);
    }
    if (checkExists && !fs.existsSync(resolved)) {
        throw new Error(`[파일 없음] 존재하지 않는 경로입니다: "${resolved}"`);
    }

    return resolved;
}

function validateWritePath(targetPath) {
    if (!targetPath) throw new Error("파일 저장 경로가 제공되지 않았습니다.");
    const cleanPath = sanitizeInputPath(targetPath);
    const resolved = path.resolve(cleanPath);
    const normTarget = resolved.toLowerCase().replace(/\\/g, '/');
    
    const isAllowed = allowedWriteDirs.some(allowedDir => {
        const normAllowed = allowedDir.endsWith('/') ? allowedDir : allowedDir + '/';
        const normTargetWithSlash = normTarget.endsWith('/') ? normTarget : normTarget + '/';
        return normTargetWithSlash.startsWith(normAllowed);
    });
    
    if (!isAllowed) {
        throw new Error(`[보안 제한] 파일 생성 및 쓰기는 지정된 허용 폴더 내부만 허용됩니다: "${resolved}"`);
    }
    return resolved;
}

// 🧠 [로컬 캐시 시스템]
const CACHE_DIR = path.join(__dirname, '.mcp_cache');
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function getCacheKey(safePath, additionalParams = '') {
    try {
        const stat = fs.statSync(safePath);
        const isVision = (process.env.IS_VISION_MODEL && String(process.env.IS_VISION_MODEL).trim() === '1') ? 'vision' : 'text';
        const bridgeStat = fs.statSync(__filename);
        const uniqueString = `${safePath}_${stat.size}_${stat.mtime.getTime()}_${isVision}_${bridgeStat.mtime.getTime()}_${additionalParams}`;
        return crypto.createHash('md5').update(uniqueString).digest('hex');
    } catch (e) {
        const isVision = (process.env.IS_VISION_MODEL && String(process.env.IS_VISION_MODEL).trim() === '1') ? 'vision' : 'text';
        return crypto.createHash('md5').update(`${safePath}_${Date.now()}_${isVision}_${additionalParams}`).digest('hex');
    }
}

function getCachedResult(cacheKey) {
    const cachePath = path.join(CACHE_DIR, `${cacheKey}.json`);
    if (fs.existsSync(cachePath)) {
        try {
            return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        } catch (e) {
            console.error(`[Cache Error] Failed to read cache: ${e.message}`);
        }
    }
    return null;
}

function saveCacheResult(cacheKey, result) {
    const cachePath = path.join(CACHE_DIR, `${cacheKey}.json`);
    try {
        fs.writeFileSync(cachePath, JSON.stringify(result, null, 2), 'utf-8');
    } catch (e) {
        console.error(`[Cache Error] Failed to write cache: ${e.message}`);
    }
}

// 🖼️ [로컬 이미지 및 OCR 구동 엔진]
let globalOcrWorker = null;
let tesseractQueue = Promise.resolve();
let visionQueue = Promise.resolve();
const VISION_PAGE_TIMEOUT_MS = 1200 * 1000;

async function asyncPool(poolLimit, array, iteratorFn) {
    const ret = [];
    const executing = new Set();
    for (const item of array) {
        const p = Promise.resolve().then(() => iteratorFn(item));
        ret.push(p);
        executing.add(p);
        const clean = () => executing.delete(p);
        p.then(clean, clean);
        if (executing.size >= poolLimit) {
            await Promise.race(executing);
        }
    }
    return Promise.all(ret);
}

// 🖼️ [문서 가독성 보존형 이미지 전처리]
async function preprocessVisionImage(imageBuffer, maxDim = 2048) {
    const canvas = require('canvas');
    return new Promise((resolve, reject) => {
        const img = new canvas.Image();
        img.onload = () => {
            let width = img.width;
            let height = img.height;

            if (width > maxDim || height > maxDim) {
                if (width > height) {
                    height = Math.round(height * (maxDim / width));
                    width = maxDim;
                } else {
                    width = Math.round(width * (maxDim / height));
                    height = maxDim;
                }
            }

            const cvs = canvas.createCanvas(width, height);
            const ctx = cvs.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            resolve(cvs.toBuffer('image/jpeg', { quality: 0.85 }));
        };
        img.onerror = (err) => reject(new Error("이미지 전처리 로딩 실패: " + err.message));
        img.src = imageBuffer;
    });
}

// 🚀 [지능형 하이브리드 라우팅 및 수직 슬라이싱 통합 OCR 훅]
async function localOcrHook(pageImage, pageNumber, mimeType) {
    const imageBuffer = Buffer.from(pageImage);
    const cleanPageNum = String(pageNumber).replace(/[^0-9]/g, "") || pageNumber;
    writeDebugLog(`localOcrHook 가동 - Page/ID: ${pageNumber}`);

    const canvas = require('canvas');
    const img = new canvas.Image();
    try {
        img.src = imageBuffer;
        if (img.height > img.width * 3) {
            const width = img.width;
            const height = img.height;
            const sliceHeight = Math.min(width * 2, 2048);
            const totalSlices = Math.ceil(height / sliceHeight);
            let bannerMarkdown = `\n\n---\n## 📄 제 ${cleanPageNum} 페이지 (통짜 롱배너 서식 문서)\n> ⚠️ 본 페이지는 세로형 배너 이미지로 판정되어 총 ${totalSlices}개 구역으로 분할 전처리 및 순차 결합 분석을 수행했습니다.`;

            for (let i = 0; i < totalSlices; i++) {
                const currentY = i * sliceHeight;
                const currentHeight = Math.min(sliceHeight, height - currentY);
                const cvs = canvas.createCanvas(width, currentHeight);
                const ctx = cvs.getContext('2d');
                ctx.drawImage(img, 0, currentY, width, currentHeight, 0, 0, width, currentHeight);
                
                const sliceBuffer = cvs.toBuffer('image/jpeg', { quality: 0.85 });
                const sliceResult = await processSingleImageBuffer(sliceBuffer, `p${cleanPageNum}-구역${i + 1}`, cleanPageNum, true);
                bannerMarkdown += sliceResult;
            }
            return bannerMarkdown;
        }
    } catch (e) {
        writeDebugLog(`[배너 검사 패스/예외] ${e.message}`);
    }

    return await processSingleImageBuffer(imageBuffer, `p${cleanPageNum}`, cleanPageNum, false);
}

async function processSingleImageBuffer(imageBuffer, identity, pageNum, isSlice = false) {
    const ocrText = await new Promise((resolve) => {
        tesseractQueue = tesseractQueue.then(async () => {
            try {
                if (!globalOcrWorker) {
                    globalOcrWorker = await createWorker('kor+eng', 1, {
                        langPath: path.resolve(path.join(__dirname, 'tessdata')),
                        cachePath: path.resolve(path.join(__dirname, 'tessdata')),
                    });
                }
                const { data: { text } } = await globalOcrWorker.recognize(imageBuffer);
                resolve(text);
            } catch (err) {
                resolve("");
            }
        });
    });

    let visionDesc = "";
    if (process.env.IS_VISION_MODEL && String(process.env.IS_VISION_MODEL).trim() === '1') {
        try {
            writeDebugLog(`[듀얼 추론 가동] ${identity}: 시각 요소 유실 방지용 영문 구조화 비전 추론 호출.`);
            const visionText = await new Promise((resolve, reject) => {
                visionQueue = visionQueue.then(async () => {
                    try {
                        const res = await localVisionAnalyze(imageBuffer, identity);
                        resolve(res);
                    } catch (err) {
                        reject(err);
                    }
                });
            });
            if (visionText && !visionText.includes("No visual elements") && visionText.trim().length > 5) {
                visionDesc = visionText.trim();
            }
        } catch (visionErr) {
            writeDebugLog(`[듀얼 추론 예외 가드] 비전 분석 실패: ${visionErr.message}`);
        }
    }

    let resultMarkdown = "";
    if (!isSlice) {
        resultMarkdown += `\n\n---\n## 📄 제 ${pageNum} 페이지\n\n`;
    }
    if (ocrText && ocrText.trim()) {
        resultMarkdown += `${ocrText.trim()}\n\n`;
    }
    if (visionDesc) {
        resultMarkdown += `> 📷 **[시각 자료 및 그래픽 분석 명세]**\n> ${visionDesc.replace(/\n/g, '\n> ')}\n\n`;
    }
    return resultMarkdown;
}

async function localVisionAnalyze(imageBuffer, identity) {
    return new Promise(async (resolve, reject) => {
        let pageTimer = null;
        let settled = false;
        
        const safeResolve = (val) => { if (!settled) { settled = true; clearTimeout(pageTimer); resolve(val); } };
        const safeReject = (err) => { if (!settled) { settled = true; clearTimeout(pageTimer); reject(err); } };

        pageTimer = setTimeout(() => {
            if (!settled) {
                writeDebugLog(`[localVisionAnalyze] ⏱️ ${identity} 비전 타임아웃.`);
                const timeoutErr = new Error(`Vision timed out on ${identity}`);
                timeoutErr.code = 'VISION_TIMEOUT';
                safeReject(timeoutErr);
            }
        }, VISION_PAGE_TIMEOUT_MS);
        
        try {
            const optimizedBuffer = await preprocessVisionImage(imageBuffer, 2048);
            const base64 = optimizedBuffer.toString('base64');
            const postData = JSON.stringify({
                messages: [{
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: `You are a professional visual analysis assistant. Your sole task is to identify and describe any embedded visual elements (such as photos, illustrations, drawings, images, charts, diagrams, or major graphical icons) present in the image.

CRITICAL DIRECTIVES:
1. Do NOT attempt to transcribe or copy long blocks of body text. Tesseract has already handled the text extraction task.
2. Focus deeply on describing the visual content: identify subjects (e.g., specific animals like a dog, characters, objects), actions, expressions, textures, colors, composition, and the overall mood of the graphics.
3. Fix potential text distortions contextually based on popular media/subculture naming conventions (e.g., ensure logotypes are accurately recognized as '이브이' instead of literal misreadings like '이보이').
4. If the image is a plain document or form consisting entirely of text with NO photos, illustrations, or significant visual elements, reply EXACTLY with this phrase and nothing else: "No visual elements."
5. Output the final response strictly in Korean. Do not include any conversational intro/outro.`
                        },
                        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } }
                    ]
                }],
                stream: false,
                temperature: 0.2,
                max_tokens: 4096, 
                n_predict: 4096
            });
            
            const reqOpts = {
                hostname: '127.0.0.1',
                port: 8081,
                path: '/v1/chat/completions',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };
            
            const req = http.request(reqOpts, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(body);
                        const contentText = parsed.choices?.[0]?.message?.content;
                        if (contentText) {
                            const lowerText = contentText.toLowerCase();
                            const failPatterns = ["이미지 내용이", "no image", "이미지가 제공", "cannot see", "볼 수 없습니다", "첨부되지", "업로드"];
                            if (failPatterns.some(p => lowerText.includes(p)) || contentText.trim().length < 5) {
                                safeReject(new Error("Vision backend failed to see the image."));
                            } else {
                                safeResolve(contentText);
                            }
                        } else {
                            safeReject(new Error("Empty content from vision server."));
                        }
                    } catch(e) {
                        safeReject(new Error(`Parsing response failed: ${e.message}`));
                    }
                });
            });
            
            req.on('error', (e) => safeReject(new Error(`Connection failed: ${e.message}`)));
            req.write(postData);
            req.end();

        } catch (preprocessErr) {
            safeReject(new Error(`이미지 전처리 실패: ${preprocessErr.message}`));
        }
    });
}

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
                const pdfjsPath = 'file:///' + path.resolve(__dirname, 'node_modules', 'pdfjs-dist', 'legacy/build/pdf.mjs').replace(/\\/g, '/');
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
    } else {
        console.log(`[parsePdfHybrid] 🖼️ 이미지 기반/스캔 PDF 판정: 강제 전체 OCR 및 비전 파이프라인 가동...`);
        const pdfjsPath = 'file:///' + path.resolve(__dirname, 'node_modules', 'pdfjs-dist', 'legacy/build/pdf.mjs').replace(/\\/g, '/');
        const pdfjs = await import(pdfjsPath);
        const loadingTask = pdfjs.getDocument({
            data: new Uint8Array(fileBuf),
            useSystemFonts: true,
            disableFontFace: true,
            isEvalSupported: false,
            disableWorker: true
        });
        const doc = await loadingTask.promise;

        // ✅ [핵심 버그 수정] kordoc이 실패한 경우 pageCount=1로 잘못 고정되는 문제 해결
        // pdfjs가 실제로 열어낸 numPages로 pageCount를 정확히 재계산합니다.
        const realPageCount = doc.numPages;
        if (realPageCount > pageCount) {
            console.log(`[parsePdfHybrid] 📃 실제 페이지 수 재조정: kordoc 추정치 ${pageCount} → pdfjs 확인값 ${realPageCount}`);
            pageCount = realPageCount;
            // targetPages도 실제 페이지 수 기준으로 재계산
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

function findFilesRecursively(dir, fileNameQuery, results = []) {
    try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            let stat;
            try { stat = fs.statSync(fullPath); } catch (e) { continue; }
            
            if (stat.isDirectory()) {
                const lowerFile = file.toLowerCase();
                if (lowerFile !== 'node_modules' && lowerFile !== '.git' && lowerFile !== '.mcp_cache') {
                    findFilesRecursively(fullPath, fileNameQuery, results);
                }
            } else if (file.toLowerCase().includes(fileNameQuery.toLowerCase())) {
                const relative = path.relative(__dirname, fullPath).replace(/\\/g, '/');
                results.push({
                    name: file,
                    path: relative.startsWith('.') ? relative : './' + relative,
                    size: stat.size
                });
            }
        }
    } catch (e) {}
    return results;
}

const tools = [
    {
        name: "parse_document",
        description: "[문서 및 이미지 분석/파싱] HWP, HWPX, PDF, XLSX, DOCX 및 이미지 파싱 도구입니다.",
        inputSchema: {
            type: "object",
            properties: { file_path: { type: "string", description: "분석할 파일의 경로" } },
            required: ["file_path"]
        }
    },
    {
        name: "detect_format",
        description: "[포맷 감지] 실제 포맷 명칭을 정확히 판별합니다.",
        inputSchema: {
            type: "object",
            properties: { file_path: { type: "string", description: "대상 파일 경로" } },
            required: ["file_path"]
        }
    },
    {
        name: "parse_metadata",
        description: "[메타데이터 추출] 메타데이터를 속성별 JSON으로 로드합니다.",
        inputSchema: {
            type: "object",
            properties: { file_path: { type: "string", description: "대상 파일 경로" } },
            required: ["file_path"]
        }
    },
    {
        name: "parse_pages",
        description: "[특정 페이지 파싱] 문서의 지정 구역 범위만 지정 파싱합니다.",
        inputSchema: {
            type: "object",
            properties: { file_path: { type: "string", description: "대상 파일 경로" }, pages: { type: "string", description: "범위 표현식 (예: 1-3)" } },
            required: ["file_path", "pages"]
        }
    },
    {
        name: "parse_table",
        description: "[특정 테이블 추출] 문서 내 지정 번호의 표 구조를 마크다운으로 추출합니다.",
        inputSchema: {
            type: "object",
            properties: { file_path: { type: "string", description: "대상 파일 경로" }, table_index: { type: "integer", description: "인덱스 (0부터 시작)" } },
            required: ["file_path", "table_index"]
        }
    },
    {
        name: "compare_documents",
        description: "[문서 신구대조 비교] 두 파일 객체의 텍스트 차이점을 대조 추출합니다.",
        inputSchema: {
            type: "object",
            properties: { file_path_a: { type: "string", description: "원본 경로" }, file_path_b: { type: "string", description: "수정본 경로" } },
            required: ["file_path_a", "file_path_b"]
        }
    },
    {
        name: "parse_form",
        description: "[서식 필드 추출] 신청서 서식 내 빈 필드 라벨 목록을 JSON화합니다.",
        inputSchema: {
            type: "object",
            properties: { file_path: { type: "string", description: "서식 파일 경로" } },
            required: ["file_path"]
        }
    },
    {
        name: "fill_form",
        description: "[서식 값 채우기] 빈칸 서식 필드 영역에 동적 매핑 값을 삽입 저장합니다.",
        inputSchema: {
            type: "object",
            properties: { file_path: { type: "string", description: "서식 파일 경로" }, fields: { type: "object", description: "매핑 오브젝트" }, output_path: { type: "string", description: "출력 경로" } },
            required: ["file_path", "fields", "output_path"]
        }
    },
    {
        name: "markdown_to_hwpx",
        description: "[마크다운을 HWPX로 변환] 마크다운 명세를 HWPX 한글 보고서 서식으로 빌드합니다.",
        inputSchema: {
            type: "object",
            properties: { markdown: { type: "string" }, markdown_path: { type: "string" }, output: { type: "string" } },
            required: ["output"]
        }
    },
    {
        name: "read_text_file",
        description: "[텍스트 전용 파일 읽기] 순수 플레인 텍스트 계열 전용 리더기입니다.",
        inputSchema: {
            type: "object",
            properties: { path: { type: "string" }, head: { type: "integer" }, tail: { type: "integer" } },
            required: ["path"]
        }
    },
    {
        name: "read_file",
        description: "[텍스트 전용 파일 읽기 - 호환용] 호환형 플레인 리더기 도구입니다.",
        inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"]
        }
    },
    {
        name: "write_file",
        description: "[텍스트 파일 쓰기] 지정 영역에 영구 플레인 명세를 새로 씁니다.",
        inputSchema: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"]
        }
    },
    {
        name: "list_directory",
        description: "[디렉토리 목록 조회] 타깃 폴더 구조 내 이름 리스트를 탐색 로드합니다.",
        inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"]
        }
    },
    {
        name: "list_directory_with_sizes",
        description: "[상세 디렉토리 조회] 세부 메타 및 디스크 점유 정보를 리스트화합니다.",
        inputSchema: {
            type: "object",
            properties: { path: { type: "string" }, sortBy: { type: "string", enum: ["name", "size"] } },
            required: ["path"]
        }
    },
    {
        name: "get_file_info",
        description: "[파일 정보 조회] 노드 개체의 타임스탬프 등 정밀 속성을 분석합니다.",
        inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"]
        }
    },
    {
        name: "search_file",
        description: "[파일 찾기/검색] 샌드박스 내부를 순회하며 매칭 경로를 재귀 리턴합니다.",
        inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"]
        }
    }
];

// ============================================================================
// 🔧 [공통 툴콜 처리기] 메서드 핸들러
// ============================================================================
async function handleMcpJsonRpc(method, params, id) {
    if (method === 'initialize') {
        return {
            jsonrpc: "2.0",
            id,
            result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "kordoc-official-bridge", version: "3.3.0" }
            }
        };
    }
    if (method === 'notifications/initialized') return null;
    if (method === 'tools/list') return { jsonrpc: "2.0", id, result: { tools } };

    if (method === 'tools/call') {
        const { name, arguments: rawArgs } = params;
        const args = { ...rawArgs };
        
        // 경로 정규화 및 바인딩 (자동 복사 없음)
        const filePath = sanitizeInputPath(args.file_path || args.path || args.filePath);
        const filePathA = sanitizeInputPath(args.file_path_a || args.old_path || args.path_a);
        const filePathB = sanitizeInputPath(args.file_path_b || args.new_path || args.path_b);
        const outputPath = sanitizeInputPath(args.output_path || args.output || args.outputPath);
        
        // 개별 인자 객체 필드 정규화 갱신
        if (args.file_path) args.file_path = sanitizeInputPath(args.file_path);
        if (args.path) args.path = sanitizeInputPath(args.path);
        if (args.file_path_a) args.file_path_a = sanitizeInputPath(args.file_path_a);
        if (args.file_path_b) args.file_path_b = sanitizeInputPath(args.file_path_b);
        if (args.markdown_path) args.markdown_path = sanitizeInputPath(args.markdown_path);
        if (args.output_path) args.output_path = sanitizeInputPath(args.output_path);
        if (args.output) args.output = sanitizeInputPath(args.output);

        let fields = args.fields || args.data;
        if (fields && typeof fields === 'string') {
            try { fields = JSON.parse(fields); } catch (e) {}
        }

        try {
            let output = "";
            const kd = await getKordoc();

            if (name === 'parse_document') {
                if (!filePath) throw new Error("file_path parameter is required.");
                const safePath = validatePath(filePath, true);
                
                const cacheKey = getCacheKey(safePath, 'parse_document');
                const cached = getCachedResult(cacheKey);
                
                let result;
                if (cached) {
                    console.log(`[Cache Hit] Serving from cache: ${path.basename(safePath)}`);
                    result = cached;
                } else {
                    console.log(`[Cache Miss] Parsing: ${path.basename(safePath)}`);
                    const ext = path.extname(safePath).toLowerCase();
                    const textExtensions = ['.txt', '.md', '.json', '.csv', '.xml', '.html', '.htm', '.yaml', '.yml'];
                    const imageExtensions = ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tiff'];
                    
                    if (textExtensions.includes(ext)) {
                        result = {
                            success: true,
                            fileType: ext.substring(1),
                            pageCount: 1,
                            metadata: { title: path.basename(safePath) },
                            isImageBased: false,
                            markdown: `\n\n## 📄 제 1 페이지 (텍스트 문서)\n\n` + fs.readFileSync(safePath, 'utf-8')
                        };
                    } else if (imageExtensions.includes(ext)) {
                        const fileBuf = fs.readFileSync(safePath);
                        const resultText = await localOcrHook(fileBuf, 1, `image/${ext.substring(1)}`);
                        result = {
                            success: true,
                            fileType: ext.substring(1),
                            pageCount: 1,
                            metadata: { title: path.basename(safePath) },
                            isImageBased: true,
                            markdown: resultText
                        };
                    } else {
                        const fileBuf = fs.readFileSync(safePath);
                        const isVisionActive = process.env.IS_VISION_MODEL && String(process.env.IS_VISION_MODEL).trim() === '1';
                        const isPdf = ext === '.pdf';

                        let finalMarkdown = '';

                        let runOcr = false;
                        if (isVisionActive && isPdf) {
                            runOcr = true;
                        }

                        if (runOcr) {
                            console.log(`[parse_document] ⚡ 비전 모드 활성화: 이미지 유실 방지 및 레이아웃 무결성을 위해 고해상도 전체 렌더링 파이프라인 가동...`);
                            try {
                                const ocrResult = await parsePdfHybrid(safePath, fileBuf);
                                if (!ocrResult.success) throw new Error(ocrResult.error);
                                finalMarkdown = ocrResult.markdown || '';
                                result = { ...ocrResult, success: true, isImageBased: ocrResult.isImageBased, markdown: finalMarkdown, warnings: ocrResult.warnings || [] };
                            } catch (ocrErr) {
                                console.warn(`[parse_document] ⚠️ 고해상도 OCR/비전 파싱 실패, 후순위 kordoc 고속 텍스트 추출로 폴백: ${ocrErr.message}`);
                                runOcr = false;
                            }
                        }

                        if (!runOcr) {
                            console.log(`[parse_document] 📄 Pass 1 (후순위/텍스트 추출): 순수 텍스트 고속 추출 가동...`);
                            const arrayBuf = toArrayBuffer(fileBuf);
                            const pass1Result = await kd.parse(arrayBuf);
                            
                            const isImageBasedFailure = !pass1Result.success && isPdf &&
                                (pass1Result.isImageBased || (pass1Result.error && pass1Result.error.includes('이미지 기반')));

                            if (!pass1Result.success && !isImageBasedFailure) {
                                throw new Error(`Parsing failed (${pass1Result.fileType}): ${pass1Result.error}`);
                            }

                            if (isImageBasedFailure) {
                                console.log(`[parse_document] 🖼️ Pass 1 실패 (스캔본). 이미지 하이브리드 파싱 전환...`);
                                try {
                                    const ocrResult = await kd.parse(toArrayBuffer(fileBuf), { ocr: localOcrHook });
                                    if (!ocrResult.success) throw new Error(ocrResult.error);
                                    finalMarkdown = ocrResult.markdown || '';
                                    result = { ...ocrResult, success: true, isImageBased: true, markdown: finalMarkdown, warnings: ocrResult.warnings || [] };
                                } catch (ocrErr) {
                                    throw new Error(`바이너리 기반 오프라인 OCR 파싱 최종 실패: ${ocrErr.message}`);
                                }
                            } else {
                                if (pass1Result.pages && pass1Result.pages.length > 0) {
                                    let structuredLines = [];
                                    for (let i = 0; i < pass1Result.pages.length; i++) {
                                        const pageNum = i + 1;
                                        const page = pass1Result.pages[i];
                                        let pageMarkdown = page.markdown || page.text || "";
                                        
                                        structuredLines.push(`\n\n---\n## 📄 제 ${pageNum} 페이지 (텍스트 레이어 추출)`);
                                        if (pageMarkdown.trim()) structuredLines.push(pageMarkdown.trim());
                                    }
                                    finalMarkdown = structuredLines.join("\n");
                                } else if (pass1Result.blocks && pass1Result.blocks.length > 0) {
                                    const blocksByPage = {};
                                    pass1Result.blocks.forEach(b => {
                                        const pageNum = b.pageNumber || (b.bbox && b.bbox.page) || 1;
                                        if (!blocksByPage[pageNum]) blocksByPage[pageNum] = [];
                                        blocksByPage[pageNum].push(b);
                                    });
                                    const pageKeys = Object.keys(blocksByPage).map(Number).sort((a, b) => a - b);
                                    
                                    let structuredLines = [];
                                    for (const pageNum of pageKeys) {
                                        let pageMarkdown = '';
                                        try {
                                            pageMarkdown = kd.blocksToMarkdown(blocksByPage[pageNum]);
                                        } catch (e) {
                                            pageMarkdown = blocksByPage[pageNum].map(b => b.text || '').join('\n');
                                        }
                                        structuredLines.push(`\n\n---\n## 📄 제 ${pageNum} 페이지 (텍스트 레이어 추출)`);
                                        if (pageMarkdown.trim()) structuredLines.push(pageMarkdown.trim());
                                    }
                                    finalMarkdown = structuredLines.join("\n");
                                } else {
                                    finalMarkdown = pass1Result.markdown || "";
                                }
                                result = { ...pass1Result, success: true, markdown: finalMarkdown, warnings: [] };
                            }
                        }
                    }
                    saveCacheResult(cacheKey, result);
                }

                const pageNum = result.pageCount || (result.metadata && result.metadata.pageCount);
                const meta = [`포맷: ${result.fileType ? result.fileType.toUpperCase() : 'PDF'}`, pageNum ? `페이지: ${pageNum}` : null].filter(Boolean).join(" | ");
                const parts = [`[${meta}]`];
                if (result.outline?.length > 0) {
                    parts.push(`\n\n📌 문서 구조:\n${result.outline.map(o => `${"  ".repeat(o.level - 1)}- ${o.text}`).join("\n")}`);
                }
                if (result.warnings?.length > 0) {
                    parts.push(`\n\n⚠️ 경고:\n${result.warnings.map(w => `- [p${w.page || "?"}] ${w.message}`).join("\n")}`);
                }
                parts.push(`\n\n${result.markdown}`);
                
                lastParsedMarkdown = result.markdown;
                output = parts.join("");
            } 
            else if (name === 'detect_format') {
                if (!filePath) throw new Error("file_path parameter is required.");
                const safePath = validatePath(filePath, true);
                const ext = path.extname(safePath).toLowerCase();
                let format = 'unknown';
                if (['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tiff'].includes(ext)) {
                    format = ext.substring(1);
                } else {
                    format = kd.detectFormat(toArrayBuffer(fs.readFileSync(safePath)));
                }
                output = `${path.basename(safePath)}: ${format}`;
            } 
            else if (name === 'parse_metadata') {
                if (!filePath) throw new Error("file_path parameter is required.");
                const safePath = validatePath(filePath, true);
                const cacheKey = getCacheKey(safePath, 'parse_metadata');
                const cached = getCachedResult(cacheKey);
                
                if (cached) {
                    output = JSON.stringify(cached, null, 2);
                } else {
                    const arrayBuf = toArrayBuffer(fs.readFileSync(safePath));
                    const format = kd.detectFormat(arrayBuf);
                    const res = await kd.parse(arrayBuf);
                    const resultToCache = { format, ...(res.success ? res.metadata : {}) };
                    saveCacheResult(cacheKey, resultToCache);
                    output = JSON.stringify(resultToCache, null, 2);
                }
            } 
            else if (name === 'parse_pages') {
                if (!filePath || !args.pages) throw new Error("file_path and pages parameters are required.");
                const safePath = validatePath(filePath, true);
                const cacheKey = getCacheKey(safePath, `parse_pages_${args.pages}`);
                const cached = getCachedResult(cacheKey);
                
                if (cached) {
                    output = `[포맷: ${cached.fileType.toUpperCase()} | 범위: ${args.pages}]\n\n${cached.markdown}`;
                } else {
                    const ext = path.extname(safePath).toLowerCase();
                    const isPdf = ext === '.pdf';
                    const isVisionActive = process.env.IS_VISION_MODEL && String(process.env.IS_VISION_MODEL).trim() === '1';
                    
                    let result;
                    let runOcr = isPdf && isVisionActive;
                    
                    if (runOcr) {
                        console.log(`[parse_pages] ⚡ 비전/OCR 모드 강제 실행: 범위: ${args.pages}...`);
                        try {
                            const fileBuf = fs.readFileSync(safePath);
                            result = await parsePdfHybrid(safePath, fileBuf, args.pages);
                        } catch (ocrErr) {
                            console.warn(`[parse_pages] ⚠️ 고해상도 OCR/비전 파싱 실패, 후순위 kordoc 고속 텍스트 추출로 폴백: ${ocrErr.message}`);
                            runOcr = false;
                        }
                    }
                    
                    if (!runOcr) {
                        console.log(`[parse_pages] 📄 Pass 1 (후순위/텍스트 추출): 범위: ${args.pages}...`);
                        const parseResult = await kd.parse(toArrayBuffer(fs.readFileSync(safePath)), { pages: args.pages });
                        if (!parseResult.success) throw new Error(parseResult.error);
                        result = parseResult;
                    }
                    
                    saveCacheResult(cacheKey, result);
                    lastParsedMarkdown = result.markdown;
                    output = `[포맷: ${result.fileType.toUpperCase()} | 범위: ${args.pages}]\n\n${result.markdown}`;
                }
            } 
            else if (name === 'parse_table') {
                if (!filePath) throw new Error("file_path parameter is required.");
                const tableIndex = parseInt(args.table_index !== undefined ? args.table_index : 0, 10);
                const safePath = validatePath(filePath, true);
                const result = await kd.parse(toArrayBuffer(fs.readFileSync(safePath)));
                if (!result.success) throw new Error(result.error);
                
                const tableBlocks = result.blocks.filter(b => b.type === "table" && b.table);
                if (tableBlocks.length === 0) throw new Error("문서에 테이블이 존재하지 않습니다.");
                if (tableIndex >= tableBlocks.length) throw new Error(`인덱스 초과 (총 ${tableBlocks.length}개 존재)`);
                
                output = `[테이블 #${tableIndex} / 총 ${tableBlocks.length}개]\n\n${kd.blocksToMarkdown([tableBlocks[tableIndex]])}`;
            } 
            else if (name === 'compare_documents') {
                if (!filePathA || !filePathB) throw new Error("Both path parameters are required.");
                const result = await kd.compare(fs.readFileSync(validatePath(filePathA, true)).buffer, fs.readFileSync(validatePath(filePathB, true)).buffer);
                const lines = [`## 문서 비교 결과`, `추가: ${result.stats.added} | 삭제: ${result.stats.removed} | 변경: ${result.stats.modified}`, ""];
                for (const d of result.diffs) {
                    const prefix = d.type === "added" ? "+" : d.type === "removed" ? "-" : d.type === "modified" ? "~" : " ";
                    const text = d.after?.text || d.before?.text || (d.after?.table ? "[테이블]" : "");
                    lines.push(`${prefix} ${text.substring(0, 200)}`);
                }
                output = lines.join("\n");
            } 
            else if (name === 'parse_form') {
                if (!filePath) throw new Error("file_path parameter is required.");
                const result = await kd.parse(toArrayBuffer(fs.readFileSync(validatePath(filePath, true))));
                if (!result.success) throw new Error(result.error);
                output = JSON.stringify(kd.extractFormFields(result.blocks), null, 2);
            } 
            else if (name === 'fill_form') {
                if (!filePath || !fields || !outputPath) throw new Error("Required parameters missing.");
                const safePath = validatePath(filePath, true);
                const safeOutputPath = validateWritePath(outputPath);
                const arrayBuf = toArrayBuffer(fs.readFileSync(safePath));
                const outputFormat = args.output_format || "hwpx-preserve";
                
                if (outputFormat === "hwpx-preserve") {
                    const hwpxResult = await kd.fillHwpx(arrayBuf, fields);
                    fs.mkdirSync(path.dirname(safeOutputPath), { recursive: true });
                    fs.writeFileSync(safeOutputPath, Buffer.from(hwpxResult.buffer));
                    output = `HWPX 파일 저장 성공 (서식 100% 보존): ${safeOutputPath}`;
                } else {
                    const result = await kd.parse(arrayBuf);
                    if (!result.success) throw new Error(result.error);
                    const fillResult = kd.fillFormFields(result.blocks, fields);
                    const markdown = kd.blocksToMarkdown(fillResult.blocks);
                    fs.mkdirSync(path.dirname(safeOutputPath), { recursive: true });
                    
                    if (outputFormat === "hwpx") {
                        fs.writeFileSync(safeOutputPath, Buffer.from(await kd.markdownToHwpx(markdown)));
                    } else {
                        fs.writeFileSync(safeOutputPath, markdown, "utf-8");
                    }
                    output = `서식 매핑 성공 및 파일 저장 완료: ${safeOutputPath}`;
                }
            } 
            else if (name === 'markdown_to_hwpx') {
                if (!outputPath) throw new Error("output parameter is required.");
                const safeOutputPath = validateWritePath(outputPath);
                let mdContent = args.markdown || "";
                
                if (mdContent && ((mdContent.includes('trth/thth') || mdContent.includes('trtd')) && !mdContent.includes('<table>'))) {
                    if (lastParsedMarkdown) mdContent = lastParsedMarkdown;
                } else if (args.markdown_path) {
                    mdContent = fs.readFileSync(validatePath(args.markdown_path, true), 'utf-8');
                }
                
                const buildOptions = {};
                if (args.font_family) buildOptions.fontFamily = args.font_family;
                if (args.line_spacing !== undefined) buildOptions.lineSpacing = parseInt(args.line_spacing, 10);
                
                const buffer = await kd.markdownToHwpx(mdContent, buildOptions);
                fs.mkdirSync(path.dirname(safeOutputPath), { recursive: true });
                fs.writeFileSync(safeOutputPath, Buffer.from(buffer));
                output = `HWPX 한글 문서 빌드 완료: ${safeOutputPath}`;
            } 
            else if (name === 'read_text_file' || name === 'read_file') {
                if (!filePath) throw new Error("path parameter is required.");
                const safePath = validatePath(filePath, true);
                if (['.xlsx', '.xls', '.docx', '.doc', '.hwp', '.hwpx', '.pdf'].includes(path.extname(safePath).toLowerCase())) {
                    throw new Error(`[오류] 바이너리 포맷은 read_file이 불가합니다. 'parse_document' 도구를 사용하세요.`);
                }
                let content = fs.readFileSync(safePath, 'utf8');
                if (args.head || args.tail) {
                    const lines = content.split(/\r?\n/);
                    if (args.head) content = lines.slice(0, parseInt(args.head, 10)).join('\n');
                    else if (args.tail) content = lines.slice(-parseInt(args.tail, 10)).join('\n');
                }
                output = content;
            } 
            else if (name === 'write_file') {
                if (!filePath || args.content === undefined) throw new Error("Parameters required.");
                const safePath = validateWritePath(filePath);
                fs.mkdirSync(path.dirname(safePath), { recursive: true });
                fs.writeFileSync(safePath, args.content, 'utf8');
                output = "Success";
            } 
            else if (name === 'list_directory') {
                const safePath = validatePath(filePath || '작업공간', true);
                output = fs.readdirSync(safePath).join('\n');
            } 
            else if (name === 'list_directory_with_sizes') {
                const safePath = validatePath(filePath || '작업공간', true);
                const details = fs.readdirSync(safePath).map(file => {
                    try {
                        const stat = fs.statSync(path.join(safePath, file));
                        return { name: file, size: stat.size, isDirectory: stat.isDirectory() };
                    } catch(e) { return { name: file, size: 0, isDirectory: false }; }
                });
                if (args.sortBy === 'size') details.sort((a, b) => b.size - a.size);
                else details.sort((a, b) => a.name.localeCompare(b.name));
                output = details.map(d => `${d.isDirectory ? '[DIR]' : '[FILE]'} ${d.name} (${d.size.toLocaleString()} bytes)`).join('\n');
            } 
            else if (name === 'get_file_info') {
                if (!filePath) throw new Error("path parameter is required.");
                const stat = fs.statSync(validatePath(filePath, true));
                output = JSON.stringify({ size: stat.size, isDirectory: stat.isDirectory(), modifiedAt: stat.mtime }, null, 2);
            } 
            else if (name === 'search_file') {
                const query = (args.query || args.q || "").trim();
                if (!query) throw new Error("query parameter missing.");
                const found = findFilesRecursively(path.join(__dirname, '작업공간'), query);
                output = found.length === 0 ? `[검색 결과 없음]` : found.map(f => `- ${f.name} | 경로: ${f.path}`).join('\n');
            } 
            else { throw new Error(`Tool ${name} unrecognized.`); }
            
            return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: output }] } };
        } catch (err) {
            writeDebugLog(`[JsonRpc ERROR] name=${name}, message=${err.message}`);
            return { jsonrpc: "2.0", id, error: { code: -32603, message: err.message } };
        }
    }
    return { jsonrpc: "2.0", id, result: {} };
}

// ============================================================================
// 🌐 [MCP SSE Transport Layer]
// ============================================================================
const sseClients = new Map();

app.get('/sse', (req, res) => {
    const sessionId = crypto.randomUUID();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    sseClients.set(sessionId, { res, alive: true });
    res.write(`event: endpoint\ndata: /mcp/message?sessionId=${sessionId}\n\n`);

    const keepAlive = setInterval(() => {
        if (sseClients.has(sessionId)) { try { res.write(': keepalive\n\n'); } catch (e) {} }
    }, 30000);

    req.on('close', () => { clearInterval(keepAlive); sseClients.delete(sessionId); });
});

app.post('/mcp/message', express.json({ limit: '100mb' }), async (req, res) => {
    const client = sseClients.get(req.query.sessionId);
    if (!client) return res.status(400).json({ error: "Invalid session ID" });
    
    res.status(202).send('Accepted');
    const { method, params, id } = req.body;
    
    try {
        const response = await handleMcpJsonRpc(method, params, id);
        if (response === null) return;
        client.res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
    } catch (err) {
        client.res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: err.message } })}\n\n`);
    }
});

app.post('/sse', express.json({ limit: '100mb' }), async (req, res) => {
    const response = await handleMcpJsonRpc(req.body.method, req.body.params, req.body.id);
    return response === null ? res.status(200).send() : res.json(response);
});

app.get('/tools', (req, res) => res.json([]));

const defaultSettingsPath = path.join(__dirname, 'default_settings.json');
let defaultSettingsConfig = {};
try {
    defaultSettingsConfig = JSON.parse(fs.readFileSync(defaultSettingsPath, 'utf8')).config || {};
} catch (e) {}

// ============================================================================
// 🌐 [리버스 프록시 및 브라우저 로컬 스토리지 동기화 가드]
// ⚡ [중요 버그 패치]: 전역 와일드카드 카드(*) 미들웨어를 Express 최하단 라우팅으로 격하.
// 기존 MCP SSE 및 메시지 엔드포인트를 통과한 모든 루트(/) GET 요청을 8081 포트로 무조건 리다이렉트 처리함.
// ============================================================================
app.get(/(.*)/, (req, res, next) => {
    // API 성격의 요청은 프록시 타지 않고 통과하도록 바이패스 설정
    if (req.path.startsWith('/mcp') || req.path.startsWith('/sse') || req.path.startsWith('/tools')) {
        return next();
    }

    const options = { hostname: '127.0.0.1', port: 8081, path: req.url, method: req.method, headers: { ...req.headers } };
    options.headers['host'] = '127.0.0.1:8081';
    delete options.headers['accept-encoding'];
    
    const proxyReq = http.request(options, (proxyRes) => {
        const isHtml = req.method === 'GET' && (req.path === '/' || req.path === '/index.html') && (proxyRes.headers['content-type'] || '').includes('text/html');
        if (isHtml) {
            let body = '';
            proxyRes.on('data', chunk => body += chunk);
            proxyRes.on('end', () => {
                const targetConfig = { ...defaultSettingsConfig };
                if (process.env.CONTEXT_SIZE) {
                    const ctxNum = Number(String(process.env.CONTEXT_SIZE).trim());
                    if (!isNaN(ctxNum)) targetConfig.n_ctx = ctxNum;
                }
                if (process.env.IS_VISION_MODEL && String(process.env.IS_VISION_MODEL).trim() === '0') {
                    targetConfig.systemMessage = targetConfig.systemMessage.replace("You are also equipped with multimodal vision capabilities...", "You are a text-only assistant...");
                }
                const scriptToInject = `<script>
                (function() {
                    try {
                        var updated = false; var def = ${JSON.stringify(targetConfig)}; var defStr = JSON.stringify(def);
                        var keys = ['settings', 'LlamaCppWebui.config'];
                        for (var i=0; i<keys.length; i++) {
                            if (localStorage.getItem(keys[i]) !== defStr) { localStorage.setItem(keys[i], defStr); updated = true; }
                        }
                        if (updated) window.location.reload();
                    } catch(e) {}
                })();
                </script>`;
                const modifiedBody = body.indexOf('</head>') !== -1 ? body.replace('</head>', scriptToInject + '</head>') : scriptToInject + body;
                Object.keys(proxyRes.headers).forEach(k => { if(k.toLowerCase() !== 'content-length') res.setHeader(k, proxyRes.headers[k]); });
                res.setHeader('Content-Length', Buffer.byteLength(modifiedBody));
                res.writeHead(proxyRes.statusCode || 200).end(modifiedBody);
            });
        } else {
            res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
            proxyRes.pipe(res, { end: true });
        }
    });
    
    proxyReq.on('error', () => {
        res.status(502).set('Content-Type', 'text/html').send(`<html><body><h1 style='text-align:center;margin-top:20vh;'>AI 모델 서버 기동 중... (자동 새로고침)</h1><script>setTimeout(()=>location.reload(), 2000);</script></body></html>`);
    });
    req.pipe(proxyReq, { end: true });
});

// 🛠️ [도구 호출 형식 보정기] 소형 모델(Gemma 2B 등)의 불완전한 MCP JSON 형태 자동 보정
function tryFixJsonString(jsonStr) {
    const trimmed = jsonStr.trim();
    try {
        const parsed = JSON.parse(trimmed);
        
        // 구조 A: [ { tool_name: "...", param: "..." } ]
        if (Array.isArray(parsed)) {
            let changed = false;
            const fixedArray = parsed.map(item => {
                if (item && item.tool_name && !item.parameters) {
                    const { tool_name, ...params } = item;
                    changed = true;
                    return { tool_name, parameters: params };
                }
                return item;
            });
            if (changed) {
                return JSON.stringify(fixedArray, null, 2);
            }
            return null;
        }
        
        // 구조 B: { tool_name: "...", param: "..." }
        if (parsed && typeof parsed === 'object') {
            if (parsed.tool_name) {
                if (parsed.parameters) {
                    return JSON.stringify([parsed], null, 2);
                } else {
                    const { tool_name, ...params } = parsed;
                    return JSON.stringify([{ tool_name, parameters: params }], null, 2);
                }
            }
        }
    } catch (e) {}
    return null;
}

function fixAssistantToolCallContent(text) {
    if (typeof text !== 'string') return text;

    // 1. ```json ... ``` 블록을 찾아서 내부 텍스트 추출 및 수정
    const codeBlockRegex = /```json\s*([\s\S]*?)\s*```/g;
    let modified = text.replace(codeBlockRegex, (match, jsonText) => {
        const fixedJsonText = tryFixJsonString(jsonText);
        if (fixedJsonText) {
            return `\`\`\`json\n${fixedJsonText}\n\`\`\``;
        }
        return match;
    });

    // 2. 만약 코드블록이 없어도 단독 JSON 형태가 있으면 시도
    if (modified === text) {
        const fixed = tryFixJsonString(text);
        if (fixed) {
            modified = fixed;
        }
    }

    // 3. 만약 대괄호로 감싸진 단독 단어 형태가 있으면 (예: [list_directory])
    // 이를 적절한 기본 파라미터를 가진 JSON 형태의 도구 호출로 변환
    if (modified === text) {
        const simpleBracketRegex = /^\s*\[([a-zA-Z0-9_]+)\]\s*$/;
        const bracketMatch = modified.match(simpleBracketRegex);
        if (bracketMatch) {
            const toolName = bracketMatch[1];
            const validTools = [
                'parse_document', 'detect_format', 'parse_metadata', 'parse_pages', 
                'parse_table', 'compare_documents', 'parse_form', 'fill_form', 
                'markdown_to_hwpx', 'read_text_file', 'read_file', 'write_file', 
                'list_directory', 'list_directory_with_sizes', 'get_file_info', 'search_file'
            ];
            if (validTools.includes(toolName)) {
                let defaultParams = {};
                if (toolName === 'list_directory' || toolName === 'list_directory_with_sizes') {
                    defaultParams = { path: '작업공간' };
                } else if (toolName === 'search_file') {
                    defaultParams = { query: '' };
                } else if (toolName === 'read_file' || toolName === 'read_text_file' || toolName === 'get_file_info') {
                    defaultParams = { path: '' };
                }
                
                const fixedObj = {
                    tool_name: toolName,
                    parameters: defaultParams
                };
                writeDebugLog(`[Bridge Patch] Converted simple bracket tool call [${toolName}] to valid JSON array.`);
                return `\`\`\`json\n${JSON.stringify([fixedObj], null, 2)}\n\`\`\``;
            }
        }
    }

    return modified;
}

function patchCompletionsResponseBody(body, isStream) {
    if (!isStream) {
        try {
            const parsed = JSON.parse(body);
            if (parsed.choices && parsed.choices[0] && parsed.choices[0].message) {
                const originalContent = parsed.choices[0].message.content;
                const fixedContent = fixAssistantToolCallContent(originalContent);
                if (originalContent !== fixedContent) {
                    writeDebugLog(`[Bridge Patch] Fixed flat tool call in non-stream response.`);
                    parsed.choices[0].message.content = fixedContent;
                    return JSON.stringify(parsed);
                }
            }
        } catch (e) {
            writeDebugLog(`[Bridge Patch Error] Failed to parse non-stream JSON body: ${e.message}`);
        }
        return body;
    } else {
        try {
            const lines = body.split('\n');
            let fullContent = '';
            let lastEventObj = null;
            
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
                    try {
                        const parsedEvent = JSON.parse(trimmed.substring(6));
                        if (parsedEvent.choices && parsedEvent.choices[0]) {
                            const delta = parsedEvent.choices[0].delta;
                            if (delta && delta.content) {
                                fullContent += delta.content;
                            }
                            lastEventObj = parsedEvent;
                        }
                    } catch (e) {}
                }
            }
            
            const fixedContent = fixAssistantToolCallContent(fullContent);
            if (fullContent !== fixedContent) {
                writeDebugLog(`[Bridge Patch] Fixed flat tool call in streamed response. Length: ${fullContent.length} -> ${fixedContent.length}`);
                if (lastEventObj) {
                    lastEventObj.choices[0].delta = { role: "assistant", content: fixedContent };
                    lastEventObj.choices[0].finish_reason = "stop";
                    
                    const newStream = [
                        `data: ${JSON.stringify(lastEventObj)}`,
                        `data: [DONE]`,
                        ``
                    ].join('\n\n');
                    return newStream;
                }
            }
        } catch (e) {
            writeDebugLog(`[Bridge Patch Error] Failed to parse stream body: ${e.message}`);
        }
        return body;
    }
}

// POST 프록시 가드 추가
app.post('/v1/chat/completions', express.json({ limit: '100mb' }), (req, res) => {
    const hasTools = req.body.tools && Array.isArray(req.body.tools) && req.body.tools.length > 0;
    
    // 이미지 포함 여부 검사 (드래그 앤 드롭 감지)
    let hasImage = false;
    if (req.body.messages && Array.isArray(req.body.messages)) {
        for (const msg of req.body.messages) {
            if (Array.isArray(msg.content)) {
                for (const contentItem of msg.content) {
                    if (contentItem.type === 'image_url') {
                        hasImage = true;
                        break;
                    }
                }
            }
            if (hasImage) break;
        }
    }
    
    // 툴이 꺼져 있거나, 이미지 분석 요청인 경우 도구 호출 강제 규칙 [Strict Tool Calling Rules] 제거
    if ((!hasTools || hasImage) && req.body.messages) {
        req.body.messages = req.body.messages.map(msg => {
            if (msg.role === 'system' && typeof msg.content === 'string') {
                let cleanContent = msg.content;
                const rulesIndex = cleanContent.indexOf('[Strict Tool Calling Rules]');
                if (rulesIndex !== -1) {
                    cleanContent = cleanContent.substring(0, rulesIndex).trim();
                }
                cleanContent = cleanContent.replace("equipped with MCP tools. ", "");
                cleanContent = cleanContent.replace("equipped with MCP tools.", "");
                return { ...msg, content: cleanContent };
            }
            return msg;
        });
    }

    writeDebugLog(`[COMPLETIONS REQ] ${JSON.stringify(req.body, null, 2)}`);
    
    const postData = JSON.stringify(req.body);
    const options = {
        hostname: '127.0.0.1',
        port: 8081,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
            ...req.headers,
            'host': '127.0.0.1:8081',
            'content-length': Buffer.byteLength(postData)
        }
    };
    
    const proxyReq = http.request(options, (proxyRes) => {
        let body = '';
        proxyRes.on('data', chunk => body += chunk);
        proxyRes.on('end', () => {
            writeDebugLog(`[COMPLETIONS RES] status=${proxyRes.statusCode} body=${body}`);
            
            const headers = { ...proxyRes.headers };
            const isStream = req.body.stream === true;
            let patchedBody = body;
            
            if (proxyRes.statusCode === 200) {
                patchedBody = patchCompletionsResponseBody(body, isStream);
                if (patchedBody !== body) {
                    writeDebugLog(`[Bridge Patch] Response body changed. Original length: ${body.length}, Patched length: ${patchedBody.length}`);
                    if (headers['content-length'] !== undefined) {
                        headers['content-length'] = Buffer.byteLength(patchedBody);
                    }
                }
            }
            
            res.writeHead(proxyRes.statusCode || 200, headers);
            res.end(patchedBody);
        });
    });
    proxyReq.on('error', () => res.sendStatus(502));
    proxyReq.write(postData);
    proxyReq.end();
});

// POST 프록시 가드 추가
app.post(/(.*)/, (req, res, next) => {
    if (req.path.startsWith('/mcp') || req.path.startsWith('/sse')) return next();
    
    const options = { hostname: '127.0.0.1', port: 8081, path: req.url, method: 'POST', headers: { ...req.headers } };
    options.headers['host'] = '127.0.0.1:8081';
    const proxyReq = http.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
    });
    proxyReq.on('error', () => res.sendStatus(502));
    req.pipe(proxyReq, { end: true });
});

function cleanCache() {
    try {
        if (!fs.existsSync(CACHE_DIR)) return;
        const files = fs.readdirSync(CACHE_DIR).map(file => {
            const fp = path.join(CACHE_DIR, file); const st = fs.statSync(fp);
            return { name: file, path: fp, size: st.size, mtime: st.mtime.getTime() };
        }).filter(f => f.name.endsWith('.json'));

        const now = Date.now(); let totalSize = 0;
        files.forEach(f => {
            if (now - f.mtime > 7 * 24 * 60 * 60 * 1000) { try { fs.unlinkSync(f.path); } catch(e){} } 
            else { totalSize += f.size; }
        });

        if (totalSize > 500 * 1024 * 1024) {
            files.filter(f => fs.existsSync(f.path)).sort((a, b) => a.mtime - b.mtime).forEach(f => {
                if (totalSize <= 500 * 1024 * 1024) return;
                try { fs.unlinkSync(f.path); totalSize -= f.size; } catch(e){}
            });
        }
    } catch (err) {}
}
cleanCache();

app.listen(8080, '127.0.0.1', () => console.log('Official Spec MCP Bridge Ready on port 8080'));