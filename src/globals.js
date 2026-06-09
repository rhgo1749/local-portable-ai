const path = require('path');
const fs = require('fs');

const projectRoot = path.resolve(__dirname, '..');

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

// 📝 [디버그 파일 로거]
const logFile = path.join(projectRoot, 'debug_mcp.log');
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

// 🔧 [환경 변수 기반 포트 설정 - 하드코딩 제거]
function getConfigPort() { return parseInt(process.env.BRIDGE_PORT || '8080', 10); }
function getLlamaServerHost() { return process.env.LLM_SERVER_HOST || '127.0.0.1'; }
function getLlamaServerPort() { return parseInt(process.env.LLM_SERVER_PORT || '8081', 10); }

module.exports = {
    writeDebugLog,
    getConfigPort,
    getLlamaServerHost,
    getLlamaServerPort
};
