const { writeDebugLog } = require('./globals');

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
