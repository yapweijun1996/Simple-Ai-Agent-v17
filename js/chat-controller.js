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
        toolWorkflowActive: true
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
                // UIController.addMessage('ai', 'Error: Invalid web_search query.');
                return null;
            }
            const engine = args.engine || 'duckduckgo';
            const userQuestion = state.originalUserQuestion || args.query;
            let queriesTried = [args.query];
            let allResults = [];
            let lastResults = [];
            let attempts = 0;
            const MAX_ATTEMPTS = 3;
            while (attempts < MAX_ATTEMPTS) {
                // UIController.showSpinner and UIController.showStatus removed
                let results = [];
                try {
                    const streamed = [];
                    results = await ToolsService.webSearch(queriesTried[attempts], (result) => {
                        streamed.push(result);
                        // UIController.addSearchResult removed
                    }, engine);
                    debugLog(`Web search results for query [${queriesTried[attempts]}]:`, results);
                } catch (err) {
                    // UIController.hideSpinner and UIController.addMessage removed
                    debugLog(`Web search failed: ${err.message}`);
                    state.chatHistory.push({ role: 'assistant', content: `Web search failed: ${err.message}` });
                    break;
                }
                allResults = allResults.concat(results);
                lastResults = results;
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
            // UIController.hideSpinner and UIController.clearStatus removed
            if (!allResults.length) {
                debugLog(`No search results found for "${args.query}" after ${attempts+1} attempts.`);
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
            return uniqueResults;
        },
        read_url: async function(args) {
            debugLog('Tool: read_url', args);
            if (!args.url || typeof args.url !== 'string' || !/^https?:\/\//.test(args.url)) {
                // UIController.addMessage('ai', 'Error: Invalid read_url argument.');
                return null;
            }
            // UIController.showSpinner and UIController.showStatus removed
            try {
                const result = await ToolsService.readUrl(args.url);
                const start = (typeof args.start === 'number' && args.start >= 0) ? args.start : 0;
                const length = (typeof args.length === 'number' && args.length > 0) ? args.length : 1122;
                const snippet = String(result).slice(start, start + length);
                const hasMore = (start + length) < String(result).length;
                // UIController.addReadResult removed
                // UIController.hideSpinner and UIController.clearStatus removed
                return { url: args.url, snippet, hasMore };
            } catch (err) {
                // UIController.hideSpinner and UIController.addMessage removed
                state.chatHistory.push({ role: 'assistant', content: `Read URL failed: ${err.message}` });
                // UIController.clearStatus removed
                return { error: err.message };
            }
        },
        instant_answer: async function(args) {
            debugLog('Tool: instant_answer', args);
            if (!args.query || typeof args.query !== 'string' || !args.query.trim()) {
                // UIController.addMessage('ai', 'Error: Invalid instant_answer query.');
                return null;
            }
            // UIController.showStatus removed
            try {
                const result = await ToolsService.instantAnswer(args.query);
                const text = JSON.stringify(result, null, 2);
                // UIController.addMessage removed
                state.chatHistory.push({ role: 'assistant', content: text });
                // UIController.clearStatus removed
                return result;
            } catch (err) {
                // UIController.clearStatus and UIController.addMessage removed
                state.chatHistory.push({ role: 'assistant', content: `Instant answer failed: ${err.message}` });
                return { error: err.message };
            }
        }
    };

    // [IMPORTS for PlanningAgent and ExecutionAgent]
    // For browser, use window if needed; for Node, use require
    let PlanningAgent, ExecutionAgent;
    try {
        ({ PlanningAgent } = require('./planning-agent.js'));
        ({ ExecutionAgent } = require('./execution-agent.js'));
    } catch (e) {
        PlanningAgent = window.PlanningAgent;
        ExecutionAgent = window.ExecutionAgent;
    }

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
        // Update agent debug mode if agents are in use
        if (typeof PlanningAgent !== 'undefined') PlanningAgent.prototype.setDebug && PlanningAgent.prototype.setDebug(newSettings.debug);
        if (typeof ExecutionAgent !== 'undefined') ExecutionAgent.prototype.setDebug && ExecutionAgent.prototype.setDebug(newSettings.debug);
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
        return `${message}\n\nI'd like you to use Chain of Thought reasoning. Please think step-by-step before providing your final answer. Format your response like this:
Thinking: [detailed reasoning process, exploring different angles and considerations]
Answer: [your final, concise answer based on the reasoning above]`;
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

        UIController.showStatus('Sending message...', getAgentDetails());
        setInputState(false);

        state.lastThinkingContent = '';
        state.lastAnswerContent = '';

        UIController.addMessage('user', message);
        UIController.clearUserInput();

        try {
            // Use the new planning and execution workflow
            await runPlanningAndExecutionWorkflow(message);
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

    // Refactored handleOpenAIMessage
    async function handleOpenAIMessage(model, message) {
        if (state.settings.streaming) {
            UIController.showStatus('Streaming response...', getAgentDetails());
            const aiMsgElement = UIController.createEmptyAIMessage();
            await handleStreamingResponse({ model, aiMsgElement, streamFn: ApiService.streamOpenAIRequest, onToolCall: processToolCall });
        } else {
            await handleNonStreamingResponse({ model, requestFn: ApiService.sendOpenAIRequest, onToolCall: processToolCall });
        }
    }

    // Helper: Handle streaming Gemini response
    async function handleGeminiStreaming(model, message, aiMsgElement) {
        await handleStreamingResponse({ model, aiMsgElement, streamFn: ApiService.streamGeminiRequest, onToolCall: processToolCall });
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

    // Refactored handleGeminiMessage
    async function handleGeminiMessage(model, message) {
        state.chatHistory.push({ role: 'user', content: message });
        if (state.settings.streaming) {
            const aiMsgElement = UIController.createEmptyAIMessage();
            await handleGeminiStreaming(model, message, aiMsgElement);
        } else {
            await handleGeminiNonStreaming(model, message);
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

    /**
     * Runs the planning and execution workflow for a user query.
     * 1. Generates a plan using PlanningAgent.
     * 2. Displays the plan to the user.
     * 3. Executes the plan step by step using ExecutionAgent.
     * 4. Narrates each step and shows results in the chat.
     * @param {string} userQuery
     */
    async function runPlanningAndExecutionWorkflow(userQuery) {
        // Get debug setting from global settings
        const debug = SettingsController.getSettings().debug;
        // 1. Instantiate PlanningAgent and generate plan
        const planningAgent = new PlanningAgent(Object.keys(toolHandlers), debug);
        planningAgent.setDebug(debug);
        UIController.addMessage('ai', '🤔 Planning steps for your query...');
        const plan = await planningAgent.createPlan(userQuery);
        if (!plan || !plan.length) {
            UIController.addMessage('ai', 'Could not generate a plan for your query.');
            return;
        }
        // 2. Display the plan to the user
        const planHtml = `<div class="tool-result"><strong>Plan:</strong><ol>${plan.map(step => `<li><b>Step ${step.step}:</b> ${step.description} <span style='color:#888'>(Tool: ${step.tool})</span></li>`).join('')}</ol></div>`;
        UIController.addHtmlMessage('ai', planHtml);
        // 3. Instantiate ExecutionAgent
        const executionAgent = new ExecutionAgent(toolHandlers, debug);
        executionAgent.setDebug(debug);
        // 4. Narrate and execute each step
        await executionAgent.executePlan(plan, msg => UIController.addMessage('ai', msg));
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
        runPlanningAndExecutionWorkflow,
    };
})(); 