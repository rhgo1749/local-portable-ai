const path = require('path');
const fs = require('fs');

const projectRoot = path.resolve(__dirname, '..');

// 🔐 [보안 샌드박싱] 접근 허용 경로 정의 및 검증 정규화
const allowedDirs = [
    path.resolve(path.join(projectRoot, '작업공간')),
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
                const relative = path.relative(projectRoot, fullPath).replace(/\\/g, '/');
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

function validatePath(targetPath, checkExists = false) {
    if (!targetPath) throw new Error("파일 경로가 제공되지 않았습니다.");
    const cleanPath = sanitizeInputPath(targetPath);
    let resolved = path.resolve(cleanPath);
    
    if (checkExists && !fs.existsSync(resolved)) {
        const baseName = path.basename(resolved);
        if (baseName) {
            console.log(`[validatePath] 파일 없음: "${resolved}". 재귀 검색을 시작합니다...`);
            const foundFiles = findFilesRecursively(path.join(projectRoot, '작업공간'), baseName);
            const exactMatches = foundFiles.filter(f => f.name.toLowerCase() === baseName.toLowerCase());
            
            if (exactMatches.length === 1) {
                resolved = path.resolve(projectRoot, exactMatches[0].path);
                console.log(`[validatePath] 자동 복구 성공 -> "${resolved}"`);
            } else if (exactMatches.length > 1) {
                throw new Error(`[파일 중복] "${baseName}"이(가) 여러 경로에 존재합니다: ${exactMatches.map(f => f.path).join(", ")}`);
            } else {
                const partialMatches = foundFiles.filter(f => f.name.toLowerCase().includes(baseName.toLowerCase()));
                if (partialMatches.length === 1) {
                    resolved = path.resolve(projectRoot, partialMatches[0].path);
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

module.exports = {
    allowedDirs,
    allowedWriteDirs,
    sanitizeInputPath,
    findFilesRecursively,
    validatePath,
    validateWritePath
};
