const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { handleMcpJsonRpc } = require('./tools-definition');
const { patchCompletionsResponseBody } = require('./patcher');
const { writeDebugLog } = require('./globals');

const projectRoot = path.resolve(__dirname, '..');

const defaultSettingsPath = path.join(projectRoot, 'default_settings.json');
let defaultSettingsConfig = {};
try {
    defaultSettingsConfig = JSON.parse(fs.readFileSync(defaultSettingsPath, 'utf8')).config || {};
} catch (e) {}

const sseClients = new Map();

function setupRouter(app) {
    app.use((req, res, next) => {
        const origin = req.headers.origin;
        if (origin && (origin.includes('127.0.0.1:8080') || origin.includes('localhost:8080'))) {
            res.header('Access-Control-Allow-Origin', origin);
        } else {
            res.header('Access-Control-Allow-Origin', 'http://127.0.0.1:8080');
        }
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, mcp-protocol-version');
        if (req.method === 'OPTIONS') return res.sendStatus(200);
        next();
    });

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

    // POST completions handler with proxy guard
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

    // POST proxy fallback
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

    // GET proxy with script injection
    app.get(/(.*)/, (req, res, next) => {
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
}

module.exports = {
    setupRouter
};
