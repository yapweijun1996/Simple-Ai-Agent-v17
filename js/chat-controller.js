/**
 * ./js/chat-controller.js
 * Chat Controller Module - Manages chat history and message handling
 * Coordinates between UI and API service for sending/receiving messages
 */
const ChatController = (function() {
    'use strict';

    // Private state
    const state = {
        chatHistory: [],
        totalTokens: 0,
        settings: { streaming: false, enableCoT: false, showThinking: true },
        isThinking: false,
        lastThinkingContent: '',
        lastAnswerContent: '',
        readSnippets: [],
        lastToolCall: null,
        lastToolCallCount: 0,
        MAX_TOOL_CALL_REPEAT: 3,
        lastSearchResults: [],
        autoReadInProgress: false,
        toolCallHistory: [],
        highlightedResultIndices: new Set(),
        readCache: new Map(),
        originalUserQuestion: '',
        toolWorkflowActive: true,
        currentPlan: [],
        planStatus: 'idle'
    };

    // Debug logging helper
    function debugLog(...args) {
        if (state.settings && state.settings.debug) {
            console.log('[AI-DEBUG]', ...args);
        }
    }

    // Add helper to robustly extract JSON tool calls using delimiters and schema validation
    function extractToolCall(text) {
        // Prefer tool call wrapped in unique delimiters
        const match = text.match(/\[\[TOOLCALL\]\]([\s\S]*?)\[\[\/TOOLCALL\]\]/);
        let jsonStr = null;
        if (match) {
            jsonStr = match[1];
        } else {
            // Fallback: try to extract the first JSON object in the text
            const jsonMatch = text.match(/\{[\s\S]*?\}/);
            if (jsonMatch && jsonMatch[0].trim().startsWith('{"tool":')) {
                jsonStr = jsonMatch[0];
                // Attempt to auto-close if braces are unbalanced
                const openCount = (jsonStr.match(/\{/g) || []).length;
                const closeCount = (jsonStr.match(/\}/g) || []).length;
                if (openCount > closeCount) {
                    jsonStr += '}'.repeat(openCount - closeCount);
                }
            } else {
                // Not a tool call, skip
                return null;
            }
        }
        if (!jsonStr) return null;
        let obj;
        try {
            obj = JSON.parse(jsonStr);
        } catch (err) {
            // Only log if debug is enabled
            if (state.settings && state.settings.debug) {
                console.warn('Tool JSON parse error:', err, 'from', jsonStr);
            }
            return null;
        }
        if (typeof obj === 'object' && typeof obj.tool === 'string' && typeof obj.arguments === 'object') {
            return obj;
        }
        return null;
    }

    const cotPreamble = `**Chain of Thought Instructions:**
1.  **Understand:** Briefly rephrase the core problem or question.
2.  **Plan:** Outline your plan step by step (e.g., "I will first web search for X, then read Y if needed...").
3.  **Narrate:** For each step, narrate your action before making a tool call (e.g., "Let me search for...").
4.  **Execute & Explain:** After each tool result, explain what you learned and decide the next step.
5.  **Synthesize:** Combine the findings from the previous steps to formulate the final conclusion.
6.  **Final Answer:** State the final answer clearly and concisely, prefixed exactly with "\nFinal Answer:".

**Important:** Always narrate your plan and actions before using any tool. After each tool call, explain your reasoning and next step. Do NOT output multiple tool calls in a row without narration. Be transparent and conversational, like a thoughtful human assistant.

Begin Reasoning Now:
`;

    // Tool handler registry
    const toolHandlers = {
        web_search: async function(args) {
            debugLog('Tool: web_search', args);
            if (!args.query || typeof args.query !== 'string' || !args.query.trim()) {
                UIController.addMessage('ai', 'Error: Invalid web_search query.');
                return;
            }
            const engine = args.engine || 'duckduckgo';
            const userQuestion = state.originalUserQuestion || args.query;
            let queriesTried = [args.query];
            let allResults = [];
            let lastResults = [];
            let attempts = 0;
            const MAX_ATTEMPTS = 3;
            while (attempts < MAX_ATTEMPTS) {
                UIController.showSpinner(`Searching (${engine}) for "${queriesTried[attempts]}"...`, getAgentDetails());
                UIController.showStatus(`Searching (${engine}) for "${queriesTried[attempts]}"...`, getAgentDetails());
                let results = [];
                try {
                    const streamed = [];
                    results = await ToolsService.webSearch(queriesTried[attempts], (result) => {
                        streamed.push(result);
                        // Pass highlight flag if this index is in highlightedResultIndices
                        const idx = streamed.length - 1;
                        UIController.addSearchResult(result, (url) => {
                            processToolCall({ tool: 'read_url', arguments: { url, start: 0, length: 1122 } });
                        }, state.highlightedResultIndices.has(idx));
                    }, engine);
                    debugLog(`Web search results for query [${queriesTried[attempts]}]:`, results);
                } catch (err) {
                    UIController.hideSpinner();
                    UIController.addMessage('ai', `Web search failed: ${err.message}`);
                    state.chatHistory.push({ role: 'assistant', content: `Web search failed: ${err.message}` });
                    break;
                }
                allResults = allResults.concat(results);
                lastResults = results;
                // If good results, break
                if (results.length >= 3 || attempts === MAX_ATTEMPTS - 1) break;
                // Ask AI for a better query
                let betterQuery = null;
                try {
                    const selectedModel = SettingsController.getSettings().selectedModel;
                    let aiReply = '';
                    const prompt = `The initial web search for the user question did not yield enough relevant results.\n\nUser question: ${userQuestion}\nInitial query: ${queriesTried[attempts]}\nSearch results (titles and snippets):\n${results.map((r, i) => `${i+1}. ${r.title} - ${r.snippet}`).join('\n')}\n\nSuggest a better search query to find more relevant information. Reply with only the improved query, or repeat the previous query if no better query is possible.`;
                    if (selectedModel.startsWith('gpt')) {
                        const res = await ApiService.sendOpenAIRequest(selectedModel, [
                            { role: 'system', content: 'You are an assistant that helps improve web search queries.' },
                            { role: 'user', content: prompt }
                        ]);
                        aiReply = res.choices[0].message.content.trim();
                    } else if (selectedModel.startsWith('gemini') || selectedModel.startsWith('gemma')) {
                        const session = ApiService.createGeminiSession(selectedModel);
                        const chatHistory = [
                            { role: 'system', content: 'You are an assistant that helps improve web search queries.' },
                            { role: 'user', content: prompt }
                        ];
                        const result = await session.sendMessage(prompt, chatHistory);
                        const candidate = result.candidates[0];
                        if (candidate.content.parts) {
                            aiReply = candidate.content.parts.map(p => p.text).join(' ').trim();
                        } else if (candidate.content.text) {
                            aiReply = candidate.content.text.trim();
                        }
                    }
                    debugLog('AI suggested improved query:', aiReply);
                    if (aiReply && !queriesTried.includes(aiReply)) {
                        queriesTried.push(aiReply);
                    } else {
                        break; // No better query or repeated, stop
                    }
                } catch (err) {
                    debugLog('Error getting improved query from AI:', err);
                    break;
                }
                attempts++;
            }
            UIController.hideSpinner();
            UIController.clearStatus();
            if (!allResults.length) {
                UIController.addMessage('ai', `No search results found for "${args.query}" after ${attempts+1} attempts.`);
            }
            // Remove duplicate results by URL
            const uniqueResults = [];
            const seenUrls = new Set();
            debugLog({ step: 'deduplication', before: allResults });
            for (const r of allResults) {
                if (!seenUrls.has(r.url)) {
                    uniqueResults.push(r);
                    seenUrls.add(r.url);
                }
            }
            debugLog({ step: 'deduplication', after: uniqueResults });
            const plainTextResults = uniqueResults.map((r, i) => `${i+1}. ${r.title} (${r.url}) - ${r.snippet}`).join('\n');
            state.chatHistory.push({ role: 'assistant', content: `Search results for "${args.query}" (total ${uniqueResults.length}):\n${plainTextResults}` });
            state.lastSearchResults = uniqueResults;
            debugLog({ step: 'suggestResultsToRead', results: uniqueResults });
            // Prompt AI to suggest which results to read
            await suggestResultsToRead(uniqueResults, args.query);
        },
        read_url: async function(args) {
            debugLog('Tool: read_url', args);
            if (!args.url || typeof args.url !== 'string' || !/^https?:\/\//.test(args.url)) {
                UIController.addMessage('ai', 'Error: Invalid read_url argument.');
                return;
            }
            UIController.showSpinner(`Reading content from ${args.url}...`, getAgentDetails());
            UIController.showStatus(`Reading content from ${args.url}...`, getAgentDetails());
            try {
                const result = await ToolsService.readUrl(args.url);
                const start = (typeof args.start === 'number' && args.start >= 0) ? args.start : 0;
                const length = (typeof args.length === 'number' && args.length > 0) ? args.length : 1122;
                const snippet = String(result).slice(start, start + length);
                const hasMore = (start + length) < String(result).length;
                UIController.addReadResult(args.url, snippet, hasMore);
                const plainTextSnippet = `Read content from ${args.url}:\n${snippet}${hasMore ? '...' : ''}`;
                state.chatHistory.push({ role: 'assistant', content: plainTextSnippet });
                // Collect snippets for summarization
                state.readSnippets.push(snippet);
                // (Manual summarization removed: summarization now only happens in auto-read workflow)
            } catch (err) {
                UIController.hideSpinner();
                UIController.addMessage('ai', `Read URL failed: ${err.message}`);
                state.chatHistory.push({ role: 'assistant', content: `Read URL failed: ${err.message}` });
            }
            UIController.hideSpinner();
            UIController.clearStatus();
        },
        instant_answer: async function(args) {
            debugLog('Tool: instant_answer', args);
            if (!args.query || typeof args.query !== 'string' || !args.query.trim()) {
                UIController.addMessage('ai', 'Error: Invalid instant_answer query.');
                return;
            }
            UIController.showStatus(`Retrieving instant answer for "${args.query}"...`, getAgentDetails());
            try {
                const result = await ToolsService.instantAnswer(args.query);
                const text = JSON.stringify(result, null, 2);
                UIController.addMessage('ai', text);
                state.chatHistory.push({ role: 'assistant', content: text });
            } catch (err) {
                UIController.clearStatus();
                UIController.addMessage('ai', `Instant answer failed: ${err.message}`);
                state.chatHistory.push({ role: 'assistant', content: `Instant answer failed: ${err.message}` });
            }
            UIController.clearStatus();
        }
    };

    /**
     * Initializes the chat controller
     * @param {Object} initialSettings - Initial settings for the chat
     */
    function init(initialSettings) {
        // Reset and seed chatHistory with system tool instructions
        state.chatHistory = [{
            role: 'system',
            content: `You are an AI assistant with access to three external tools. You MUST use these tools to answer any question that requires up-to-date facts, statistics, or detailed content. Do NOT attempt to answer such questions from your own knowledge. The tools are:

1. web_search(query) → returns a JSON array of search results [{title, url, snippet}, …]
2. read_url(url[, start, length]) → returns the text content of a web page from position 'start' (default 0) up to 'length' characters (default 1122)
3. instant_answer(query) → returns a JSON object from DuckDuckGo's Instant Answer API for quick facts, definitions, and summaries (no proxies needed)

**INSTRUCTIONS:**
- If you need information from the web, you MUST output a tool call as a single JSON object, and NOTHING else. Do NOT include any explanation, markdown, or extra text.
- After receiving a tool result, reason step by step (Chain of Thought) and decide if you need to call another tool. If so, output another tool call JSON. Only provide your final answer after all necessary tool calls are complete.
- If you need to read a web page, use read_url. If the snippet ends with an ellipsis ("..."), always determine if fetching more text will improve your answer. If so, output another read_url tool call with the same url, start at your previous offset, and length set to 5000. Repeat until you have enough content.
- If you do NOT know the answer, or are unsure, ALWAYS call a tool first.
- When calling a tool, output EXACTLY a JSON object and nothing else, in this format:
  {"tool":"web_search","arguments":{"query":"your query"}}
  {"tool":"read_url","arguments":{"url":"https://example.com","start":0,"length":1122}}
  {"tool":"instant_answer","arguments":{"query":"your query"}}
- Do NOT output any other text, markdown, or explanation with the tool call JSON.
- After receiving the tool result, continue reasoning step by step and then provide your answer.

**EXAMPLES:**
Q: What is the latest news about OpenAI?
A: {"tool":"web_search","arguments":{"query":"latest news about OpenAI"}}

Q: Read the content of https://example.com and summarize it.
A: {"tool":"read_url","arguments":{"url":"https://example.com","start":0,"length":1122}}

Q: What is the capital of France?
A: {"tool":"instant_answer","arguments":{"query":"capital of France"}}

If you understand, follow these instructions for every relevant question. Do NOT answer from your own knowledge if a tool call is needed. Wait for the tool result before continuing.`,
        }];
        if (initialSettings) {
            state.settings = { ...state.settings, ...initialSettings };
        }
        
        // Set up event handlers through UI controller
        UIController.setupEventHandlers(sendMessage, clearChat);
    }

    /**
     * Updates the settings
     * @param {Object} newSettings - The new settings
     */
    function updateSettings(newSettings) {
        state.settings = { ...state.settings, ...newSettings };
        console.log('Chat settings updated:', state.settings);
    }

    /**
     * Clears the chat history and resets token count
     */
    function clearChat() {
        state.chatHistory = [];
        state.totalTokens = 0;
        Utils.updateTokenDisplay(0);
    }

    /**
     * Gets the current settings
     * @returns {Object} - The current settings
     */
    function getSettings() {
        return { ...state.settings };
    }

    /**
     * Generates Chain of Thought prompting instructions
     * @param {string} message - The user message
     * @returns {string} - The CoT enhanced message
     */
    function enhanceWithCoT(message) {
        return `Please first output a numbered plan for how you will answer this question (as a numbered list at the top), then proceed step by step. ${message}\n\nI'd like you to use Chain of Thought reasoning. Please think step-by-step before providing your final answer. Format your response like this:\nThinking: [detailed reasoning process, exploring different angles and considerations]\nAnswer: [your final, concise answer based on the reasoning above]`;
    }

    // 2. Merge processCoTResponse and processPartialCoTResponse into parseCoTResponse
    function parseCoTResponse(response, isPartial = false) {
        const thinkingMatch = response.match(/Thinking:(.*?)(?=Answer:|$)/s);
        const answerMatch = response.match(/Answer:(.*?)$/s);
        if (thinkingMatch && answerMatch) {
            state.lastThinkingContent = thinkingMatch[1].trim();
            state.lastAnswerContent = answerMatch[1].trim();
            return {
                thinking: state.lastThinkingContent,
                answer: state.lastAnswerContent,
                hasStructuredResponse: true,
                partial: isPartial,
                stage: isPartial && !answerMatch[1].trim() ? 'thinking' : undefined
            };
        } else if (response.startsWith('Thinking:') && !response.includes('Answer:')) {
            state.lastThinkingContent = response.replace(/^Thinking:/, '').trim();
            return {
                thinking: state.lastThinkingContent,
                answer: state.lastAnswerContent,
                hasStructuredResponse: true,
                partial: true,
                stage: 'thinking'
            };
        } else if (response.includes('Thinking:') && !thinkingMatch) {
            const thinking = response.replace(/^.*?Thinking:/s, 'Thinking:');
            return {
                thinking: thinking.replace(/^Thinking:/, '').trim(),
                answer: '',
                hasStructuredResponse: false,
                partial: true
            };
        }
        return {
            thinking: '',
            answer: response,
            hasStructuredResponse: false
        };
    }

    /**
     * Formats the response for display based on settings
     * @param {Object} processed - The processed response with thinking and answer
     * @returns {string} - The formatted response for display
     */
    function formatResponseForDisplay(processed) {
        if (!state.settings.enableCoT || !processed.hasStructuredResponse) {
            return processed.answer;
        }

        // If showThinking is enabled, show both thinking and answer
        if (state.settings.showThinking) {
            if (processed.partial && processed.stage === 'thinking') {
                return `Thinking: ${processed.thinking}`;
            } else if (processed.partial) {
                return processed.thinking; // Just the partial thinking
            } else {
                return `Thinking: ${processed.thinking}\n\nAnswer: ${processed.answer}`;
            }
        } else {
            // Otherwise just show the answer (or thinking indicator if answer isn't ready)
            return processed.answer || '🤔 Thinking...';
        }
    }

    // Helper: Validate user input
    function isValidUserInput(message) {
        return typeof message === 'string' && message.trim().length > 0;
    }

    // Helper: Set UI input state (enabled/disabled)
    function setInputState(enabled) {
        document.getElementById('message-input').disabled = !enabled;
        document.getElementById('send-button').disabled = !enabled;
    }

    // Helper: Prepare message for sending (CoT, etc.)
    function prepareMessage(message) {
        return state.settings.enableCoT ? enhanceWithCoT(message) : message;
    }

    // Refactored sendMessage
    async function sendMessage() {
        const message = UIController.getUserInput();
        if (!isValidUserInput(message)) return;
        debugLog("User query:", message);
        state.originalUserQuestion = message;
        state.toolWorkflowActive = true;

        // Clear previous plan when starting a new message
        clearPlan();

        UIController.showStatus('Sending message...', getAgentDetails());
        setInputState(false);

        state.lastThinkingContent = '';
        state.lastAnswerContent = '';

        UIController.addMessage('user', message);
        UIController.clearUserInput();

        const enhancedMessage = prepareMessage(message);
        const currentSettings = SettingsController.getSettings();
        const selectedModel = currentSettings.selectedModel;

        try {
            if (selectedModel.startsWith('gpt')) {
                state.chatHistory.push({ role: 'user', content: enhancedMessage });
                debugLog("Sent enhanced message to GPT:", enhancedMessage);
                // Intercept the first AI response to extract plan
                await handleOpenAIMessageWithPlan(selectedModel, enhancedMessage);
            } else if (selectedModel.startsWith('gemini') || selectedModel.startsWith('gemma')) {
                if (state.chatHistory.length === 0) {
                    state.chatHistory.push({ role: 'user', content: '' });
                }
                await handleGeminiMessageWithPlan(selectedModel, enhancedMessage);
            }
        } catch (error) {
            let userMessage = 'Error: ' + error.message;
            if (error.message && error.message.includes('Failed to fetch')) {
                userMessage += '\nPossible causes: network issue, CORS restriction, invalid API key, the API endpoint is down, or a proxy server is blocked.';
                userMessage += '\n\nTroubleshooting tips:';
                userMessage += '\n- Check your internet connection.';
                userMessage += '\n- Make sure your API key is valid and not expired.';
                userMessage += '\n- Try disabling browser extensions (ad blockers, privacy tools).';
                userMessage += '\n- Check the browser console Network tab for CORS or HTTP errors.';
                userMessage += '\n- Try a different network or device.';
            }
            UIController.showError(userMessage);
            UIController.addMessage('ai', userMessage);
            console.error('Error sending message:', error);
        } finally {
            Utils.updateTokenDisplay(state.totalTokens);
            UIController.clearStatus();
            setInputState(true);
        }
    }

    // 3. Extract shared helpers for streaming/non-streaming response handling
    async function handleStreamingResponse({ model, aiMsgElement, streamFn, onToolCall }) {
        let streamedResponse = '';
        try {
            if (state.settings.enableCoT) {
                state.isThinking = true;
                UIController.updateMessageContent(aiMsgElement, '🤔 Thinking...');
            }
            const fullReply = await streamFn(
                model,
                state.chatHistory,
                (chunk, fullText) => {
                    streamedResponse = fullText;
                    if (state.settings.enableCoT) {
                        const processed = parseCoTResponse(fullText, true);
                        if (state.isThinking && fullText.includes('Answer:')) {
                            state.isThinking = false;
                        }
                        const displayText = formatResponseForDisplay(processed);
                        if (state.currentPlan && state.currentPlan.length > 0) {
                            const idx = state.currentPlan.findIndex(s => s.status === 'in-progress');
                            if (idx !== -1 && processed.thinking) {
                                updatePlanStepStatus(idx, state.currentPlan[idx].status, state.currentPlan[idx].details, processed.thinking);
                            }
                        }
                        if (isPlanMessage(displayText)) {
                            UIController.addMessage('ai', displayText, 'plan');
                        } else {
                            UIController.updateMessageContent(aiMsgElement, displayText);
                        }
                    } else {
                        UIController.updateMessageContent(aiMsgElement, fullText);
                    }
                }
            );
            const toolCall = extractToolCall(fullReply);
            if (toolCall && toolCall.tool && toolCall.arguments) {
                await onToolCall(toolCall);
                return;
            }
            if (state.settings.enableCoT) {
                const processed = parseCoTResponse(fullReply);
                if (processed.thinking) {
                    debugLog('AI Thinking:', processed.thinking);
                }
                const displayText = formatResponseForDisplay(processed);
                if (state.currentPlan && state.currentPlan.length > 0) {
                    const idx = state.currentPlan.findIndex(s => s.status === 'in-progress');
                    if (idx !== -1 && processed.thinking) {
                        updatePlanStepStatus(idx, state.currentPlan[idx].status, state.currentPlan[idx].details, processed.thinking);
                    }
                }
                if (isPlanMessage(displayText)) {
                    UIController.addMessage('ai', displayText, 'plan');
                } else {
                    UIController.updateMessageContent(aiMsgElement, displayText);
                }
                state.chatHistory.push({ role: 'assistant', content: fullReply });
            } else {
                state.chatHistory.push({ role: 'assistant', content: fullReply });
            }
            const tokenCount = await ApiService.getTokenUsage(model, state.chatHistory);
            if (tokenCount) {
                state.totalTokens += tokenCount;
            }
        } catch (err) {
            UIController.updateMessageContent(aiMsgElement, 'Error: ' + err.message);
            throw err;
        } finally {
            state.isThinking = false;
            // Always re-enable message input
            UIController.hideSpinner();
            UIController.clearStatus();
            UIController.enableMessageInput && UIController.enableMessageInput();
        }
    }

    async function handleNonStreamingResponse({ model, requestFn, onToolCall }) {
        UIController.showStatus('Waiting for AI response...', getAgentDetails());
        try {
            const result = await requestFn(model, state.chatHistory);
            if (result.error) {
                throw new Error(result.error.message);
            }
            if (result.usage && result.usage.total_tokens) {
                state.totalTokens += result.usage.total_tokens;
            }
            const reply = result.choices[0].message.content;
            const toolCall = extractToolCall(reply);
            if (toolCall && toolCall.tool && toolCall.arguments) {
                await onToolCall(toolCall);
                return;
            }
            if (state.settings.enableCoT) {
                const processed = parseCoTResponse(reply);
                if (processed.thinking) {
                    debugLog('AI Thinking:', processed.thinking);
                }
                if (state.currentPlan && state.currentPlan.length > 0) {
                    const idx = state.currentPlan.findIndex(s => s.status === 'in-progress');
                    if (idx !== -1 && processed.thinking) {
                        updatePlanStepStatus(idx, state.currentPlan[idx].status, state.currentPlan[idx].details, processed.thinking);
                    }
                }
                state.chatHistory.push({ role: 'assistant', content: reply });
                const displayText = formatResponseForDisplay(processed);
                if (isPlanMessage(displayText)) {
                    UIController.addMessage('ai', displayText, 'plan');
                } else {
                    UIController.addMessage('ai', displayText);
                }
            } else {
                state.chatHistory.push({ role: 'assistant', content: reply });
                UIController.addMessage('ai', reply);
            }
        } catch (err) {
            throw err;
        } finally {
            // Always re-enable message input
            UIController.hideSpinner();
            UIController.clearStatus();
            UIController.enableMessageInput && UIController.enableMessageInput();
        }
    }

    // Helper: handleOpenAIMessage with plan extraction
    async function handleOpenAIMessageWithPlan(model, message) {
        let planDetected = false;
        if (state.settings.streaming) {
            UIController.showStatus('Streaming response...', getAgentDetails());
            const aiMsgElement = UIController.createEmptyAIMessage();
            let firstPlanExtracted = false;
            await handleStreamingResponse({
                model,
                aiMsgElement,
                streamFn: ApiService.streamOpenAIRequest,
                onToolCall: processToolCall,
                onChunk: (chunk, fullText) => {
                    if (!firstPlanExtracted && fullText) {
                        const planSteps = extractPlanFromText(fullText);
                        if (planSteps.length > 0) {
                            setPlan(planSteps);
                            firstPlanExtracted = true;
                            planDetected = true;
                        }
                    }
                }
            });
        } else {
            // Non-streaming: extract plan from full reply
            const result = await ApiService.sendOpenAIRequest(model, state.chatHistory);
            if (result.error) throw new Error(result.error.message);
            if (result.usage && result.usage.total_tokens) {
                state.totalTokens += result.usage.total_tokens;
            }
            const reply = result.choices[0].message.content;
            const planSteps = extractPlanFromText(reply);
            if (planSteps.length > 0) {
                setPlan(planSteps);
                planDetected = true;
            }
            // Continue with normal handling
            await handleNonStreamingResponse({ model, requestFn: async () => result, onToolCall: processToolCall });
        }
        // User feedback if no plan detected
        if (!planDetected) {
            UIController.showStatus('No plan detected in AI response.', getAgentDetails());
        }
    }

    // Helper: handleGeminiMessage with plan extraction
    async function handleGeminiMessageWithPlan(model, message) {
        state.chatHistory.push({ role: 'user', content: message });
        let planDetected = false;
        if (state.settings.streaming) {
            const aiMsgElement = UIController.createEmptyAIMessage();
            let firstPlanExtracted = false;
            await handleStreamingResponse({
                model,
                aiMsgElement,
                streamFn: ApiService.streamGeminiRequest,
                onToolCall: processToolCall,
                onChunk: (chunk, fullText) => {
                    if (!firstPlanExtracted && fullText) {
                        const planSteps = extractPlanFromText(fullText);
                        if (planSteps.length > 0) {
                            setPlan(planSteps);
                            firstPlanExtracted = true;
                            planDetected = true;
                        }
                    }
                }
            });
        } else {
            // Non-streaming: extract plan from full reply
            const session = ApiService.createGeminiSession(model);
            const result = await session.sendMessage(message, state.chatHistory);
            if (result.usageMetadata && typeof result.usageMetadata.totalTokenCount === 'number') {
                state.totalTokens += result.usageMetadata.totalTokenCount;
            }
            const candidate = result.candidates[0];
            let textResponse = '';
            if (candidate.content.parts) {
                textResponse = candidate.content.parts.map(p => p.text).join(' ');
            } else if (candidate.content.text) {
                textResponse = candidate.content.text;
            }
            const planSteps = extractPlanFromText(textResponse);
            if (planSteps.length > 0) {
                setPlan(planSteps);
                planDetected = true;
            }
            // Continue with normal handling
            await handleGeminiNonStreaming(model, message);
        }
        // User feedback if no plan detected
        if (!planDetected) {
            UIController.showStatus('No plan detected in AI response.', getAgentDetails());
        }
    }

    // Helper: Handle non-streaming Gemini response
    async function handleGeminiNonStreaming(model, message) {
        try {
            const session = ApiService.createGeminiSession(model);
            const result = await session.sendMessage(message, state.chatHistory);
            if (result.usageMetadata && typeof result.usageMetadata.totalTokenCount === 'number') {
                state.totalTokens += result.usageMetadata.totalTokenCount;
            }
            const candidate = result.candidates[0];
            let textResponse = '';
            if (candidate.content.parts) {
                textResponse = candidate.content.parts.map(p => p.text).join(' ');
            } else if (candidate.content.text) {
                textResponse = candidate.content.text;
            }
            const toolCall = extractToolCall(textResponse);
            if (toolCall && toolCall.tool && toolCall.arguments) {
                await processToolCall(toolCall);
                return;
            }
            if (state.settings.enableCoT) {
                const processed = parseCoTResponse(textResponse);
                if (processed.thinking) {
                    debugLog('AI Thinking:', processed.thinking);
                }
                state.chatHistory.push({ role: 'assistant', content: textResponse });
                const displayText = formatResponseForDisplay(processed);
                if (isPlanMessage(displayText)) {
                    UIController.addMessage('ai', displayText, 'plan');
                } else {
                    UIController.addMessage('ai', displayText);
                }
            } else {
                state.chatHistory.push({ role: 'assistant', content: textResponse });
                UIController.addMessage('ai', textResponse);
            }
        } catch (err) {
            throw err;
        } finally {
            // Always re-enable message input
            UIController.hideSpinner();
            UIController.clearStatus();
            UIController.enableMessageInput && UIController.enableMessageInput();
        }
    }

    // Enhanced processToolCall using registry and validation
    async function processToolCall(call) {
        debugLog('processToolCall', call);
        if (!state.toolWorkflowActive) return;
        const { tool, arguments: args, skipContinue } = call;
        // Tool call loop protection
        const callSignature = JSON.stringify({ tool, args });
        if (state.lastToolCall === callSignature) {
            state.lastToolCallCount++;
        } else {
            state.lastToolCall = callSignature;
            state.lastToolCallCount = 1;
        }
        if (state.lastToolCallCount > state.MAX_TOOL_CALL_REPEAT) {
            UIController.addMessage('ai', `Error: Tool call loop detected. The same tool call has been made more than ${state.MAX_TOOL_CALL_REPEAT} times in a row. Stopping to prevent infinite loop.`);
            return;
        }
        // Log tool call
        state.toolCallHistory.push({ tool, args, timestamp: new Date().toISOString() });
        await toolHandlers[tool](args);
        // Only continue reasoning if the last AI reply was NOT a tool call
        if (!skipContinue) {
            const lastEntry = state.chatHistory[state.chatHistory.length - 1];
            let isToolCall = false;
            if (lastEntry && typeof lastEntry.content === 'string') {
                try {
                    const parsed = JSON.parse(lastEntry.content);
                    if (parsed.tool && parsed.arguments) {
                        isToolCall = true;
                    }
                } catch {}
            }
            if (!isToolCall) {
                const selectedModel = SettingsController.getSettings().selectedModel;
                if (selectedModel.startsWith('gpt')) {
                    await handleOpenAIMessage(selectedModel, '');
                } else {
                    await handleGeminiMessage(selectedModel, '');
                }
            } else {
                UIController.addMessage('ai', 'Warning: AI outputted another tool call without reasoning. Stopping to prevent infinite loop.');
            }
        }
    }

    /**
     * Gets the current chat history
     * @returns {Array} - The chat history
     */
    function getChatHistory() {
        return [...state.chatHistory];
    }

    /**
     * Gets the total tokens used
     * @returns {number} - The total tokens used
     */
    function getTotalTokens() {
        return state.totalTokens;
    }

    // Helper: AI-driven deep reading for a URL
    async function deepReadUrl(url, maxChunks = 5, chunkSize = 2000, maxTotalLength = 10000) {
        let allChunks = [];
        let start = 0;
        let shouldContinue = true;
        let chunkCount = 0;
        let totalLength = 0;
        while (shouldContinue && chunkCount < maxChunks && totalLength < maxTotalLength) {
            // Check cache first
            const cacheKey = `${url}:${start}:${chunkSize}`;
            let snippet;
            if (state.readCache.has(cacheKey)) {
                snippet = state.readCache.get(cacheKey);
            } else {
                await processToolCall({ tool: 'read_url', arguments: { url, start, length: chunkSize }, skipContinue: true });
                // Find the last snippet added to chatHistory
                const lastEntry = state.chatHistory[state.chatHistory.length - 1];
                if (lastEntry && typeof lastEntry.content === 'string' && lastEntry.content.startsWith('Read content from')) {
                    snippet = lastEntry.content.split('\n').slice(1).join('\n');
                    state.readCache.set(cacheKey, snippet);
                } else {
                    snippet = '';
                }
            }
            if (!snippet) break;
            allChunks.push(snippet);
            totalLength += snippet.length;
            // Ask AI if more is needed
            const selectedModel = SettingsController.getSettings().selectedModel;
            let aiReply = '';
            try {
                const prompt = `Given the following snippet from ${url}, do you need more content to answer the user's question? Please reply with \"YES\" or \"NO\" and a brief reason. If YES, estimate how many more characters you need.\n\nSnippet:\n${snippet}`;
                if (selectedModel.startsWith('gpt')) {
                    const res = await ApiService.sendOpenAIRequest(selectedModel, [
                        { role: 'system', content: 'You are an assistant that decides if more content is needed from a web page.' },
                        { role: 'user', content: prompt }
                    ]);
                    aiReply = res.choices[0].message.content.trim().toLowerCase();
                }
            } catch (err) {
                // On error, stop deep reading
                shouldContinue = false;
                break;
            }
            if (aiReply.startsWith('yes') && totalLength < maxTotalLength) {
                start += chunkSize;
                chunkCount++;
                shouldContinue = true;
            } else {
                shouldContinue = false;
            }
        }
        return allChunks;
    }

    // Autonomous follow-up: after AI suggests which results to read, auto-read and summarize
    async function autoReadAndSummarizeFromSuggestion(aiReply) {
        debugLog('autoReadAndSummarizeFromSuggestion', aiReply);
        if (state.autoReadInProgress) return; // Prevent overlap
        if (!state.lastSearchResults || !Array.isArray(state.lastSearchResults) || !state.lastSearchResults.length) return;
        // Parse numbers from AI reply (e.g., "3,5,7,9,10")
        const match = aiReply.match(/([\d, ]+)/);
        if (!match) return;
        const nums = match[1].split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
        if (!nums.length) return;
        // Store highlighted indices (0-based)
        state.highlightedResultIndices = new Set(nums.map(n => n - 1));
        // Map numbers to URLs (1-based index)
        const urlsToRead = nums.map(n => state.lastSearchResults[n-1]?.url).filter(Boolean);
        debugLog({ step: 'autoReadAndSummarizeFromSuggestion', selectedUrls: urlsToRead });
        if (!urlsToRead.length) return;
        state.autoReadInProgress = true;
        try {
            for (let i = 0; i < urlsToRead.length; i++) {
                const url = urlsToRead[i];
                UIController.showSpinner(`Reading ${i + 1} of ${urlsToRead.length} URLs: ${url}...`, getAgentDetails());
                await deepReadUrl(url, 5, 2000);
            }
            // After all reads, auto-summarize
            await summarizeSnippets();
        } finally {
            state.autoReadInProgress = false;
        }
    }

    // Suggestion logic: ask AI which results to read
    async function suggestResultsToRead(results, query) {
        debugLog('suggestResultsToRead', { results, query });
        if (!results || results.length === 0) return;
        const prompt = `Given these search results for the query: "${query}", which results (by number) are most relevant to read in detail?\n\n${results.map((r, i) => `${i+1}. ${r.title} - ${r.snippet}`).join('\n')}\n\nReply with a comma-separated list of result numbers.`;
        const selectedModel = SettingsController.getSettings().selectedModel;
        let aiReply = '';
        try {
            if (selectedModel.startsWith('gpt')) {
                const res = await ApiService.sendOpenAIRequest(selectedModel, [
                    { role: 'system', content: 'You are an assistant helping to select the most relevant search results.' },
                    { role: 'user', content: prompt }
                ]);
                aiReply = res.choices[0].message.content.trim();
            } else if (selectedModel.startsWith('gemini') || selectedModel.startsWith('gemma')) {
                const session = ApiService.createGeminiSession(selectedModel);
                const chatHistory = [
                    { role: 'system', content: 'You are an assistant helping to select the most relevant search results.' },
                    { role: 'user', content: prompt }
                ];
                const result = await session.sendMessage(prompt, chatHistory);
                const candidate = result.candidates[0];
                if (candidate.content.parts) {
                    aiReply = candidate.content.parts.map(p => p.text).join(' ').trim();
                } else if (candidate.content.text) {
                    aiReply = candidate.content.text.trim();
                }
            }
            // Optionally, parse and highlight suggested results
            if (aiReply) {
                UIController.addMessage('ai', `AI suggests reading results: ${aiReply}`);
                // Autonomous follow-up: auto-read and summarize
                await autoReadAndSummarizeFromSuggestion(aiReply);
            }
        } catch (err) {
            // Ignore suggestion errors
        }
    }

    // Helper: Split array of strings into batches where each batch's total length <= maxLen
    function splitIntoBatches(snippets, maxLen) {
        const batches = [];
        let currentBatch = [];
        let currentLen = 0;
        for (const snippet of snippets) {
            if (currentLen + snippet.length > maxLen && currentBatch.length) {
                batches.push(currentBatch);
                currentBatch = [];
                currentLen = 0;
            }
            currentBatch.push(snippet);
            currentLen += snippet.length;
        }
        if (currentBatch.length) {
            batches.push(currentBatch);
        }
        return batches;
    }

    // Summarization logic (recursive, context-aware)
    async function summarizeSnippets(snippets = null, round = 1) {
        debugLog('summarizeSnippets', { snippets, round });
        if (!snippets) snippets = state.readSnippets;
        if (!snippets.length) return;
        const selectedModel = SettingsController.getSettings().selectedModel;
        const MAX_PROMPT_LENGTH = 5857; // chars, safe for most models
        const SUMMARIZATION_TIMEOUT = 88000; // 88 seconds
        // If only one snippet, just summarize it directly
        if (snippets.length === 1) {
            const prompt = `Summarize the following information extracted from web pages (be as concise as possible):\n\n${snippets[0]}`;
            let aiReply = '';
            UIController.showSpinner(`Round ${round}: Summarizing information...`, getAgentDetails());
            UIController.showStatus(`Round ${round}: Summarizing information...`, getAgentDetails());
            try {
                if (selectedModel.startsWith('gpt')) {
                    const res = await ApiService.sendOpenAIRequest(selectedModel, [
                        { role: 'system', content: 'You are an assistant that synthesizes information from multiple sources.' },
                        { role: 'user', content: prompt }
                    ], SUMMARIZATION_TIMEOUT);
                    aiReply = res.choices[0].message.content.trim();
                } else if (selectedModel.startsWith('gemini') || selectedModel.startsWith('gemma')) {
                    const session = ApiService.createGeminiSession(selectedModel);
                    const chatHistory = [
                        { role: 'system', content: 'You are an assistant that synthesizes information from multiple sources.' },
                        { role: 'user', content: prompt }
                    ];
                    const result = await session.sendMessage(prompt, chatHistory);
                    const candidate = result.candidates[0];
                    if (candidate.content.parts) {
                        aiReply = candidate.content.parts.map(p => p.text).join(' ').trim();
                    } else if (candidate.content.text) {
                        aiReply = candidate.content.text.trim();
                    }
                }
                if (aiReply) {
                    UIController.addMessage('ai', `Summary:\n${aiReply}`);
                }
            } catch (err) {
                UIController.addMessage('ai', `Summarization failed. Error: ${err && err.message ? err.message : err}`);
            }
            UIController.hideSpinner();
            UIController.clearStatus();
            state.readSnippets = [];
            // Prompt for final answer after summary
            await synthesizeFinalAnswer(aiReply);
            return;
        }
        // Otherwise, split into batches
        const batches = splitIntoBatches(snippets, MAX_PROMPT_LENGTH);
        let batchSummaries = [];
        const totalBatches = batches.length;
        try {
            for (let i = 0; i < totalBatches; i++) {
                const batch = batches[i];
                UIController.showSpinner(`Round ${round}: Summarizing batch ${i + 1} of ${totalBatches}...`, getAgentDetails());
                UIController.showStatus(`Round ${round}: Summarizing batch ${i + 1} of ${totalBatches}...`, getAgentDetails());
                const batchPrompt = `Summarize the following information extracted from web pages (be as concise as possible):\n\n${batch.join('\n---\n')}`;
                let batchReply = '';
                if (selectedModel.startsWith('gpt')) {
                    const res = await ApiService.sendOpenAIRequest(selectedModel, [
                        { role: 'system', content: 'You are an assistant that synthesizes information from multiple sources.' },
                        { role: 'user', content: batchPrompt }
                    ], SUMMARIZATION_TIMEOUT);
                    batchReply = res.choices[0].message.content.trim();
                } else if (selectedModel.startsWith('gemini') || selectedModel.startsWith('gemma')) {
                    const session = ApiService.createGeminiSession(selectedModel);
                    const chatHistory = [
                        { role: 'system', content: 'You are an assistant that synthesizes information from multiple sources.' },
                        { role: 'user', content: batchPrompt }
                    ];
                    const result = await session.sendMessage(batchPrompt, chatHistory);
                    const candidate = result.candidates[0];
                    if (candidate.content.parts) {
                        batchReply = candidate.content.parts.map(p => p.text).join(' ').trim();
                    } else if (candidate.content.text) {
                        batchReply = candidate.content.text.trim();
                    }
                }
                batchSummaries.push(batchReply);
            }
            // If the combined summaries are still too long, recursively summarize
            const combined = batchSummaries.join('\n---\n');
            if (combined.length > MAX_PROMPT_LENGTH) {
                UIController.showSpinner(`Round ${round + 1}: Combining summaries...`, getAgentDetails());
                UIController.showStatus(`Round ${round + 1}: Combining summaries...`, getAgentDetails());
                await summarizeSnippets(batchSummaries, round + 1);
            } else {
                UIController.showSpinner(`Round ${round}: Finalizing summary...`, getAgentDetails());
                UIController.showStatus(`Round ${round}: Finalizing summary...`, getAgentDetails());
                UIController.addMessage('ai', `Summary:\n${combined}`);
                // Prompt for final answer after all summaries
                await synthesizeFinalAnswer(combined);
            }
        } catch (err) {
            UIController.addMessage('ai', `Summarization failed. Error: ${err && err.message ? err.message : err}`);
        }
        UIController.hideSpinner();
        UIController.clearStatus();
        state.readSnippets = [];
    }

    // Add synthesizeFinalAnswer helper
    async function synthesizeFinalAnswer(summaries) {
        debugLog('synthesizeFinalAnswer', summaries);
        if (!summaries || !state.originalUserQuestion) return;
        const selectedModel = SettingsController.getSettings().selectedModel;
        const prompt = `Based on the following summaries, provide a final, concise answer to the original question.\n\nSummaries:\n${summaries}\n\nOriginal question: ${state.originalUserQuestion}`;
        try {
            let finalAnswer = '';
            if (selectedModel.startsWith('gpt')) {
                const res = await ApiService.sendOpenAIRequest(selectedModel, [
                    { role: 'system', content: 'You are an assistant that synthesizes information from multiple sources and provides a final answer.' },
                    { role: 'user', content: prompt }
                ]);
                finalAnswer = res.choices[0].message.content.trim();
            } else if (selectedModel.startsWith('gemini') || selectedModel.startsWith('gemma')) {
                const session = ApiService.createGeminiSession(selectedModel);
                const chatHistory = [
                    { role: 'system', content: 'You are an assistant that synthesizes information from multiple sources and provides a final answer.' },
                    { role: 'user', content: prompt }
                ];
                const result = await session.sendMessage(prompt, chatHistory);
                const candidate = result.candidates[0];
                if (candidate.content.parts) {
                    finalAnswer = candidate.content.parts.map(p => p.text).join(' ').trim();
                } else if (candidate.content.text) {
                    finalAnswer = candidate.content.text.trim();
                }
            }
            debugLog({ step: 'synthesizeFinalAnswer', finalAnswer });
            if (finalAnswer) {
                UIController.addMessage('ai', `Final Answer:\n${finalAnswer}`);
            }
            // Stop tool workflow after final answer
            state.toolWorkflowActive = false;
        } catch (err) {
            UIController.addMessage('ai', `Final answer synthesis failed. Error: ${err && err.message ? err.message : err}`);
            state.toolWorkflowActive = false;
        }
    }

    // Helper: Get agent details for status bar
    function getAgentDetails() {
        const settings = SettingsController.getSettings();
        return {
            model: settings.selectedModel,
            streaming: settings.streaming,
            enableCoT: settings.enableCoT,
            showThinking: settings.showThinking
        };
    }

    // Helper: Detect if a message is a plan/narration
    function isPlanMessage(text) {
        const planPatterns = [/^Plan:/i, /^Here is my plan:/i, /^My plan:/i, /^Step 1:/i, /^I will /i];
        return planPatterns.some(re => re.test(text.trim()));
    }

    // Plan tracking state
    const PLAN_STATUS = { PENDING: 'pending', IN_PROGRESS: 'in-progress', DONE: 'done', ERROR: 'error' };

    // Helper: Set the current plan (array of {text, status, details, reasoning})
    function setPlan(planSteps) {
        state.currentPlan = planSteps.map(text => ({ text, status: PLAN_STATUS.PENDING, details: '', reasoning: '' }));
        state.planStatus = 'active';
        UIController.renderPlanningBar(state.currentPlan);
    }
    // Helper: Update a plan step's status and reasoning
    function updatePlanStepStatus(idx, status, details = '', reasoning = undefined) {
        if (state.currentPlan[idx]) {
            state.currentPlan[idx].status = status;
            state.currentPlan[idx].details = details;
            if (reasoning !== undefined) {
                state.currentPlan[idx].reasoning = reasoning;
            }
            UIController.updatePlanningBar(state.currentPlan);
        }
    }
    // Helper: Clear the plan
    function clearPlan() {
        state.currentPlan = [];
        state.planStatus = 'idle';
        UIController.hidePlanningBar();
    }
    // Plan extraction from LLM output (robust parser)
    function extractPlanFromText(text) {
        // Support '1. ...', 'Step 1: ...', '- ...'
        const planLines = text.split('\n').filter(line =>
            /^\d+\.\s+/.test(line.trim()) ||
            /^Step\s*\d+[:.]/i.test(line.trim()) ||
            /^-\s+/.test(line.trim())
        );
        return planLines.map(line =>
            line.replace(/^\d+\.\s+/, '')
                .replace(/^Step\s*\d+[:.]\s*/i, '')
                .replace(/^-+\s*/, '')
                .trim()
        );
    }

    // Backward compatibility for processToolCall and other logic
    async function handleGeminiMessage(model, message) {
        await handleGeminiMessageWithPlan(model, message);
    }

    // Public API
    return {
        init,
        updateSettings,
        getSettings,
        sendMessage,
        getChatHistory,
        getTotalTokens,
        clearChat,
        processToolCall,
        getToolCallHistory: () => [...state.toolCallHistory],
    };
})(); 