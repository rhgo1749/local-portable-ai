const crypto = require('crypto');
const { writeDebugLog } = require('./globals');

// 🛠️ [도구 호출 형식 보정기] 소형 모델(Gemma 2B 등)의 불완전한 MCP JSON 형태 자동 보정
function normalizeParsedObject(parsed) {
    if (!parsed) return [];
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.map(item => {
        if (!item || typeof item !== 'object') return null;
        const toolName = item.tool_name || item.tool_call || item.tool;
        if (!toolName) return null;
        
        let parameters = item.parameters;
        if (!parameters) {
            const { tool_name, tool_call, tool, ...rest } = item;
            parameters = rest;
        }
        return { tool_name: toolName, parameters };
    }).filter(Boolean);
}

function tryFixJsonString(jsonStr) {
    const trimmed = jsonStr.trim();
    try {
        const parsed = JSON.parse(trimmed);
        const normalized = normalizeParsedObject(parsed);
        if (normalized.length > 0) {
            return JSON.stringify(normalized, null, 2);
        }
    } catch (e) {}
    return null;
}

const toolPositionalParams = {
    parse_document: ['file_path'],
    parse_pages: ['file_path', 'pages'],
    parse_table: ['file_path', 'table_index'],
    compare_documents: ['file_path_a', 'file_path_b'],
    fill_form: ['file_path', 'fields', 'output_path'],
    markdown_to_hwpx: ['markdown_path', 'output', 'markdown'],
    read_text_file: ['path', 'head', 'tail'],
    write_file: ['path', 'content'],
    list_directory: ['path', 'sortBy'],
    get_file_info: ['path'],
    search_file: ['query']
};

function parsePositionalArgs(text) {
    const args = [];
    const regex = /(?:'([^']*)'|"([^"]*)"|([^\s,]+))/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        if (match[1] !== undefined) args.push(match[1]);
        else if (match[2] !== undefined) args.push(match[2]);
        else if (match[3] !== undefined) args.push(match[3]);
    }
    return args;
}

