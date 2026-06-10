const fs = require('fs/promises');
const fssync = require('fs'); // mkdirSync 등 비동기 대체가 어려운极少数 용도로만 사용
const path = require('path');
const { getKordoc } = require('./kordoc-loader');
const { validatePath, validateWritePath, sanitizeInputPath, findFilesRecursively } = require('./sandbox');
const { getCacheKey, getCachedResult, saveCacheResult } = require('./cache');
const { localOcrHook } = require('./ocr-vision');
const { parsePdfHybrid, toArrayBuffer } = require('./pdf-parser');
const { writeDebugLog } = require('./globals');

const projectRoot = path.resolve(__dirname, '..');

let lastParsedMarkdown = "";

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
        description: "[디렉토리 목록 조회] 대상 폴더의 파일/폴더 목록과 크기를 확인합니다.",
        inputSchema: {
            type: "object",
            properties: { 
                path: { type: "string" },
                sortBy: { type: "string", enum: ["name", "size"] }
            },
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
                        const text = await fs.readFile(safePath, 'utf-8');
                        result = {
                            success: true,
                            fileType: ext.substring(1),
                            pageCount: 1,
                            metadata: { title: path.basename(safePath) },
                            isImageBased: false,
                            markdown: `\n\n## 📄 제 1 페이지 (텍스트 문서)\n\n` + text
                        };
                    } else if (imageExtensions.includes(ext)) {
                        const fileBuf = await fs.readFile(safePath);
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
                        const fileBuf = await fs.readFile(safePath);
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
                    const buf = await fs.readFile(safePath);
                    const arrayBuf = toArrayBuffer(buf);
                    format = kd.detectFormat(arrayBuf);
                    if (format === 'hwpx') {
                        const zipFormat = await kd.detectZipFormat(arrayBuf);
                        if (zipFormat && zipFormat !== 'unknown') {
                            format = zipFormat;
                        }
                    }
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
                    const buf = await fs.readFile(safePath);
                    const arrayBuf = toArrayBuffer(buf);
                    let format = kd.detectFormat(arrayBuf);
                    if (format === 'hwpx') {
                        const zipFormat = await kd.detectZipFormat(arrayBuf);
                        if (zipFormat && zipFormat !== 'unknown') {
                            format = zipFormat;
                        }
                    }
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
                            const fileBuf = await fs.readFile(safePath);
                            result = await parsePdfHybrid(safePath, fileBuf, args.pages);
                        } catch (ocrErr) {
                            console.warn(`[parse_pages] ⚠️ 고해상도 OCR/비전 파싱 실패, 후순위 kordoc 고속 텍스트 추출로 폴백: ${ocrErr.message}`);
                            runOcr = false;
                        }
                    }
                    
                    if (!runOcr) {
                        console.log(`[parse_pages] 📄 Pass 1 (후순위/텍스트 추출): 범위: ${args.pages}...`);
                        const buf = await fs.readFile(safePath);
                        const parseResult = await kd.parse(toArrayBuffer(buf), { pages: args.pages });
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
                const buf = await fs.readFile(safePath);
                const result = await kd.parse(toArrayBuffer(buf));
                if (!result.success) throw new Error(result.error);
                
                const tableBlocks = result.blocks.filter(b => b.type === "table" && b.table);
                if (tableBlocks.length === 0) throw new Error("문서에 테이블이 존재하지 않습니다.");
                if (tableIndex >= tableBlocks.length) throw new Error(`인덱스 초과 (총 ${tableBlocks.length}개 존재)`);
                
                output = `[테이블 #${tableIndex} / 총 ${tableBlocks.length}개]\n\n${kd.blocksToMarkdown([tableBlocks[tableIndex]])}`;
            } 
            else if (name === 'compare_documents') {
                if (!filePathA || !filePathB) throw new Error("Both path parameters are required.");
                const bufA = await fs.readFile(validatePath(filePathA, true));
                const bufB = await fs.readFile(validatePath(filePathB, true));
                const result = await kd.compare(bufA.buffer, bufB.buffer);
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
                const buf = await fs.readFile(validatePath(filePath, true));
                const result = await kd.parse(toArrayBuffer(buf));
                if (!result.success) throw new Error(result.error);
                output = JSON.stringify(kd.extractFormFields(result.blocks), null, 2);
            } 
            else if (name === 'fill_form') {
                if (!filePath || !fields || !outputPath) throw new Error("Required parameters missing.");
                const safePath = validatePath(filePath, true);
                const safeOutputPath = validateWritePath(outputPath);
                const buf = await fs.readFile(safePath);
                const arrayBuf = toArrayBuffer(buf);
                const outputFormat = args.output_format || "hwpx-preserve";
                
                fssync.mkdirSync(path.dirname(safeOutputPath), { recursive: true });
                
                if (outputFormat === "hwpx-preserve") {
                    const hwpxResult = await kd.fillHwpx(arrayBuf, fields);
                    await fs.writeFile(safeOutputPath, Buffer.from(hwpxResult.buffer));
                    output = `HWPX 파일 저장 성공 (서식 100% 보존): ${safeOutputPath}`;
                } else {
                    const result = await kd.parse(arrayBuf);
                    if (!result.success) throw new Error(result.error);
                    const fillResult = kd.fillFormFields(result.blocks, fields);
                    const markdown = kd.blocksToMarkdown(fillResult.blocks);

                    if (outputFormat === "hwpx") {
                        await fs.writeFile(safeOutputPath, Buffer.from(await kd.markdownToHwpx(markdown)));
                    } else {
                        await fs.writeFile(safeOutputPath, markdown, "utf-8");
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
                    const buf = await fs.readFile(validatePath(args.markdown_path, true), 'utf-8');
                    mdContent = buf.toString();
                }
                
                const buildOptions = {};
                if (args.font_family) buildOptions.fontFamily = args.font_family;
                if (args.line_spacing !== undefined) buildOptions.lineSpacing = parseInt(args.line_spacing, 10);
                
                const buffer = await kd.markdownToHwpx(mdContent, buildOptions);
                fssync.mkdirSync(path.dirname(safeOutputPath), { recursive: true });
                await fs.writeFile(safeOutputPath, Buffer.from(buffer));
                output = `HWPX 한글 문서 빌드 완료: ${safeOutputPath}`;
            } 
            else if (name === 'read_text_file' || name === 'read_file') {
                if (!filePath) throw new Error("path parameter is required.");
                const safePath = validatePath(filePath, true);
                if (['.xlsx', '.xls', '.docx', '.doc', '.hwp', '.hwpx', '.pdf'].includes(path.extname(safePath).toLowerCase())) {
                    throw new Error(`[오류] 바이너리 포맷은 read_file이 불가합니다. 'parse_document' 도구를 사용하세요.`);
                }
                let content = (await fs.readFile(safePath, 'utf8')).toString();
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
                fssync.mkdirSync(path.dirname(safePath), { recursive: true });
                await fs.writeFile(safePath, args.content, 'utf8');
                output = "Success";
            } 
            else if (name === 'list_directory') {
                const safePath = validatePath(filePath || '작업공간', true);
                const entries = await fs.readdir(safePath);
                if (args.sortBy) {
                    const details = [];
                    for (const file of entries) {
                        try {
                            const stat = await fs.stat(path.join(safePath, file));
                            details.push({ name: file, size: stat.size, isDirectory: stat.isDirectory() });
                        } catch(e) { 
                            details.push({ name: file, size: 0, isDirectory: false }); 
                        }
                    }
                    if (args.sortBy === 'size') details.sort((a, b) => b.size - a.size);
                    else details.sort((a, b) => a.name.localeCompare(b.name));
                    output = details.map(d => `${d.isDirectory ? '[DIR]' : '[FILE]'} ${d.name} (${d.size.toLocaleString()} bytes)`).join('\n');
                } else {
                    output = entries.join('\n');
                }
            } 
            else if (name === 'list_directory_with_sizes') {
                // Backward compatibility just in case
                const safePath = validatePath(filePath || '작업공간', true);
                const entries = await fs.readdir(safePath);
                const details = [];
                for (const file of entries) {
                    try {
                        const stat = await fs.stat(path.join(safePath, file));
                        details.push({ name: file, size: stat.size, isDirectory: stat.isDirectory() });
                    } catch(e) { 
                        details.push({ name: file, size: 0, isDirectory: false }); 
                    }
                }
                if (args.sortBy === 'size') details.sort((a, b) => b.size - a.size);
                else details.sort((a, b) => a.name.localeCompare(b.name));
                output = details.map(d => `${d.isDirectory ? '[DIR]' : '[FILE]'} ${d.name} (${d.size.toLocaleString()} bytes)`).join('\n');
            } 
            else if (name === 'get_file_info') {
                if (!filePath) throw new Error("path parameter is required.");
                const stat = await fs.stat(validatePath(filePath, true));
                output = JSON.stringify({ size: stat.size, isDirectory: stat.isDirectory(), modifiedAt: stat.mtime }, null, 2);
            } 
            else if (name === 'search_file') {
                const query = (args.query || args.q || "").trim();
                if (!query) throw new Error("query parameter missing.");
                const found = findFilesRecursively(path.join(projectRoot, '작업공간'), query);
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

module.exports = {
    tools,
    handleMcpJsonRpc
};
