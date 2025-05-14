/**
 * Tool handler registry for chat agent
 */
const toolHandlers = {
    /**
     * Web search tool handler
     * @param {Object} args
     */
    web_search: async function(args) {
        Utils.debugLog('Tool: web_search', args);
        if (!args.query || typeof args.query !== 'string' || !args.query.trim()) {
            UIController.addMessage('ai', 'Error: Invalid web_search query.');
            return;
        }
        const engine = args.engine || 'duckduckgo';
        const userQuestion = (typeof ChatController !== 'undefined' && ChatController.getOriginalUserQuestion) ? ChatController.getOriginalUserQuestion() : args.query;
        let queriesTried = [args.query];
        let allResults = [];
        let lastResults = [];
        let attempts = 0;
        const MAX_ATTEMPTS = 3;
        while (attempts < MAX_ATTEMPTS) {
            UIController.showSpinner(`Searching (${engine}) for "${queriesTried[attempts]}"...`, (typeof ChatController !== 'undefined' && ChatController.getAgentDetails) ? ChatController.getAgentDetails() : undefined);
            UIController.showStatus(`Searching (${engine}) for "${queriesTried[attempts]}"...`, (typeof ChatController !== 'undefined' && ChatController.getAgentDetails) ? ChatController.getAgentDetails() : undefined);
            let results = [];
            try {
                const streamed = [];
                results = await ToolsService.webSearch(queriesTried[attempts], (result) => {
                    streamed.push(result);
                    // Pass highlight flag if this index is in highlightedResultIndices
                    const idx = streamed.length - 1;
                    UIController.addSearchResult(result, (url) => {
                        if (typeof ChatController !== 'undefined' && ChatController.processToolCall) {
                            ChatController.processToolCall({ tool: 'read_url', arguments: { url, start: 0, length: 1122 } });
                        }
                    }, (typeof ChatController !== 'undefined' && ChatController.isHighlightedResultIndex) ? ChatController.isHighlightedResultIndex(idx) : false);
                }, engine);
                Utils.debugLog(`Web search results for query [${queriesTried[attempts]}]:`, results);
            } catch (err) {
                UIController.hideSpinner();
                UIController.addMessage('ai', `Web search failed: ${err.message}`);
                if (typeof ChatController !== 'undefined' && ChatController.pushChatHistory) {
                    ChatController.pushChatHistory({ role: 'assistant', content: `Web search failed: ${err.message}` });
                }
                break;
            }
            allResults = allResults.concat(results);
            lastResults = results;
            if (results.length >= 3 || attempts === MAX_ATTEMPTS - 1) break;
            let betterQuery = null;
            try {
                const selectedModel = (typeof SettingsController !== 'undefined' && SettingsController.getSettings) ? SettingsController.getSettings().selectedModel : '';
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
                Utils.debugLog('AI suggested improved query:', aiReply);
                if (aiReply && !queriesTried.includes(aiReply)) {
                    queriesTried.push(aiReply);
                } else {
                    break;
                }
            } catch (err) {
                Utils.debugLog('Error getting improved query from AI:', err);
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
        Utils.debugLog({ step: 'deduplication', before: allResults });
        for (const r of allResults) {
            if (!seenUrls.has(r.url)) {
                uniqueResults.push(r);
                seenUrls.add(r.url);
            }
        }
        Utils.debugLog({ step: 'deduplication', after: uniqueResults });
        const plainTextResults = uniqueResults.map((r, i) => `${i+1}. ${r.title} (${r.url}) - ${r.snippet}`).join('\n');
        if (typeof ChatController !== 'undefined' && ChatController.pushChatHistory) {
            ChatController.pushChatHistory({ role: 'assistant', content: `Search results for "${args.query}" (total ${uniqueResults.length}):\n${plainTextResults}` });
        }
        if (typeof ChatController !== 'undefined' && ChatController.setLastSearchResults) {
            ChatController.setLastSearchResults(uniqueResults);
        }
        Utils.debugLog({ step: 'suggestResultsToRead', results: uniqueResults });
        if (typeof ChatController !== 'undefined' && ChatController.suggestResultsToRead) {
            await ChatController.suggestResultsToRead(uniqueResults, args.query);
        }
    },
    /**
     * Read URL tool handler
     * @param {Object} args
     */
    read_url: async function(args) {
        Utils.debugLog('Tool: read_url', args);
        if (!args.url || typeof args.url !== 'string' || !/^https?:\/\//.test(args.url)) {
            UIController.addMessage('ai', 'Error: Invalid read_url argument.');
            return;
        }
        UIController.showSpinner(`Reading content from ${args.url}...`, (typeof ChatController !== 'undefined' && ChatController.getAgentDetails) ? ChatController.getAgentDetails() : undefined);
        UIController.showStatus(`Reading content from ${args.url}...`, (typeof ChatController !== 'undefined' && ChatController.getAgentDetails) ? ChatController.getAgentDetails() : undefined);
        try {
            const result = await ToolsService.readUrl(args.url);
            const start = (typeof args.start === 'number' && args.start >= 0) ? args.start : 0;
            const length = (typeof args.length === 'number' && args.length > 0) ? args.length : 1122;
            const snippet = String(result).slice(start, start + length);
            const hasMore = (start + length) < String(result).length;
            UIController.addReadResult(args.url, snippet, hasMore);
            const plainTextSnippet = `Read content from ${args.url}:\n${snippet}${hasMore ? '...' : ''}`;
            if (typeof ChatController !== 'undefined' && ChatController.pushChatHistory) {
                ChatController.pushChatHistory({ role: 'assistant', content: plainTextSnippet });
            }
            if (snippet && typeof ChatController !== 'undefined' && ChatController.pushReadSnippet) {
                ChatController.pushReadSnippet(snippet);
            }
        } catch (err) {
            UIController.hideSpinner();
            UIController.addMessage('ai', `Read URL failed: ${err.message}`);
            if (typeof ChatController !== 'undefined' && ChatController.pushChatHistory) {
                ChatController.pushChatHistory({ role: 'assistant', content: `Read URL failed: ${err.message}` });
            }
        }
        UIController.hideSpinner();
        UIController.clearStatus();
    },
    /**
     * Instant answer tool handler
     * @param {Object} args
     */
    instant_answer: async function(args) {
        Utils.debugLog('Tool: instant_answer', args);
        if (!args.query || typeof args.query !== 'string' || !args.query.trim()) {
            UIController.addMessage('ai', 'Error: Invalid instant_answer query.');
            return;
        }
        UIController.showStatus(`Retrieving instant answer for "${args.query}"...`, (typeof ChatController !== 'undefined' && ChatController.getAgentDetails) ? ChatController.getAgentDetails() : undefined);
        try {
            const result = await ToolsService.instantAnswer(args.query);
            const text = JSON.stringify(result, null, 2);
            UIController.addMessage('ai', text);
            if (typeof ChatController !== 'undefined' && ChatController.pushChatHistory) {
                ChatController.pushChatHistory({ role: 'assistant', content: text });
            }
        } catch (err) {
            UIController.clearStatus();
            UIController.addMessage('ai', `Instant answer failed: ${err.message}`);
            if (typeof ChatController !== 'undefined' && ChatController.pushChatHistory) {
                ChatController.pushChatHistory({ role: 'assistant', content: `Instant answer failed: ${err.message}` });
            }
        }
        UIController.clearStatus();
    },
    // Alias: allow 'search' as a synonym for 'web_search'
    search: toolHandlers.web_search
};

// Export for use in chat-controller.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = toolHandlers;
} else {
    window.toolHandlers = toolHandlers;
} 