function tryParsePlainLine(line) {
    let trimmed = line.trim();
    // Strip markdown formatting like backticks, list bullets
    trimmed = trimmed.replace(/^[-*+]\s+/, ''); // bullet points
    trimmed = trimmed.replace(/^\d+\.\s+/, ''); // numbered lists
    trimmed = trimmed.replace(/`/g, ''); // backticks
    trimmed = trimmed.trim();
    
    if (!trimmed) return null;
    
    const validTools = [
        'parse_document', 'parse_pages', 'parse_table', 'compare_documents', 
        'fill_form', 'markdown_to_hwpx', 'read_text_file', 'write_file', 
        'list_directory', 'get_file_info', 'search_file'
    ];
    
    // Check llama.cpp native tool call token first: [tool_call:list_directory{path:<|"|>./작업공간<|"|>}]
    if (trimmed.startsWith('[tool_call:')) {
        const match = trimmed.match(/^\[tool_call:([a-zA-Z0-9_]+)([\s\S]*)\]$/);
        if (match) {
            const toolName = match[1];
            let paramStr = match[2].trim();
            if (validTools.includes(toolName)) {
                paramStr = paramStr.replace(/<\|"\|>/g, '"');
                let params = {};
                if (paramStr.startsWith('{') && paramStr.endsWith('}')) {
                    try {
                        const cleanJsonStr = paramStr
                            .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":')
                            .replace(/'/g, '"');
                        params = JSON.parse(cleanJsonStr);
                    } catch (e) {
                        const paramRegex = /(?:([a-zA-Z0-9_]+)\s*:\s*(?:'([^']*)'|"([^"]*)"|([^\s,}]+)))/g;
                        let pMatch;
                        while ((pMatch = paramRegex.exec(paramStr)) !== null) {
                            const key = pMatch[1];
                            let val = pMatch[2] || pMatch[3] || pMatch[4];
                            if (['table_index', 'head', 'tail'].includes(key)) {
                                const num = parseInt(val, 10);
                                val = isNaN(num) ? val : num;
                            }
                            params[key] = val;
                        }
                    }
                }
                return { tool_name: toolName, parameters: params };
            }
        }
    }
    
    // Check simple bracket format first: [list_directory]
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        const name = trimmed.substring(1, trimmed.length - 1).trim();
        if (validTools.includes(name)) {
            const params = {};
            const posKeys = toolPositionalParams[name] || [];
            if (posKeys[0]) {
                params[posKeys[0]] = name === 'list_directory' ? '작업공간' : '';
            }
            return { tool_name: name, parameters: params };
        }
    }
    
    // Check if the line starts with a valid tool name
    const toolMatch = trimmed.match(/^([a-zA-Z0-9_]+)/);
    if (!toolMatch) return null;
    
    const toolName = toolMatch[1];
    if (!validTools.includes(toolName)) return null;
    
    // Remaining text after tool name
    let rest = trimmed.substring(toolName.length).trim();
    
    // Case 1: python-like tool_name(key='value', key2="value") or tool_name('value')
    if (rest.startsWith('(') && rest.endsWith(')')) {
        rest = rest.substring(1, rest.length - 1).trim();
        const params = {};
        
        // Match key='value' or key="value" or key=value
        const paramRegex = /([a-zA-Z0-9_]+)\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\s,]+))/g;
        let pMatch;
        let hasPairs = false;
        while ((pMatch = paramRegex.exec(rest)) !== null) {
            hasPairs = true;
            const key = pMatch[1];
            let val = pMatch[2] || pMatch[3] || pMatch[4];
            if (['table_index', 'head', 'tail'].includes(key)) {
                const num = parseInt(val, 10);
                val = isNaN(num) ? val : num;
            }
            params[key] = val;
        }
        
        if (hasPairs) {
            return { tool_name: toolName, parameters: params };
        } else {
            // Positional inside parens: tool_name('value', 0)
            const args = parsePositionalArgs(rest);
            const posKeys = toolPositionalParams[toolName] || [];
            args.forEach((val, idx) => {
                const key = posKeys[idx];
                if (key) {
                    let finalVal = val;
                    if (['table_index', 'head', 'tail'].includes(key)) {
                        const num = parseInt(val, 10);
                        finalVal = isNaN(num) ? val : num;
                    }
                    params[key] = finalVal;
                }
            });
            if (Object.keys(params).length > 0) {
                return { tool_name: toolName, parameters: params };
            }
        }
    }
    
    // Case 2: command-line like "tool_name value" or "tool_name key=value"
    if (rest) {
        const params = {};
        const paramRegex = /([a-zA-Z0-9_]+)\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\s,]+))/g;
        let pMatch;
        let hasPairs = false;
        while ((pMatch = paramRegex.exec(rest)) !== null) {
            hasPairs = true;
            const key = pMatch[1];
            let val = pMatch[2] || pMatch[3] || pMatch[4];
            if (['table_index', 'head', 'tail'].includes(key)) {
                const num = parseInt(val, 10);
                val = isNaN(num) ? val : num;
            }
            params[key] = val;
        }
        
        if (hasPairs) {
            return { tool_name: toolName, parameters: params };
        } else {
            // Positional string: e.g. "parse_table ./작업공간/example.pdf 0"
            const args = parsePositionalArgs(rest);
            const posKeys = toolPositionalParams[toolName] || [];
            args.forEach((val, idx) => {
                const key = posKeys[idx];
                if (key) {
                    let finalVal = val;
                    if (['table_index', 'head', 'tail'].includes(key)) {
                        const num = parseInt(val, 10);
                        finalVal = isNaN(num) ? val : num;
                    }
                    params[key] = finalVal;
                }
            });
            if (Object.keys(params).length > 0) {
                return { tool_name: toolName, parameters: params };
            }
        }
    } else {
        // No arguments
        const posKeys = toolPositionalParams[toolName] || [];
        const params = {};
        if (posKeys[0]) {
            params[posKeys[0]] = toolName === 'list_directory' ? '작업공간' : '';
        }
        return { tool_name: toolName, parameters: params };
    }
    
    return null;
}

// Extract tool calls from content text (either raw JSON, markdown JSON block, or simple brackets)
function extractToolCalls(content) {
    if (typeof content !== 'string') return null;
    
    const getValidToolCalls = (text) => {
        try {
            const parsed = JSON.parse(text);
            const isValid = (Array.isArray(parsed) && parsed.length > 0 && (parsed[0].tool_name || parsed[0].tool_call || parsed[0].tool)) ||
                            (parsed && typeof parsed === 'object' && (parsed.tool_name || parsed.tool_call || parsed.tool));
            if (isValid) {
                return normalizeParsedObject(parsed);
            }
        } catch (e) {
            const fixedStr = tryFixJsonString(text);
            if (fixedStr) {
                try {
                    const parsed = JSON.parse(fixedStr);
                    const isValid = (Array.isArray(parsed) && parsed.length > 0 && parsed[0].tool_name) ||
                                    (parsed && typeof parsed === 'object' && parsed.tool_name);
                    if (isValid) {
                        return Array.isArray(parsed) ? parsed : [parsed];
                    }
                } catch (err) {}
            }
        }
        return null;
    };

    // 1. Check for ```json ... ``` or ``` ... ```
    const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/g;
    let match;
    while ((match = codeBlockRegex.exec(content)) !== null) {
        const jsonText = match[1].trim();
        const res = getValidToolCalls(jsonText);
        if (res) return res;
    }
    
    // 2. Check for raw JSON string
    const trimmed = content.trim();
    const res = getValidToolCalls(trimmed);
    if (res) return res;
    
    // 3. Check for simple bracket tool call (e.g. [list_directory])
    const simpleBracketRegex = /^\s*\[([a-zA-Z0-9_]+)\]\s*$/;
    const bracketMatch = content.match(simpleBracketRegex);
    if (bracketMatch) {
        const toolName = bracketMatch[1];
        const validTools = [
            'parse_document', 'parse_pages', 'parse_table', 'compare_documents', 
            'fill_form', 'markdown_to_hwpx', 'read_text_file', 'write_file', 
            'list_directory', 'get_file_info', 'search_file'
        ];
        if (validTools.includes(toolName)) {
            let defaultParams = {};
            if (toolName === 'list_directory') {
                defaultParams = { path: '작업공간' };
            } else if (toolName === 'search_file') {
                defaultParams = { query: '' };
            } else if (toolName === 'read_text_file' || toolName === 'get_file_info') {
                defaultParams = { path: '' };
            }
            return [{ tool_name: toolName, parameters: defaultParams }];
        }
    }
    
    // 4. Fallback: Check if there are plain text tool calls line-by-line
    const lines = content.split('\n');
    const plainToolCalls = [];
    for (const line of lines) {
        const parsed = tryParsePlainLine(line);
        if (parsed) {
            plainToolCalls.push(parsed);
        }
    }
    if (plainToolCalls.length > 0) {
        writeDebugLog(`[Bridge Patch] Extracted ${plainToolCalls.length} plain text tool calls from response.`);
        return plainToolCalls;
    }
    
    // 5. Fallback: Repair truncated JSON
    let cleanContent = content.trim();
    if (cleanContent.startsWith('```')) {
        cleanContent = cleanContent.replace(/^```(?:json)?\s*/i, '');
    }
    if (cleanContent.includes('"tool_name"') || cleanContent.includes('"tool_call"') || cleanContent.includes('"tool"')) {
        const toolNameMatch = cleanContent.match(/"(?:tool_name|tool_call|tool)"\s*:\s*"([a-zA-Z0-9_]+)"/);
        if (toolNameMatch) {
            const toolName = toolNameMatch[1];
            const params = {};
            
            const keys = ['markdown', 'markdown_path', 'output', 'path', 'file_path', 'query', 'content', 'table_index', 'pages', 'fields'];
            for (const key of keys) {
                const keyIdx = cleanContent.indexOf(`"${key}"`);
                if (keyIdx !== -1) {
                    const colonIdx = cleanContent.indexOf(':', keyIdx);
                    if (colonIdx !== -1) {
                        const startQuoteIdx = cleanContent.indexOf('"', colonIdx);
                        if (startQuoteIdx !== -1) {
                            let endQuoteIdx = -1;
                            let idx = startQuoteIdx + 1;
                            while (idx < cleanContent.length) {
                                if (cleanContent[idx] === '"' && cleanContent[idx - 1] !== '\\') {
                                    endQuoteIdx = idx;
                                    break;
                                }
                                idx++;
                            }
                            
                            let val = '';
                            if (endQuoteIdx !== -1) {
                                val = cleanContent.substring(startQuoteIdx + 1, endQuoteIdx);
                            } else {
                                val = cleanContent.substring(startQuoteIdx + 1);
                                val = val.replace(/["\s},\]]*$/, '');
                            }
                            
                            try {
                                params[key] = JSON.parse(`"${val}"`);
                            } catch (e) {
                                params[key] = val
                                    .replace(/\\n/g, '\n')
                                    .replace(/\\r/g, '\r')
                                    .replace(/\\t/g, '\t')
                                    .replace(/\\"/g, '"')
                                    .replace(/\\\\/g, '\\');
                            }
                        }
                    }
                }
            }
            
            if (Object.keys(params).length > 0) {
                writeDebugLog(`[Bridge Patch] Successfully repaired truncated JSON for tool: ${toolName}`);
                return [{ tool_name: toolName, parameters: params }];
            }
        }
    }
    
    return null;
}

// Convert extracted custom tool calls list into native OpenAI format
// Convert extracted custom tool calls list into native OpenAI format
function convertToNativeToolCalls(toolCallList) {
    return toolCallList.map((tc, idx) => {
        const id = `call_${crypto.randomBytes(6).toString('hex')}`;
        const toolName = tc.tool_name;
        const rawParams = { ...tc.parameters };
        const params = {};
        
        // Define parameter mappings based on toolName
        if (toolName === 'parse_document' || toolName === 'parse_pages' || toolName === 'parse_table') {
            const filePath = rawParams.file_path || rawParams.path || rawParams.filePath || rawParams.file || rawParams.file_name || rawParams.fileName;
            if (filePath !== undefined) {
                params.file_path = filePath;
            }
            if (toolName === 'parse_pages') {
                params.pages = rawParams.pages !== undefined ? String(rawParams.pages) : undefined;
            }
            if (toolName === 'parse_table') {
                const tableIndex = rawParams.table_index !== undefined ? parseInt(rawParams.table_index, 10) : undefined;
                params.table_index = isNaN(tableIndex) ? undefined : tableIndex;
            }
        } 
        else if (toolName === 'compare_documents') {
            const filePathA = rawParams.file_path_a || rawParams.old_path || rawParams.path_a || rawParams.pathA || rawParams.file_a || rawParams.fileA;
            const filePathB = rawParams.file_path_b || rawParams.new_path || rawParams.path_b || rawParams.pathB || rawParams.file_b || rawParams.fileB;
            if (filePathA !== undefined) params.file_path_a = filePathA;
            if (filePathB !== undefined) params.file_path_b = filePathB;
        } 
        else if (toolName === 'fill_form') {
            const filePath = rawParams.file_path || rawParams.path || rawParams.filePath || rawParams.file;
            const outputPath = rawParams.output_path || rawParams.output || rawParams.outputPath || rawParams.out;
            let fields = rawParams.fields || rawParams.data || rawParams.formData || rawParams.form_data;
            
            if (filePath !== undefined) params.file_path = filePath;
            if (outputPath !== undefined) params.output_path = outputPath;
            if (fields !== undefined) {
                if (typeof fields === 'string') {
                    try {
                        fields = JSON.parse(fields);
                    } catch (e) {}
                }
                params.fields = fields;
            }
        } 
        else if (toolName === 'markdown_to_hwpx') {
            const mdContent = rawParams.markdown || rawParams.content || rawParams.text;
            const mdPath = rawParams.markdown_path || rawParams.markdownPath || rawParams.path || rawParams.file_path || rawParams.filePath;
            const outputPath = rawParams.output || rawParams.outputPath || rawParams.output_path;
            
            if (mdContent !== undefined) params.markdown = mdContent;
            if (mdPath !== undefined) params.markdown_path = mdPath;
            if (outputPath !== undefined) params.output = outputPath;
        } 
        else if (toolName === 'read_text_file' || toolName === 'get_file_info') {
            const filePath = rawParams.path || rawParams.file_path || rawParams.filePath || rawParams.file || rawParams.file_name || rawParams.fileName;
            if (filePath !== undefined) params.path = filePath;
            if (toolName === 'read_text_file') {
                if (rawParams.head !== undefined) {
                    const headNum = parseInt(rawParams.head, 10);
                    if (!isNaN(headNum)) params.head = headNum;
                }
                if (rawParams.tail !== undefined) {
                    const tailNum = parseInt(rawParams.tail, 10);
                    if (!isNaN(tailNum)) params.tail = tailNum;
                }
            }
        } 
        else if (toolName === 'write_file') {
            const filePath = rawParams.path || rawParams.file_path || rawParams.filePath || rawParams.file || rawParams.file_name || rawParams.fileName;
            const contentVal = rawParams.content !== undefined ? rawParams.content : (rawParams.data !== undefined ? rawParams.data : (rawParams.text !== undefined ? rawParams.text : rawParams.body));
            
            if (filePath !== undefined) params.path = filePath;
            if (contentVal !== undefined) params.content = String(contentVal);
        } 
        else if (toolName === 'list_directory') {
            const dirPath = rawParams.path || rawParams.dir || rawParams.directory || rawParams.directory_path || rawParams.directoryPath || rawParams.file_path || rawParams.filePath;
            if (dirPath !== undefined) params.path = dirPath;
            if (rawParams.sortBy !== undefined) params.sortBy = rawParams.sortBy;
        } 
        else if (toolName === 'search_file') {
            const queryVal = rawParams.query !== undefined ? rawParams.query : (rawParams.q !== undefined ? rawParams.q : (rawParams.search !== undefined ? rawParams.search : rawParams.keyword));
            if (queryVal !== undefined) params.query = String(queryVal);
        }
        else {
            // Fallback: Copy all params if name doesn't match
            Object.assign(params, rawParams);
        }
        
        // Inject default parameters if missing to satisfy tool schemas
        if (toolName === 'markdown_to_hwpx' && !params.output && !params.output_path && !params.outputPath) {
            params.output = '작업공간/output.hwpx';
        }
        if (toolName === 'parse_table' && params.table_index === undefined) {
            params.table_index = 0;
        }
        if (toolName === 'parse_pages' && !params.pages) {
            params.pages = '1';
        }
        if (toolName === 'list_directory' && !params.path) {
            params.path = '작업공간';
        }
        if (toolName === 'fill_form' && !params.output_path && !params.output && !params.outputPath) {
            params.output_path = '작업공간/filled_form.pdf';
        }
        if (toolName === 'search_file' && params.query === undefined) {
            params.query = '';
        }
        if (toolName === 'write_file' && !params.path) {
            params.path = '작업공간/output.txt';
        }
        
        return {
            index: idx,
            id,
            type: 'function',
            function: {
                name: toolName,
                arguments: JSON.stringify(params)
            }
        };
    });
}

function fixAssistantToolCallContent(text) {
    if (typeof text !== 'string') return text;

    // 1. ```json ... ``` 또는 ``` ... ``` 블록을 찾아서 내부 텍스트 추출, 수정 및 ```json 으로 통합
    const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/g;
    let modified = text.replace(codeBlockRegex, (match, jsonText) => {
        const trimmedJson = jsonText.trim();
        try {
            const parsed = JSON.parse(trimmedJson);
            const isValid = (Array.isArray(parsed) && parsed.length > 0 && (parsed[0].tool_name || parsed[0].tool_call || parsed[0].tool)) ||
                            (parsed && typeof parsed === 'object' && (parsed.tool_name || parsed.tool_call || parsed.tool));
            if (isValid) {
                let fixedJsonText = tryFixJsonString(trimmedJson);
                if (!fixedJsonText) {
                    const normalized = normalizeParsedObject(parsed);
                    fixedJsonText = JSON.stringify(normalized, null, 2);
                }
                return `\`\`\`json\n${fixedJsonText}\n\`\`\``;
            }
        } catch (e) {}
        return match;
    });

    // 2. 만약 코드블록이 없어도 단독 JSON 형태가 있으면 시도하여 ```json 블록으로 포장
    if (modified === text) {
        const trimmed = text.trim();
        try {
            const parsed = JSON.parse(trimmed);
            const isValid = (Array.isArray(parsed) && parsed.length > 0 && (parsed[0].tool_name || parsed[0].tool_call || parsed[0].tool)) ||
                            (parsed && typeof parsed === 'object' && (parsed.tool_name || parsed.tool_call || parsed.tool));
            if (isValid) {
                let fixedJsonText = tryFixJsonString(trimmed);
                if (!fixedJsonText) {
                    const normalized = normalizeParsedObject(parsed);
                    fixedJsonText = JSON.stringify(normalized, null, 2);
                }
                writeDebugLog(`[Bridge Patch] Wrapped raw JSON tool call into markdown code block.`);
                modified = `\`\`\`json\n${fixedJsonText}\n\`\`\``;
            }
        } catch (e) {}
    }

    // 3. 만약 대괄호로 감싸진 단독 단어 형태가 있으면 (예: [list_directory])
    // 이를 적절한 기본 파라미터를 가진 JSON 형태의 도구 호출로 변환
    if (modified === text) {
        const simpleBracketRegex = /^\s*\[([a-zA-Z0-9_]+)\]\s*$/;
        const bracketMatch = modified.match(simpleBracketRegex);
        if (bracketMatch) {
            const toolName = bracketMatch[1];
            const validTools = [
                'parse_document', 'parse_pages', 'parse_table', 'compare_documents', 
                'fill_form', 'markdown_to_hwpx', 'read_text_file', 'write_file', 
                'list_directory', 'get_file_info', 'search_file'
            ];
            if (validTools.includes(toolName)) {
                let defaultParams = {};
                if (toolName === 'list_directory') {
                    defaultParams = { path: '작업공간' };
                } else if (toolName === 'search_file') {
                    defaultParams = { query: '' };
                } else if (toolName === 'read_text_file' || toolName === 'get_file_info') {
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
                
                // If it already has native tool calls, do not modify
                if (parsed.choices[0].message.tool_calls) {
                    return body;
                }
                
                const toolCalls = extractToolCalls(originalContent);
                if (toolCalls) {
                    writeDebugLog(`[Bridge Patch] Converted markdown tool call to native tool_calls in non-stream response.`);
                    parsed.choices[0].message.content = null;
                    parsed.choices[0].message.tool_calls = convertToNativeToolCalls(toolCalls);
                    parsed.choices[0].finish_reason = "tool_calls";
                    return JSON.stringify(parsed);
                }
                
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
            let hasNativeToolCalls = false;
            
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
                    try {
                        const parsedEvent = JSON.parse(trimmed.substring(6));
                        if (parsedEvent.choices && parsedEvent.choices[0]) {
                            const delta = parsedEvent.choices[0].delta;
                            if (delta) {
                                if (delta.content) {
                                    fullContent += delta.content;
                                }
                                if (delta.tool_calls) {
                                    hasNativeToolCalls = true;
                                }
                            }
                            lastEventObj = parsedEvent;
                        }
                    } catch (e) {}
                }
            }
            
            if (hasNativeToolCalls) {
                return body;
            }
            
            const toolCalls = extractToolCalls(fullContent);
            if (toolCalls && lastEventObj) {
                writeDebugLog(`[Bridge Patch] Converted streamed markdown tool call to native tool_calls.`);
                lastEventObj.choices[0].delta = {
                    role: "assistant",
                    content: null,
                    tool_calls: convertToNativeToolCalls(toolCalls)
                };
                lastEventObj.choices[0].finish_reason = "tool_calls";
                
                const newStream = [
                    `data: ${JSON.stringify(lastEventObj)}`,
                    `data: [DONE]`,
                    ``
                ].join('\n\n');
                return newStream;
            }
            
            const fixedContent = fixAssistantToolCallContent(fullContent);
            if (lastEventObj) {
                const isFixed = fullContent !== fixedContent;
                writeDebugLog(`[Bridge Patch] Streamed completion unified. Fixed=${isFixed}. Length: ${fullContent.length} -> ${fixedContent.length}`);
                lastEventObj.choices[0].delta = { role: "assistant", content: fixedContent };
                lastEventObj.choices[0].finish_reason = "stop";
                
                const newStream = [
                    `data: ${JSON.stringify(lastEventObj)}`,
                    `data: [DONE]`,
                    ``
                ].join('\n\n');
                return newStream;
            }
        } catch (e) {
            writeDebugLog(`[Bridge Patch Error] Failed to parse stream body: ${e.message}`);
        }
        return body;
    }
}

module.exports = {
    fixAssistantToolCallContent,
    patchCompletionsResponseBody
};
