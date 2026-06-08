const express = require('express');
const { writeDebugLog } = require('./src/globals');
const { cleanCache } = require('./src/cache');
const { setupRouter } = require('./src/router');

// 📝 [Startup Debug Log]
writeDebugLog(`MCP Bridge Started. IS_VISION_MODEL: "${process.env.IS_VISION_MODEL}"`);

// 🧹 [Clean Cache]
cleanCache();

const app = express();

// 🌐 [Routing Setup]
setupRouter(app);

app.listen(8080, '127.0.0.1', () => console.log('Official Spec MCP Bridge Ready on port 8080'));