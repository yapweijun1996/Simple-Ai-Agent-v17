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

    // Input validation: returns true if input is a non-empty string after trimming
    function isValidUserInput(input) {
        return typeof input === 'string' && input.trim().length > 0;
    }

    // Add helper to robustly extract JSON tool calls using delimiters and schema validation
    function extractToolCall(text) {
        Utils.debugLog('[extractToolCall] Raw text:', text);
        // Remove code block markers (```json, ```tool_code, or ```)
        text = text.replace(/```(?:json|tool_code)?/gi, '').replace(/```/g, '').trim();
        // Remove comments (// ... or /* ... */)
        text = text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        // Remove trailing commas before } or ]
        text = text.replace(/,\s*([}\]])/g, '$1');
        // Remove newlines inside string values (e.g., URLs)
        // This regex finds quoted strings that span multiple lines and replaces newlines with ''
        text = text.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/gs, (m) => m.replace(/\n/g, ''));
        // Replace single quotes with double quotes
        text = text.replace(/'/g, '"');
        // Prefer tool call wrapped in unique delimiters
        const match = text.match(/\[\[TOOLCALL\]\]([\s\S]*?)\[\[\/TOOLCALL\]\]/);
        let jsonStr = null;
        if (match) {
            jsonStr = match[1];
        } else {
            // Fallback: try to extract the first JSON object in the text
            const jsonMatch = text.match(/\{[\s\S]*?\}/);
            if (jsonMatch) {
                jsonStr = jsonMatch[0];
            } else {
                // Try to extract tool call from common patterns (e.g., tool_call, tool, arguments, action)
                // e.g. { tool: 'web_search', query: 'x' } or { action: 'web_search', query: 'x' }
                const toolCallPattern = /(tool|action)\s*[:=]\s*['\"]?(\w+)['\"]?[,\s]+(arguments|query|url|queries)\s*[:=]\s*([\{\[].*[\}\]]|['\"].*?['\"])/s;
                const m = text.match(toolCallPattern);
                if (m) {
                    let args = {};
                    if (m[3] === 'arguments') {
                        try {
                            args = JSON.parse(m[4]);
                        } catch {}
                    } else if (m[3] === 'query' || m[3] === 'url' || m[3] === 'queries') {
                        args[m[3]] = m[4].replace(/['\"]/g, '');
                    }
                    return { tool: m[2], arguments: args };
                }
                return null;
            }
        }
        if (!jsonStr) return null;
        jsonStr = jsonStr.trim();
        Utils.debugLog('[extractToolCall] Preprocessed JSON:', jsonStr);
        // Try to parse JSON, fallback to forgiving parser if needed
        let obj;
        try {
            // Sanitize before parsing
            const sanitized = sanitizeJsonString(jsonStr);
            try {
                obj = JSON.parse(sanitized);
            } catch (err) {
                Utils.debugLog('Tool JSON parse error:', err, 'from', jsonStr);
                Utils.debugLog('Tool JSON parse error (sanitized):', err, 'from', sanitized);
                // Fallback: regex for tool, arguments, query, url, action
                const fallbackPattern = /(tool|action)\s*[:=]\s*['"]?(\w+)['"]?[,\s]+(arguments|query|url|queries)\s*[:=]\s*([\{\[].*[\}\]]|['"].*?['"])/s;
                const m = jsonStr.match(fallbackPattern);
                if (m) {
                    let args = {};
                    if (m[3] === 'arguments') {
                        try {
                            args = JSON.parse(m[4]);
                        } catch {}
                    } else if (m[3] === 'query' || m[3] === 'url' || m[3] === 'queries') {
                        args[m[3]] = m[4].replace(/['\"]/g, '');
                    }
                    return { tool: m[2], arguments: args };
                }
                // Show user-friendly error
                UIController.addMessage('ai', 'Error: Could not parse tool call JSON. Please check the tool call format.');
                return null;
            }
        } catch (err) {
            Utils.debugLog('Tool JSON parse error (outer):', err, 'from', jsonStr);
            UIController.addMessage('ai', 'Error: Could not parse tool call JSON. Please check the tool call format.');
            return null;
        }
        // Accept alternative keys and normalize
        // Flatten tool_call/tool_code/action objects
        if (obj.tool && typeof obj.arguments === 'object') {
            return obj;
        }
        if (obj.tool_call && (obj.tool_call.tool || obj.tool_call.action)) {
            const tool = obj.tool_call.tool || obj.tool_call.action;
            let args = {};
            if (obj.tool_call.arguments) args = obj.tool_call.arguments;
            if (obj.tool_call.query) args.query = obj.tool_call.query;
            if (obj.tool_call.url) args.url = obj.tool_call.url;
            if (obj.tool_call.queries) args.queries = obj.tool_call.queries;
            return { tool, arguments: args };
        }
        if (obj.tool_code && obj.url) {
            return { tool: obj.tool_code, arguments: { url: obj.url } };
        }
        // Handle { tool: 'web_search', query: 'x' }
        if (obj.tool && obj.query) {
            return { tool: obj.tool, arguments: { query: obj.query } };
        }
        // Handle { tool: 'web_search', queries: [...] }
        if (obj.tool && obj.queries) {
            return { tool: obj.tool, arguments: { queries: obj.queries } };
        }
        // Handle { action: 'web_search', ... }
        if (obj.action && obj.query) {
            return { tool: obj.action, arguments: { query: obj.query } };
        }
        if (obj.action && obj.queries) {
            return { tool: obj.action, arguments: { queries: obj.queries } };
        }
        if (obj.action && obj.url) {
            return { tool: obj.action, arguments: { url: obj.url } };
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

    /**
     * Initializes the chat controller
     * @param {Object} initialSettings - Optional initial settings
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
     * Updates the chat settings
     * @param {Object} newSettings - The new settings to apply
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
     * Gets the current chat settings
     * @returns {Object} - The current settings
     */
    function getSettings() {
        return { ...state.settings };
    }

    /**
     * Sends a message from the user and processes the response
     * Handles both streaming and non-streaming models
     * @returns {Promise<void>}
     */
    async function sendMessage() {
        const message = UIController.getUserInput();
        if (!isValidUserInput(message)) return;
        Utils.debugLog('[sendMessage] User query:', message);
        state.originalUserQuestion = message;
        state.toolWorkflowActive = true;
        Utils.debugLog('[ToolWorkflow] Activated (true) at start of sendMessage');
        state.lastThinkingContent = '';
        state.lastAnswerContent = '';

        UIController.addMessage('user', message);
        UIController.clearUserInput();

        const enhancedMessage = message;
        const currentSettings = SettingsController.getSettings();
        const selectedModel = currentSettings.selectedModel;

        try {
            if (selectedModel.startsWith('gpt')) {
                state.chatHistory.push({ role: 'user', content: enhancedMessage });
                Utils.debugLog('[sendMessage] Sent enhanced message to GPT:', enhancedMessage);
                // Intercept the first AI response to extract plan
                await handleOpenAIMessageWithPlan(selectedModel, enhancedMessage);
            } else if (selectedModel.startsWith('gemini') || selectedModel.startsWith('gemma')) {
                if (state.chatHistory.length === 0) {
                    state.chatHistory.push({ role: 'user', content: '' });
                }
                await handleGeminiMessageWithPlan(selectedModel, enhancedMessage);
            }
        } catch (error) {
            Utils.debugLog('[sendMessage] Error:', error);
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
            UIController.enableMessageInput();
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
                            // Mark current step as done and advance if in-progress
                            if (state.currentPlan && state.currentPlan.length > 0) {
                                const idx = state.currentPlan.findIndex(s => s.status === 'in-progress');
                                if (idx !== -1) {
                                    completeCurrentStep(state.currentPlan[idx].details, processed.thinking);
                                }
                            }
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
            // If tool call extraction failed but the response looks like a tool call, log and show error
            if (!toolCall && typeof fullReply === 'string' && fullReply.includes('{"tool":')) {
                Utils.debugLog('[ToolCall] Tool call JSON detected in response but failed to parse:', fullReply);
                UIController.addMessage('ai', 'Error: Tool call detected in agent response but could not be parsed. Please check the tool call format or delimiters.');
            }
            if (state.settings.enableCoT) {
                const processed = parseCoTResponse(fullReply);
                if (processed.thinking) {
                    Utils.debugLog('AI Thinking:', processed.thinking);
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
            // If tool call extraction failed but the response looks like a tool call, log and show error
            if (!toolCall && typeof reply === 'string' && reply.includes('{"tool":')) {
                Utils.debugLog('[ToolCall] Tool call JSON detected in response but failed to parse:', reply);
                UIController.addMessage('ai', 'Error: Tool call detected in agent response but could not be parsed. Please check the tool call format or delimiters.');
            }
            if (state.settings.enableCoT) {
                const processed = parseCoTResponse(reply);
                if (processed.thinking) {
                    Utils.debugLog('AI Thinking:', processed.thinking);
                }
                // Mark current step as done and advance if in-progress and 'Answer:' is present
                if (reply.includes('Answer:') && state.currentPlan && state.currentPlan.length > 0) {
                    const idx = state.currentPlan.findIndex(s => s.status === 'in-progress');
                    if (idx !== -1) {
                        completeCurrentStep(state.currentPlan[idx].details, processed.thinking);
                    }
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

    // New: Execute plan steps in order, updating the planning bar and reasoning
    async function executePlanSteps(model, planSteps) {
        Utils.debugLog('[Plan] Detected plan steps:', planSteps);
        setPlan(planSteps);
        for (let idx = 0; idx < planSteps.length; idx++) {
            await executeSinglePlanStep(model, planSteps[idx], idx);
        }
        Utils.debugLog('[Plan] All steps complete. Synthesizing final answer.');
        // After all steps, synthesize and present the final answer
        let summary = '';
        if (state.readSnippets && state.readSnippets.length > 0) {
            summary = state.readSnippets.join('\n---\n');
        } else {
            summary = 'No relevant information was found during the research steps.';
        }
        await synthesizeFinalAnswer(summary);
    }

    // Helper: Execute a single plan step (reason, tool call, summary)
    async function executeSinglePlanStep(model, stepText, idx) {
        updatePlanStepStatus(idx, PLAN_STATUS.IN_PROGRESS);
        // Generate reasoning and/or take action for this step
        const prompt = `Step ${idx + 1}: ${stepText}\n\nPlease reason step-by-step and take any necessary tool actions before marking this step as done. If a tool is needed, output ONLY a tool call JSON object as specified in the system instructions.`;
        const currentSettings = SettingsController.getSettings();
        let reply = '';
        if (model.startsWith('gpt')) {
            const res = await ApiService.sendOpenAIRequest(model, [
                { role: 'system', content: 'You are an AI assistant following a multi-step plan. For each step, reason step-by-step and take any necessary tool actions before marking the step as done. If a tool is needed, output ONLY a tool call JSON object as specified in the system instructions.' },
                { role: 'user', content: prompt }
            ]);
            reply = res.choices[0].message.content;
        } else if (model.startsWith('gemini') || model.startsWith('gemma')) {
            const session = ApiService.createGeminiSession(model);
            const chatHistory = [
                { role: 'system', content: 'You are an AI assistant following a multi-step plan. For each step, reason step-by-step and take any necessary tool actions before marking the step as done. If a tool is needed, output ONLY a tool call JSON object as specified in the system instructions.' },
                { role: 'user', content: prompt }
            ];
            const result = await session.sendMessage(prompt, chatHistory);
            const candidate = result.candidates[0];
            if (candidate.content.parts) {
                reply = candidate.content.parts.map(p => p.text).join(' ');
            } else if (candidate.content.text) {
                reply = candidate.content.text;
            }
        }
        // Try to extract and execute a tool call from the reply
        const toolCall = extractToolCall(reply);
        if (toolCall && toolCall.tool && toolCall.arguments) {
            Utils.debugLog('[Plan] Tool call detected in step:', toolCall);
            await processToolCall(toolCall);
            // Optionally, after tool execution, ask for a summary/answer for the step
            let followupReply = '';
            const followupPrompt = `Step ${idx + 1}: ${stepText}\n\nThe tool call has been executed. Please summarize what was learned and provide the next reasoning or answer for this step.`;
            if (model.startsWith('gpt')) {
                const res = await ApiService.sendOpenAIRequest(model, [
                    { role: 'system', content: 'You are an AI assistant following a multi-step plan. Summarize what was learned from the tool call and provide the next reasoning or answer.' },
                    { role: 'user', content: followupPrompt }
                ]);
                followupReply = res.choices[0].message.content;
            } else if (model.startsWith('gemini') || model.startsWith('gemma')) {
                const session = ApiService.createGeminiSession(model);
                const chatHistory = [
                    { role: 'system', content: 'You are an AI assistant following a multi-step plan. Summarize what was learned from the tool call and provide the next reasoning or answer.' },
                    { role: 'user', content: followupPrompt }
                ];
                const result = await session.sendMessage(followupPrompt, chatHistory);
                const candidate = result.candidates[0];
                if (candidate.content.parts) {
                    followupReply = candidate.content.parts.map(p => p.text).join(' ');
                } else if (candidate.content.text) {
                    followupReply = candidate.content.text;
                }
            }
            const processed = parseCoTResponse(followupReply);
            if (processed.thinking) {
                updatePlanStepStatus(idx, PLAN_STATUS.IN_PROGRESS, '', processed.thinking);
            }
        } else {
            // If no tool call, just parse reasoning/answer as before
            const processed = parseCoTResponse(reply);
            if (processed.thinking) {
                updatePlanStepStatus(idx, PLAN_STATUS.IN_PROGRESS, '', processed.thinking);
            }
        }
        // Mark step as done
        updatePlanStepStatus(idx, PLAN_STATUS.DONE);
        Utils.debugLog(`[Plan] Completed step ${idx + 1}`);
    }

    // Helper: Extract plan from text and set plan state
    function extractAndSetPlanFromText(text) {
        // If multiple lines, treat each non-empty line as a step if at least one matches a plan pattern
        const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
        const planPattern = /^(\d+\.|Step\s*\d+[:.]|-\s+)/i;
        const hasPlanLike = lines.some(line => planPattern.test(line));
        if (hasPlanLike && lines.length > 1) {
            return lines;
        }
        // Fallback to original extraction
        const planSteps = extractPlanFromText(text);
        if (planSteps.length > 0) return planSteps;
        // If the text is a tool call, treat as a single-step plan
        const toolCall = extractToolCall(text);
        if (toolCall && toolCall.tool && toolCall.arguments) {
            return [`Call tool: ${toolCall.tool}`];
        }
        return [];
    }

    // Handle streaming plan response
    async function handleStreamingPlanResponse(model, aiMsgElement) {
        let planDetected = false;
        let planSteps = [];
        let firstPlanExtracted = false;
        await handleStreamingResponse({
            model,
            aiMsgElement,
            streamFn: ApiService.streamOpenAIRequest,
            onToolCall: processToolCall,
            onChunk: (chunk, fullText) => {
                if (!firstPlanExtracted && fullText) {
                    planSteps = extractAndSetPlanFromText(fullText);
                    if (planSteps.length > 0) {
                        firstPlanExtracted = true;
                        planDetected = true;
                    }
                }
            }
        });
        if (planDetected && planSteps.length > 0) {
            await executePlanSteps(model, planSteps);
        }
        return planDetected;
    }

    // Handle non-streaming plan response
    async function handleNonStreamingPlanResponse(model) {
        const result = await ApiService.sendOpenAIRequest(model, state.chatHistory);
        if (result.error) throw new Error(result.error.message);
        if (result.usage && result.usage.total_tokens) {
            state.totalTokens += result.usage.total_tokens;
        }
        const reply = result.choices[0].message.content;
        const planSteps = extractAndSetPlanFromText(reply);
        if (planSteps.length > 0) {
            await executePlanSteps(model, planSteps);
            return true;
        }
        return false;
    }

    /**
     * Handles an OpenAI message with Chain-of-Thought plan extraction and execution.
     * Separates streaming and non-streaming logic for clarity.
     * @param {string} model - The model to use
     * @param {string} message - The user message
     */
    async function handleOpenAIMessageWithPlan(model, message) {
        let planDetected = false;
        let rawReply = '';
        if (state.settings.streaming) {
            UIController.showStatus('Streaming response...', getAgentDetails());
            const aiMsgElement = UIController.createEmptyAIMessage();
            planDetected = await handleStreamingPlanResponse(model, aiMsgElement);
            rawReply = aiMsgElement && aiMsgElement.textContent ? aiMsgElement.textContent : '';
        } else {
            const result = await ApiService.sendOpenAIRequest(model, state.chatHistory);
            if (result.error) throw new Error(result.error.message);
            if (result.usage && result.usage.total_tokens) {
                state.totalTokens += result.usage.total_tokens;
            }
            rawReply = result.choices[0].message.content;
            // Use robust plan extraction
            const planSteps = robustExtractPlanFromText(rawReply);
            if (planSteps.length > 0) {
                setPlan(planSteps);
                await executePlanSteps(model, planSteps);
                planDetected = true;
            }
        }
        if (!planDetected) {
            UIController.addMessage('ai', rawReply);
            UIController.showStatus('No plan detected in AI response.', getAgentDetails());
            const toolCall = extractToolCall(rawReply);
            if (toolCall && toolCall.tool && toolCall.arguments) {
                setPlan([`Call tool: ${toolCall.tool}`]);
                await processToolCall(toolCall);
            }
        }
    }

    // Refactor handleGeminiMessageWithPlan
    async function handleGeminiMessageWithPlan(model, message) {
        state.chatHistory.push({ role: 'user', content: message });
        let planDetected = false;
        let planSteps = [];
        let rawReply = '';
        if (state.settings.streaming) {
            const aiMsgElement = UIController.createEmptyAIMessage();
            let firstPlanExtracted = false;
            await handleStreamingResponse({
                model,
                aiMsgElement,
                streamFn: ApiService.streamGeminiRequest,
                onToolCall: processToolCall,
                onChunk: (chunk, fullText) => {
                    rawReply = fullText;
                    if (!firstPlanExtracted && fullText) {
                        planSteps = robustExtractPlanFromText(fullText);
                        if (planSteps.length > 0) {
                            setPlan(planSteps);
                            firstPlanExtracted = true;
                            planDetected = true;
                        }
                    }
                }
            });
            if (planDetected && planSteps.length > 0) {
                await executePlanSteps(model, planSteps);
            }
        } else {
            const session = ApiService.createGeminiSession(model);
            const result = await session.sendMessage(message, state.chatHistory);
            if (result.usageMetadata && typeof result.usageMetadata.totalTokenCount === 'number') {
                state.totalTokens += result.usageMetadata.totalTokenCount;
            }
            const candidate = result.candidates[0];
            if (candidate.content.parts) {
                rawReply = candidate.content.parts.map(p => p.text).join(' ');
            } else if (candidate.content.text) {
                rawReply = candidate.content.text;
            }
            planSteps = robustExtractPlanFromText(rawReply);
            if (planSteps.length > 0) {
                setPlan(planSteps);
                planDetected = true;
                await executePlanSteps(model, planSteps);
            }
        }
        if (!planDetected) {
            UIController.addMessage('ai', rawReply);
            UIController.showStatus('No plan detected in AI response.', getAgentDetails());
            const toolCall = extractToolCall(rawReply);
            if (toolCall && toolCall.tool && toolCall.arguments) {
                setPlan([`Call tool: ${toolCall.tool}`]);
                await processToolCall(toolCall);
            }
        }
    }

    // Helper: Tool call loop protection
    function isToolCallLoop(tool, args) {
        const callSignature = JSON.stringify({ tool, args });
        if (state.lastToolCall === callSignature) {
            state.lastToolCallCount++;
        } else {
            state.lastToolCall = callSignature;
            state.lastToolCallCount = 1;
        }
        return state.lastToolCallCount > state.MAX_TOOL_CALL_REPEAT;
    }

    // Helper: Log tool call
    function logToolCall(tool, args) {
        state.toolCallHistory.push({ tool, args, timestamp: new Date().toISOString() });
    }

    /**
     * Processes a tool call, including loop protection, logging, handler execution, and workflow continuation.
     * @param {Object} call - The tool call object
     */
    async function processToolCall(call) {
        Utils.debugLog('[ToolCall] Received:', Utils.pretty(call));
        if (!state.toolWorkflowActive) return;
        const { tool, arguments: args, skipContinue } = call;
        // Tool call loop protection
        if (isToolCallLoop(tool, args)) {
            Utils.debugLog('[ToolCall] Loop detected, aborting.');
            UIController.addMessage('ai', `Error: Tool call loop detected. The same tool call has been made more than ${state.MAX_TOOL_CALL_REPEAT} times in a row. Stopping to prevent infinite loop.`);
            return;
        }
        // Log tool call
        logToolCall(tool, args);
        // Execute tool handler
        const handlerSuccess = await executeToolHandler(tool, args);
        if (!handlerSuccess) return;
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

    // Helper: Read a chunk from URL with caching
    async function readUrlChunkWithCache(url, start, chunkSize) {
        const cacheKey = `${url}:${start}:${chunkSize}`;
        if (state.readCache.has(cacheKey)) {
            return state.readCache.get(cacheKey);
        } else {
            await processToolCall({ tool: 'read_url', arguments: { url, start, length: chunkSize }, skipContinue: true });
            // Find the last snippet added to chatHistory
            const lastEntry = state.chatHistory[state.chatHistory.length - 1];
            let snippet = '';
            if (lastEntry && typeof lastEntry.content === 'string' && lastEntry.content.startsWith('Read content from')) {
                snippet = lastEntry.content.split('\n').slice(1).join('\n');
                state.readCache.set(cacheKey, snippet);
            }
            return snippet;
        }
    }

    // Helper: Ask AI if more content is needed
    async function aiNeedsMoreContent(url, snippet, selectedModel) {
        const prompt = `Given the following snippet from ${url}, do you need more content to answer the user's question? Please reply with \"YES\" or \"NO\" and a brief reason. If YES, estimate how many more characters you need.\n\nSnippet:\n${snippet}`;
        if (selectedModel.startsWith('gpt')) {
            const res = await ApiService.sendOpenAIRequest(selectedModel, [
                { role: 'system', content: 'You are an assistant that decides if more content is needed from a web page.' },
                { role: 'user', content: prompt }
            ]);
            return res.choices[0].message.content.trim().toLowerCase();
        }
        // Add Gemini/Gemma support if needed
        return 'no';
    }

    /**
     * AI-driven deep reading for a URL, chunked and cached, with AI-driven continuation.
     * Modularized for clarity and maintainability.
     * @param {string} url - The URL to read
     * @param {number} maxChunks - Maximum number of chunks
     * @param {number} chunkSize - Size of each chunk
     * @param {number} maxTotalLength - Maximum total length
     * @returns {Array} - All read chunks
     */
    async function deepReadUrl(url, maxChunks = 5, chunkSize = 2000, maxTotalLength = 10000) {
        let allChunks = [];
        let start = 0;
        let shouldContinue = true;
        let chunkCount = 0;
        let totalLength = 0;
        const selectedModel = SettingsController.getSettings().selectedModel;
        while (shouldContinue && chunkCount < maxChunks && totalLength < maxTotalLength) {
            // Read chunk with cache
            let snippet = await readUrlChunkWithCache(url, start, chunkSize);
            if (!snippet) break;
            allChunks.push(snippet);
            totalLength += snippet.length;
            // Ask AI if more is needed
            let aiReply = '';
            try {
                aiReply = await aiNeedsMoreContent(url, snippet, selectedModel);
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
        Utils.debugLog('autoReadAndSummarizeFromSuggestion', aiReply);
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
        Utils.debugLog({ step: 'autoReadAndSummarizeFromSuggestion', selectedUrls: urlsToRead });
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
        Utils.debugLog('suggestResultsToRead', { results, query });
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

    // Helper: Summarize a batch of snippets
    async function summarizeBatch(snippets, selectedModel, timeout) {
        const batchPrompt = `Summarize the following information extracted from web pages (be as concise as possible):\n\n${snippets.join('\n---\n')}`;
        if (selectedModel.startsWith('gpt')) {
            const res = await ApiService.sendOpenAIRequest(selectedModel, [
                { role: 'system', content: 'You are an assistant that synthesizes information from multiple sources.' },
                { role: 'user', content: batchPrompt }
            ], timeout);
            return res.choices[0].message.content.trim();
        } else if (selectedModel.startsWith('gemini') || selectedModel.startsWith('gemma')) {
            const session = ApiService.createGeminiSession(selectedModel);
            const chatHistory = [
                { role: 'system', content: 'You are an assistant that synthesizes information from multiple sources.' },
                { role: 'user', content: batchPrompt }
            ];
            const result = await session.sendMessage(batchPrompt, chatHistory);
            const candidate = result.candidates[0];
            if (candidate.content.parts) {
                return candidate.content.parts.map(p => p.text).join(' ').trim();
            } else if (candidate.content.text) {
                return candidate.content.text.trim();
            }
        }
        return '';
    }

    // Helper: Recursively summarize batches
    async function summarizeBatchesRecursively(batches, selectedModel, timeout, round = 1) {
        let batchSummaries = [];
        const totalBatches = batches.length;
        for (let i = 0; i < totalBatches; i++) {
            UIController.showSpinner(`Round ${round}: Summarizing batch ${i + 1} of ${totalBatches}...`, getAgentDetails());
            UIController.showStatus(`Round ${round}: Summarizing batch ${i + 1} of ${totalBatches}...`, getAgentDetails());
            const batchReply = await summarizeBatch(batches[i], selectedModel, timeout);
            batchSummaries.push(batchReply);
        }
        const combined = batchSummaries.join('\n---\n');
        return { combined, batchSummaries };
    }

    /**
     * Summarizes snippets recursively, batching as needed for prompt length.
     * Modularized for clarity and maintainability.
     * @param {Array|null} snippets - The snippets to summarize
     * @param {number} round - The current summarization round
     */
    async function summarizeSnippets(snippets = null, round = 1) {
        Utils.debugLog('summarizeSnippets', { snippets, round });
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
                aiReply = await summarizeBatch([snippets[0]], selectedModel, SUMMARIZATION_TIMEOUT);
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
        try {
            const { combined, batchSummaries } = await summarizeBatchesRecursively(batches, selectedModel, SUMMARIZATION_TIMEOUT, round);
            // If the combined summaries are still too long, recursively summarize
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

    // Helper: Construct final answer prompt
    function buildFinalAnswerPrompt(summaries, originalQuestion) {
        return `Based on the following summaries, provide a final, concise answer to the original question.\n\nSummaries:\n${summaries}\n\nOriginal question: ${originalQuestion}`;
    }

    // Helper: Get final answer from model
    async function getFinalAnswerFromModel(selectedModel, prompt) {
        if (selectedModel.startsWith('gpt')) {
            const res = await ApiService.sendOpenAIRequest(selectedModel, [
                { role: 'system', content: 'You are an assistant that synthesizes information from multiple sources and provides a final answer.' },
                { role: 'user', content: prompt }
            ]);
            return res.choices[0].message.content.trim();
        } else if (selectedModel.startsWith('gemini') || selectedModel.startsWith('gemma')) {
            const session = ApiService.createGeminiSession(selectedModel);
            const chatHistory = [
                { role: 'system', content: 'You are an assistant that synthesizes information from multiple sources and provides a final answer.' },
                { role: 'user', content: prompt }
            ];
            const result = await session.sendMessage(prompt, chatHistory);
            const candidate = result.candidates[0];
            if (candidate.content.parts) {
                return candidate.content.parts.map(p => p.text).join(' ').trim();
            } else if (candidate.content.text) {
                return candidate.content.text.trim();
            }
        }
        return '';
    }

    /**
     * Synthesizes the final answer from summaries and the original question.
     * Modularized for clarity and maintainability.
     * @param {string} summaries - The summaries to use
     */
    async function synthesizeFinalAnswer(summaries) {
        Utils.debugLog('[synthesizeFinalAnswer] summaries:', summaries);
        if (!summaries || !state.originalUserQuestion) {
            UIController.addMessage('ai', 'Sorry, I could not generate a final answer. No relevant information was found during the research steps. Please try rephrasing your question or providing more details.');
            state.toolWorkflowActive = false;
            Utils.debugLog('[ToolWorkflow] Deactivated (false) due to no relevant information');
            return;
        }
        const selectedModel = SettingsController.getSettings().selectedModel;
        const prompt = buildFinalAnswerPrompt(summaries, state.originalUserQuestion);
        Utils.debugLog('[synthesizeFinalAnswer] Prompt:', prompt);
        try {
            const finalAnswer = await getFinalAnswerFromModel(selectedModel, prompt);
            Utils.debugLog('[synthesizeFinalAnswer] Final answer:', finalAnswer);
            if (finalAnswer && finalAnswer.trim()) {
                UIController.addMessage('ai', `Final Answer:\n${finalAnswer}`);
            } else {
                Utils.debugLog('[synthesizeFinalAnswer] No final answer generated, using fallback.');
                UIController.addMessage('ai', 'No final answer was generated by the agent.');
            }
            // Set toolWorkflowActive to false after final answer is synthesized
            state.toolWorkflowActive = false;
            Utils.debugLog('[ToolWorkflow] Deactivated (false) after synthesizeFinalAnswer complete');
        } catch (err) {
            Utils.debugLog('[synthesizeFinalAnswer] Error:', err);
            UIController.addMessage('ai', `Final answer synthesis failed. Error: ${err && err.message ? err.message : err}`);
            // Set toolWorkflowActive to false on unrecoverable error
            state.toolWorkflowActive = false;
            Utils.debugLog('[ToolWorkflow] Deactivated (false) due to error in synthesizeFinalAnswer');
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
        state.currentPlan = planSteps.map((text, idx) => ({
            text,
            status: idx === 0 ? PLAN_STATUS.IN_PROGRESS : PLAN_STATUS.PENDING,
            details: '',
            reasoning: ''
        }));
        state.planStatus = 'active';
        UIController.renderPlanningBar(state.currentPlan);
    }
    // Helper: Mark a step as done and move to the next step
    function completeCurrentStep(details = '', reasoning = '') {
        const idx = state.currentPlan.findIndex(s => s.status === PLAN_STATUS.IN_PROGRESS);
        if (idx !== -1) {
            state.currentPlan[idx].status = PLAN_STATUS.DONE;
            if (details) state.currentPlan[idx].details = details;
            if (reasoning) state.currentPlan[idx].reasoning = reasoning;
            // Move to next step if exists
            if (state.currentPlan[idx + 1]) {
                state.currentPlan[idx + 1].status = PLAN_STATUS.IN_PROGRESS;
            }
            UIController.updatePlanningBar(state.currentPlan);
        }
    }
    // Helper: Update a plan step's status and reasoning (now ensures only one in-progress)
    function updatePlanStepStatus(idx, status, details = '', reasoning = undefined) {
        // Set all steps except idx to not in-progress
        state.currentPlan.forEach((step, i) => {
            if (i !== idx && step.status === PLAN_STATUS.IN_PROGRESS) {
                step.status = PLAN_STATUS.PENDING;
            }
        });
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

    // === Two-Agent (A→A) Orchestrator Implementation ===

    /**
     * Orchestrator: Runs the two-agent workflow (Planner + Executor)
     * @param {string} userQuery
     */
    async function runAgentWorkflow(userQuery) {
        // 1. Planning phase
        const plan = await generatePlan(userQuery);
        if (!Array.isArray(plan) || plan.length === 0) {
            UIController.addMessage('ai', 'Planning agent failed to generate a valid plan.');
            return;
        }
        displayPlanningBar(plan);

        // 2. Execution phase
        let context = { userQuery };
        let stepResults = [];
        for (let i = 0; i < plan.length; i++) {
            markStepInProgress(i);
            const result = await executePlanStep(plan[i], context);
            stepResults.push(result);
            displayStepSummary(i, result.summary || result.error);
            markStepDone(i);
            // Optionally, update context with tool results for next steps
            if (result.toolResult) context[`step${i}_result`] = result.toolResult;
        }

        // 3. Final synthesis
        const finalPrompt = `\nGiven the user question: "${userQuery}" and the following step results: ${JSON.stringify(stepResults)}, provide a final, concise answer.`;
        const finalAnswer = await callLLM(finalPrompt, context);
        displayFinalAnswer(finalAnswer);
    }

    /**
     * Agent A: Planning agent
     * @param {string} userQuery
     * @returns {Promise<string[]>}
     */
    async function generatePlan(userQuery) {
        const prompt = `
Given the user question: "${userQuery}", output a numbered list of actionable steps to answer it. Each step should be specific and, if possible, correspond to a tool call or reasoning action.`;
        logAgentEvent('PlanPrompt', prompt);
        const planText = await callLLM(prompt, undefined, AGENT_SYSTEM_PROMPT);
        logAgentEvent('PlanGenerated', planText);
        const plan = extractPlanFromText(planText);
        agentStats.totalSteps = plan.length;
        return plan;
    }

    /**
     * Agent B: Action/execution agent
     * @param {string} step
     * @param {object} context
     * @returns {Promise<object>}
     */
    async function executePlanStep(step, context) {
        const maxRetries = 2;
        let lastResponse = '';
        const strictPrompt = `
You are an AI agent that must follow these instructions exactly:

- If the step requires a tool, output ONLY a tool call JSON object, e.g.:
  {"tool":"web_search","arguments":{"query":"example query"}}
- Do NOT output any explanation, markdown, or extra text.
- If no tool is needed, output ONLY: NO_TOOL_NEEDED (in all caps, no quotes, no explanation).
- If you are unsure, always call a tool.

Step: "${step}"

REMEMBER: Output ONLY a tool call JSON or NO_TOOL_NEEDED. Do not explain your answer.
If you output anything else, the system will reject your response.
`;
        const startTime = Date.now();
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            logAgentEvent('StepPrompt', { step, strictPrompt, attempt });
            const response = await callLLM(strictPrompt, context, AGENT_SYSTEM_PROMPT);
            logAgentEvent('LLMResponse', { step, response, attempt });
            lastResponse = response;
            const toolCall = extractToolCall(response);
            if (toolCall) {
                recordStepStat('toolCalls');
                logAgentEvent('ToolCallExtracted', toolCall);
                const toolResult = await processToolCall(toolCall);
                logAgentEvent('ToolResult', toolResult);
                const summaryPrompt = `\nThe tool call has been executed. Here is the result: ${toolResult}. Please summarize what was learned and provide the next reasoning or answer for this step.`;
                const summary = await callLLM(summaryPrompt, context, AGENT_SYSTEM_PROMPT);
                const elapsed = Date.now() - startTime;
                agentStats.stepTimes.push(elapsed);
                return { toolCall, toolResult, summary };
            } else if (response && response.trim() === 'NO_TOOL_NEEDED') {
                recordStepStat('noToolNeeded');
                const elapsed = Date.now() - startTime;
                agentStats.stepTimes.push(elapsed);
                return { summary: response };
            } else {
                recordStepStat('retries');
            }
        }
        recordStepStat('userInterventions');
        logAgentEvent('StepError', { step, lastResponse });
        const elapsed = Date.now() - startTime;
        agentStats.stepTimes.push(elapsed);
        // Optionally, you could call promptUserForStepAction here
        return { error: 'No valid tool call or NO_TOOL_NEEDED detected after retries.' };
    }

    // === User intervention for failed steps ===
    async function promptUserForStepAction(step, lastResponse) {
        // For now, just notify the user and return null
        UIController.addMessage('ai', `Step "${step}" could not be executed automatically. Last LLM response: ${lastResponse}. Please intervene manually.`);
        // Optionally, you could show a modal or input for the user to provide a tool call or mark as NO_TOOL_NEEDED
        return null;
    }

    // === UI Integration Stubs (replace with your actual UI functions) ===
    function displayPlanningBar(plan) {
        UIController.renderPlanningBar(plan.map((text, idx) => ({ text, status: idx === 0 ? 'in-progress' : 'pending', details: '', reasoning: '' })));
    }
    function markStepInProgress(idx) {
        // Update planning bar UI to show step idx as in-progress
        // (You may want to update state.currentPlan here as well)
    }
    function displayStepSummary(idx, summary) {
        // Show summary or error for step idx in the UI
        UIController.addMessage('ai', `Step ${idx + 1} summary: ${summary}`);
    }
    function markStepDone(idx) {
        // Update planning bar UI to show step idx as done
    }
    function displayFinalAnswer(finalAnswer) {
        UIController.addMessage('ai', `Final Answer: ${finalAnswer}`);
    }

    // === LLM API Wrapper Stub ===
    async function callLLM(prompt, context, systemPrompt) {
        // Replace with your actual LLM API call logic (OpenAI, Gemini, etc.)
        // For now, fallback to existing OpenAI/Gemini logic
        const selectedModel = SettingsController.getSettings().selectedModel;
        const sysPrompt = systemPrompt || 'You are an AI assistant.';
        if (selectedModel.startsWith('gpt')) {
            const res = await ApiService.sendOpenAIRequest(selectedModel, [
                { role: 'system', content: sysPrompt },
                { role: 'user', content: prompt }
            ]);
            return res.choices[0].message.content;
        } else if (selectedModel.startsWith('gemini') || selectedModel.startsWith('gemma')) {
            const session = ApiService.createGeminiSession(selectedModel);
            const chatHistory = [
                { role: 'system', content: sysPrompt },
                { role: 'user', content: prompt }
            ];
            const result = await session.sendMessage(prompt, chatHistory);
            const candidate = result.candidates[0];
            if (candidate.content.parts) {
                return candidate.content.parts.map(p => p.text).join(' ');
            } else if (candidate.content.text) {
                return candidate.content.text;
            }
        }
        return '';
    }

    // === Wire runAgentWorkflow into the chat UI ===
    // Replace or supplement your send button handler
    const sendButton = document.getElementById('send-button');
    if (sendButton) {
        sendButton.addEventListener('click', async () => {
            const userQuery = UIController.getUserInput();
            if (!userQuery.trim()) return;
            UIController.disableMessageInput && UIController.disableMessageInput();
            UIController.showSpinner && UIController.showSpinner('Running agent workflow...');
            try {
                await runAgentWorkflow(userQuery);
            } finally {
                UIController.hideSpinner && UIController.hideSpinner();
                UIController.enableMessageInput && UIController.enableMessageInput();
            }
        });
    }

    // === Agent Workflow Logging & Analytics ===
    window.AGENT_DEBUG = true; // Set to false to disable debug logs
    const agentStats = {
        totalSteps: 0,
        toolCalls: 0,
        noToolNeeded: 0,
        retries: 0,
        userInterventions: 0,
        stepTimes: [],
    };
    function logAgentEvent(event, data) {
        if (!window._agentEventLog) window._agentEventLog = [];
        window._agentEventLog.push({ event, data, ts: Date.now() });
        if (window.AGENT_DEBUG) {
            console.log(`[AGENT] ${event}:`, data);
            if (typeof updateAgentDebugPanel === 'function') updateAgentDebugPanel();
        }
    }
    function recordStepStat(type) {
        if (agentStats[type] !== undefined) agentStats[type]++;
    }

    // === Strict Prompt Engineering for Tool Call Compliance ===
    const AGENT_SYSTEM_PROMPT = `
You are a tool-using agent. You must always output ONLY a tool call JSON or the string NO_TOOL_NEEDED, as described in the user instructions. Never output explanations, markdown, or extra text.
If you output anything else, the system will reject your response.
`;

    // === Agent Debug/Analytics UI Panel ===
    function updateAgentDebugPanel() {
        const stats = window.agentStats || {};
        let html = `<b>Agent Stats</b><br>`;
        for (const k in stats) {
            if (Array.isArray(stats[k])) {
                html += `${k}: [${stats[k].join(', ')}]<br>`;
            } else {
                html += `${k}: ${stats[k]}<br>`;
            }
        }
        html += `<button onclick="exportAgentStats()">Export Stats</button>`;
        html += `<hr><b>Recent Agent Events</b><br>`;
        if (!window._agentEventLog) window._agentEventLog = [];
        window._agentEventLog.slice(-20).forEach(e => {
            let color = (e.event && e.event.toLowerCase().includes('error')) ? 'red' : '#fff';
            html += `<div style="margin-bottom:4px;color:${color}"><b>${e.event}</b>: <pre style="white-space:pre-wrap;">${JSON.stringify(e.data, null, 2)}</pre></div>`;
        });
        const panel = document.getElementById('agent-debug-content');
        if (panel) panel.innerHTML = html;
    }

    function exportAgentStats() {
        const stats = window.agentStats || {};
        const blob = new Blob([JSON.stringify(stats, null, 2)], {type: 'application/json'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'agentStats.json';
        a.click();
        URL.revokeObjectURL(url);
    }

    // Alias for robust plan extraction (backward compatibility)
    function robustExtractPlanFromText(text) {
        return extractPlanFromText(text);
    }

    // Public API
    return Utils.debugWrapAll({
        init,
        updateSettings,
        getSettings,
        sendMessage,
        getChatHistory,
        getTotalTokens,
        clearChat,
        processToolCall,
        getToolCallHistory: () => [...state.toolCallHistory],
        isValidUserInput,
    }, 'CHAT');
})(); 