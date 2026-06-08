const path = require('path');
const http = require('http');
const { createWorker } = require('tesseract.js');
const { writeDebugLog } = require('./globals');

const projectRoot = path.resolve(__dirname, '..');

let globalOcrWorker = null;
let tesseractQueue = Promise.resolve();
let visionQueue = Promise.resolve();
const VISION_PAGE_TIMEOUT_MS = 1200 * 1000;

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
                        langPath: path.resolve(path.join(projectRoot, 'tessdata')),
                        cachePath: path.resolve(path.join(projectRoot, 'tessdata')),
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

module.exports = {
    preprocessVisionImage,
    localOcrHook,
    localVisionAnalyze
};
