const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const projectRoot = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(projectRoot, '.mcp_cache');
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function getCacheKey(safePath, additionalParams = '') {
    try {
        const stat = fs.statSync(safePath);
        const isVision = (process.env.IS_VISION_MODEL && String(process.env.IS_VISION_MODEL).trim() === '1') ? 'vision' : 'text';
        const entryPointPath = path.resolve(projectRoot, 'mcp-bridge.js');
        const bridgeStat = fs.statSync(entryPointPath);
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

module.exports = {
    CACHE_DIR,
    getCacheKey,
    getCachedResult,
    saveCacheResult,
    cleanCache
};
