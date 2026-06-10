const express = require('express');
const { writeDebugLog } = require('./src/globals');
const { cleanCache } = require('./src/cache');
const { setupRouter, loadDefaultSettings } = require('./src/router');

async function start() {
    // 📝 [Startup Debug Log]
    writeDebugLog(`MCP Bridge Started. IS_VISION_MODEL: "${process.env.IS_VISION_MODEL}"`);

    // ⚙️ Load default settings asynchronously (non-blocking)
    await loadDefaultSettings();

    // 🧹 [Clean Cache - async non-blocking]
    cleanCache();

    const app = express();

    // 🌐 [Routing Setup]
    setupRouter(app);

    app.listen(getConfigPort(), '127.0.0.1', () => console.log(`Official Spec MCP Bridge Ready on port ${getConfigPort()}`));
}

function getConfigPort() { return parseInt(process.env.BRIDGE_PORT || '8080', 10); }

start().catch(err => {
    writeDebugLog(`[Bridge Startup ERROR] ${err.message}`);
    process.exit(1);
});
