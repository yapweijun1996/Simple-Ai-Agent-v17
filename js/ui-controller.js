/**
 * ./js/ui-controller.js
 * UI Controller Module - Manages UI elements and interactions
 * Handles chat display, inputs, and visual elements
 */
const UIController = (function() {
    'use strict';

    // Toggleable UI debug log
    function uiDebugLog(...args) {
        try {
            const debug = (typeof SettingsController !== 'undefined' && SettingsController.getSettings && SettingsController.getSettings().debug);
            if (debug) {
                console.log('[UI-DEBUG]', ...args);
            }
        } catch (e) {
            // Fallback: always log if settings unavailable
            console.log('[UI-DEBUG]', ...args);
        }
    }

    // Private state
    let sendMessageCallback = null;
    let clearChatCallback = null;
    
    // Deduplication and offset tracking
    const shownUrls = new Set();
    const urlOffsets = new Map();
    
    let summarizeBtn = null;
    
    /**
     * Initializes the UI controller
     */
    function init() {
        // Show the chat container
        document.getElementById('chat-container').style.display = 'flex';
        
        // Add enter key handler for message input
        const messageInput = document.getElementById('message-input');
        const sendButton = document.getElementById('send-button');
        // Keyboard shortcut: Enter to send, Shift+Enter for newline
        messageInput.addEventListener('keydown', function(event) {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                if (sendMessageCallback) sendMessageCallback();
            }
        });
        // Auto-resize textarea as user types
        messageInput.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 200) + 'px';
            // Enable/disable send button based on input
            if (sendButton) {
                sendButton.disabled = this.value.trim().length === 0;
            }
        });
        // Set initial state of send button
        if (sendButton) {
            sendButton.disabled = messageInput.value.trim().length === 0;
        }
        
        // Add global event delegation for thinking toggle buttons
        document.addEventListener('click', function(event) {
            if (event.target.classList.contains('toggle-thinking') || 
                event.target.parentElement.classList.contains('toggle-thinking')) {
                const button = event.target.classList.contains('toggle-thinking') ? 
                               event.target : event.target.parentElement;
                const messageElement = button.closest('.chat-app__message');
                
                // Toggle the expanded state
                const isExpanded = button.getAttribute('data-expanded') === 'true';
                button.setAttribute('data-expanded', !isExpanded);
                
                // Toggle visibility of thinking section
                if (messageElement) {
                    messageElement.classList.toggle('thinking-collapsed');
                    button.textContent = isExpanded ? 'Show thinking' : 'Hide thinking';
                }
            }
        });

        // Show empty state on init
        showEmptyState();
        // Add scroll-to-bottom button
        setupScrollToBottomButton();
        setupStatusBarClose();
        // Autofocus message input if login modal is not visible
        setTimeout(() => {
            const messageInput = document.getElementById('message-input');
            const loginModal = document.getElementById('login-modal');
            if (messageInput && (!loginModal || loginModal.style.display === 'none')) {
                if (document.activeElement !== messageInput) {
                    messageInput.focus();
                }
            }
        }, 100);
    }

    // Floating scroll-to-bottom button logic
    function setupScrollToBottomButton() {
        const chatWindow = document.getElementById('chat-window');
        let btn = document.getElementById('scroll-to-bottom-btn');
        if (!btn) {
            btn = document.createElement('button');
            btn.id = 'scroll-to-bottom-btn';
            btn.className = 'scroll-to-bottom-btn';
            btn.title = 'Scroll to latest message';
            btn.innerHTML = '↓';
            btn.style.display = 'none';
            btn.addEventListener('click', function() {
                chatWindow.scrollTo({ top: chatWindow.scrollHeight, behavior: 'smooth' });
            });
            chatWindow.parentElement.appendChild(btn);
        }
        chatWindow.addEventListener('scroll', function() {
            const atBottom = chatWindow.scrollHeight - chatWindow.scrollTop - chatWindow.clientHeight < 40;
            btn.style.display = atBottom ? 'none' : 'block';
        });
    }

    /**
     * Sets up event handlers for UI elements
     * @param {Function} onSendMessage - Callback for send button
     * @param {Function} onClearChat - Callback for clear chat button
     */
    function setupEventHandlers(onSendMessage, onClearChat) {
        sendMessageCallback = onSendMessage;
        clearChatCallback = onClearChat;
        
        // Send button click handler
        document.getElementById('send-button').addEventListener('click', onSendMessage);
        
        // Clear chat button click handler
        const clearChatButton = document.getElementById('clear-chat-button');
        if (clearChatButton) {
            clearChatButton.addEventListener('click', function() {
                if (confirm('Are you sure you want to clear the chat history?')) {
                    clearChatWindow();
                    if (clearChatCallback) clearChatCallback();
                }
            });
        }
    }

    /**
     * Adds a message to the chat window
     * @param {string} sender - The sender ('user' or 'ai')
     * @param {string} text - The message text
     * @param {string} [type] - Optional message type (e.g., 'plan')
     * @returns {Element} - The created message element
     */
    function addMessage(sender, text, type) {
        hideEmptyState();
        const chatWindow = document.getElementById('chat-window');
        const messageElement = Utils.createFromTemplate('message-template');
        
        // Set appropriate class based on sender
        messageElement.classList.add(`${sender}-message`);
        // Add fade-in animation
        messageElement.classList.add('fade-in');

        // Add plan/narration class if type is 'plan'
        if (type === 'plan') {
            messageElement.classList.add('plan-message');
        }

        // Group consecutive messages from the same sender
        const lastMsg = Array.from(chatWindow.children).reverse().find(el => el.classList && el.classList.contains('chat-app__message'));
        if (lastMsg && lastMsg.classList.contains(`${sender}-message`)) {
            messageElement.classList.add('message-grouped');
        }
        
        // Set timestamp
        const timestampElement = messageElement.querySelector('.chat-app__timestamp');
        if (timestampElement) {
            const now = new Date();
            const hours = now.getHours().toString().padStart(2, '0');
            const minutes = now.getMinutes().toString().padStart(2, '0');
            timestampElement.textContent = `${hours}:${minutes}`;
            timestampElement.title = now.toLocaleString();
        }
        
        // Format the message text
        updateMessageContent(messageElement, text);
        
        // Add to chat window and scroll into view
        chatWindow.appendChild(messageElement);
        messageElement.scrollIntoView({ behavior: 'smooth', block: 'end' });
        // Focus the textarea after AI replies for better UX
        if (sender === 'ai') {
            setTimeout(() => {
                const messageInput = document.getElementById('message-input');
                uiDebugLog('[Focus Debug] Running focus logic after agent reply.');
                uiDebugLog('[Focus Debug] Current activeElement:', document.activeElement);
                if (messageInput && document.activeElement !== messageInput) {
                    uiDebugLog('[Focus Debug] Focusing messageInput:', messageInput);
                    messageInput.focus();
                } else {
                    uiDebugLog('[Focus Debug] Not focusing: messageInput missing or already focused.');
                }
            }, 100);
        }
        
        return messageElement;
    }

    /**
     * Clears all messages from the chat window
     */
    function clearChatWindow() {
        const chatWindow = document.getElementById('chat-window');
        chatWindow.innerHTML = '';
        showEmptyState();
    }

    /**
     * Updates the content of a message element
     * @param {Element} messageElement - The message element to update
     * @param {string} text - The new text content
     */
    function updateMessageContent(messageElement, text) {
        if (!messageElement) return;
        const contentElement = messageElement.querySelector('.chat-app__message-content');
        if (!contentElement) return;
        // Remove existing toggle button if present
        const existingToggle = messageElement.querySelector('.toggle-thinking');
        if (existingToggle) existingToggle.remove();
        if (text === '🤔 Thinking...') {
            setThinkingIndicator(contentElement);
            return;
        }
        setFormattedContent(contentElement, text);
        addToggleButton(messageElement, text);
    }

    /**
     * Safely escapes HTML
     * @param {string} html - The string to escape
     * @returns {string} - Escaped HTML string
     */
    function escapeHtml(html) {
        const div = document.createElement('div');
        div.textContent = html;
        return div.innerHTML;
    }
    
    /**
     * Formats code blocks in message text (prevents recursion)
     * @param {string} text - The message text
     * @returns {string} - HTML with formatted code blocks
     */
    function formatCodeBlocks(text) {
        let formatted = '';
        let insideCode = false;
        let codeBlockLang = '';
        let currentText = '';
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('```')) {
                if (!insideCode) {
                    // Start of code block
                    if (currentText) {
                        // Instead of calling formatMessageContent (which could recurse),
                        // just escape and format the non-code text directly.
                        formatted += `<div>${escapeHtml(currentText).replace(/\n/g, '<br>')}</div>`;
                        currentText = '';
                    }
                    insideCode = true;
                    codeBlockLang = line.slice(3).trim();
                    formatted += `<pre><code class="language-${codeBlockLang}">`;
                } else {
                    // End of code block
                    insideCode = false;
                    formatted += '</code></pre>';
                }
            } else if (insideCode) {
                // Inside code block
                formatted += escapeHtml(line) + '\n';
            } else {
                // Regular text
                currentText += (currentText ? '\n' : '') + line;
            }
        }
        // Add any remaining text (non-code)
        if (currentText) {
            formatted += `<div>${escapeHtml(currentText).replace(/\n/g, '<br>')}</div>`;
        }
        return formatted;
    }

    /**
     * Formats message content, including code blocks and CoT reasoning
     * @param {string} text
     * @returns {string}
     */
    function formatMessageContent(text) {
        // Highlight CoT reasoning if present
        if (text.includes('Thinking:') && text.includes('Answer:')) {
            const thinkingMatch = text.match(/Thinking:(.*?)(?=Answer:|$)/s);
            const answerMatch = text.match(/Answer:(.*?)$/s);
            if (thinkingMatch && answerMatch) {
                const thinkingContent = escapeHtml(thinkingMatch[1].trim());
                const answerContent = escapeHtml(answerMatch[1].trim());
                return `<div class="thinking-section"><strong>Thinking:</strong><br>${thinkingContent.replace(/\n/g, '<br>')}</div>\n<div class="answer-section"><strong>Answer:</strong><br>${answerContent.replace(/\n/g, '<br>')}</div>`;
            }
        }
        // Format code blocks if present
        if (text.includes('```')) {
            return formatCodeBlocks(text);
        }
        // Otherwise, escape and format as plain text
        return escapeHtml(text).replace(/\n/g, '<br>');
    }

    /**
     * Gets the user input from the message input field
     * @returns {string} - The user message
     */
    function getUserInput() {
        const messageInput = document.getElementById('message-input');
        return messageInput.value.trim();
    }

    /**
     * Clears the message input field
     */
    function clearUserInput() {
        const messageInput = document.getElementById('message-input');
        messageInput.value = '';
        messageInput.style.height = 'auto'; // Reset height
    }

    /**
     * Creates an empty AI message element placeholder
     * @returns {Element} - The created message element
     */
    function createEmptyAIMessage() {
        const chatWindow = document.getElementById('chat-window');
        const messageElement = Utils.createFromTemplate('message-template');
        messageElement.classList.add('ai-message');
        
        const contentElement = messageElement.querySelector('.chat-app__message-content');
        contentElement.innerHTML = '<span class="thinking-indicator">Thinking...</span>'; // Placeholder
        
        chatWindow.appendChild(messageElement);
        messageElement.scrollIntoView({ behavior: 'smooth', block: 'end' });
        
        return messageElement;
    }

    // Add status bar control methods
    function formatAgentDetails(agentDetails) {
        if (!agentDetails) return '';
        const parts = [];
        if (agentDetails.model) parts.push(`<strong>Model:</strong> ${agentDetails.model}`);
        if (agentDetails.streaming !== undefined) parts.push(`<strong>Streaming:</strong> ${agentDetails.streaming ? 'On' : 'Off'}`);
        if (agentDetails.enableCoT !== undefined) parts.push(`<strong>CoT:</strong> ${agentDetails.enableCoT ? 'On' : 'Off'}`);
        if (agentDetails.showThinking !== undefined) parts.push(`<strong>Thinking:</strong> ${agentDetails.showThinking ? 'On' : 'Off'}`);
        return parts.length ? `<span class="status-bar__details">${parts.join(' | ')}</span>` : '';
    }

    // --- Status Bar Logic (Refined) ---
    let statusBarAutoDismissTimer = null;

    function setStatusBar(bar, { type = 'info', message = '', agentDetails = null, showSpinner = false, autoDismiss = false }) {
        if (!bar) return;
        // Ensure the bar is visible
        bar.style.display = '';
        // Elements
        const icon = bar.querySelector('.status-bar__icon');
        const msg = bar.querySelector('.status-bar__message');
        const closeBtn = bar.querySelector('.status-bar__close');
        // Remove all type classes
        bar.classList.remove('status-bar--info', 'status-bar--error', 'status-bar--progress', 'status-bar--hidden');
        // Set type class and icon
        let iconHtml = '';
        if (type === 'error') {
            iconHtml = '❌';
            bar.classList.add('status-bar--error');
            closeBtn.style.display = 'inline-block';
        } else if (type === 'progress') {
            iconHtml = showSpinner ? '<span class="spinner" aria-hidden="true"></span>' : '⏳';
            bar.classList.add('status-bar--progress');
            closeBtn.style.display = 'none';
        } else { // info/default
            iconHtml = 'ℹ️';
            bar.classList.add('status-bar--info');
            closeBtn.style.display = 'inline-block';
        }
        // Set icon and message
        icon.innerHTML = iconHtml;
        msg.innerHTML = Utils.escapeHtml(message) + (agentDetails ? ' ' + formatAgentDetails(agentDetails) : '');
        // Show bar
        bar.classList.remove('status-bar--hidden');
        // Auto-dismiss for info
        if (statusBarAutoDismissTimer) clearTimeout(statusBarAutoDismissTimer);
        if (type === 'info' && autoDismiss) {
            statusBarAutoDismissTimer = setTimeout(() => {
                clearStatusBar(bar);
            }, 4000);
        }
        // Keyboard accessibility: Esc to close if closeBtn is visible
        bar.onkeydown = (e) => {
            if (e.key === 'Escape' && closeBtn.style.display !== 'none') {
                clearStatusBar(bar);
            }
        };
        // Focus bar for accessibility
        bar.focus();
    }

    function clearStatusBar(bar) {
        if (!bar) return;
        bar.classList.add('status-bar--hidden');
        bar.querySelector('.status-bar__icon').innerHTML = '';
        bar.querySelector('.status-bar__message').innerHTML = '';
        bar.querySelector('.status-bar__close').style.display = 'none';
        bar.removeAttribute('role');
        bar.removeAttribute('aria-live');
        bar.style.display = 'none';
        if (statusBarAutoDismissTimer) {
            clearTimeout(statusBarAutoDismissTimer);
            statusBarAutoDismissTimer = null;
        }
    }

    function setupStatusBarClose() {
        ['status-bar', 'status-bar-under-token'].forEach(id => {
            const bar = document.getElementById(id);
            if (bar) {
                const closeBtn = bar.querySelector('.status-bar__close');
                if (closeBtn) {
                    closeBtn.onclick = () => clearStatusBar(bar);
                    closeBtn.onkeydown = (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            clearStatusBar(bar);
                        }
                    };
                }
            }
        });
    }

    /**
     * Adds a search result to the chat window with a 'Read More' button
     * @param {Object} result - {title, url, snippet}
     * @param {Function} onReadMore - Callback when 'Read More' is clicked
     */
    function addSearchResult(result, onReadMore) {
        if (shownUrls.has(result.url)) return;
        shownUrls.add(result.url);
        const chatWindow = document.getElementById('chat-window');
        const article = document.createElement('article');
        article.className = 'chat-app__message ai-message search-result';
        // Improved card structure
        const card = document.createElement('div');
        card.className = 'search-result-card';
        // Header with icon and link
        const header = document.createElement('div');
        header.className = 'search-result-header';
        header.innerHTML = `<span class="search-result-icon" aria-hidden="true">🔍</span><a href="${result.url}" target="_blank" rel="noopener noreferrer" tabindex="0">${Utils.escapeHtml(result.title)}</a>`;
        card.appendChild(header);
        // URL
        const urlDiv = document.createElement('div');
        urlDiv.className = 'search-result-url';
        urlDiv.innerHTML = `<a href="${result.url}" target="_blank" rel="noopener noreferrer" tabindex="0">${Utils.escapeHtml(result.url)}</a>`;
        card.appendChild(urlDiv);
        // Snippet
        const snippetDiv = document.createElement('div');
        snippetDiv.className = 'search-result-snippet';
        snippetDiv.textContent = result.snippet;
        card.appendChild(snippetDiv);
        article.appendChild(card);
        chatWindow.appendChild(article);
        article.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }

    /**
     * Adds a read_url result to the chat window, with optional 'Read More' if more content is available
     * @param {string} url
     * @param {string} snippet
     * @param {boolean} hasMore
     */
    function addReadResult(url, snippet, hasMore) {
        urlOffsets.set(url, (urlOffsets.get(url) || 0) + snippet.length);
        const chatWindow = document.getElementById('chat-window');
        const article = document.createElement('article');
        article.className = 'chat-app__message ai-message read-result';
        // Improved card structure
        const card = document.createElement('div');
        card.className = 'read-result-card';
        // Header with icon and link
        const header = document.createElement('div');
        header.className = 'read-result-header';
        header.innerHTML = `<span class="read-result-icon" aria-hidden="true">🔗</span><a href="${url}" target="_blank" rel="noopener noreferrer" tabindex="0">Source</a>`;
        card.appendChild(header);
        // Snippet with fade if long
        const snippetDiv = document.createElement('div');
        snippetDiv.className = 'read-result-snippet';
        snippetDiv.textContent = snippet + (hasMore ? '...' : '');
        if (snippet.length > 600 || hasMore) snippetDiv.classList.add('faded');
        card.appendChild(snippetDiv);
        article.appendChild(card);
        chatWindow.appendChild(article);
        article.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }

    /**
     * Shows an empty state message in the chat window
     */
    function showEmptyState() {
        const chatWindow = document.getElementById('chat-window');
        if (!chatWindow.querySelector('.empty-state')) {
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            empty.setAttribute('aria-live', 'polite');
            empty.innerHTML = '<div style="font-size:2.5em;">💬</div><div style="margin-top:10px;">Start a conversation with your AI assistant!<br><span style="font-size:0.95em;color:#888;">Ask anything, get instant answers.</span></div>';
            chatWindow.appendChild(empty);
        }
    }
    function hideEmptyState() {
        const chatWindow = document.getElementById('chat-window');
        const empty = chatWindow.querySelector('.empty-state');
        if (empty) empty.remove();
    }

    /**
     * Show error feedback in the status bar (with ARIA live region)
     */
    function showError(message) {
        setStatusBar(document.getElementById('status-bar'), { type: 'error', message, autoDismiss: false });
    }

    // Helper: Set thinking indicator
    function setThinkingIndicator(contentElement) {
        contentElement.className = 'chat-app__message-content thinking-indicator';
        contentElement.innerHTML = '<span class="thinking-dots" aria-label="Thinking">Thinking<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></span>';
    }

    // Helper: Set formatted content
    function setFormattedContent(contentElement, text) {
        contentElement.className = 'chat-app__message-content';
        contentElement.innerHTML = formatMessageContent(text);
    }

    // Helper: Add toggle button for CoT responses
    function addToggleButton(messageElement, text) {
        if (text.includes('Thinking:') && text.includes('Answer:') && messageElement.classList.contains('ai-message')) {
            const toggleButton = document.createElement('button');
            toggleButton.className = 'toggle-thinking';
            toggleButton.textContent = 'Hide thinking';
            toggleButton.setAttribute('data-expanded', 'true');
            messageElement.querySelector('.chat-app__message-content').parentNode.insertBefore(toggleButton, messageElement.querySelector('.chat-app__message-content').nextSibling);
        }
    }

    // Status bar under token-usage controls
    function showStatusUnderToken(message, agentDetails) {
        setStatusBar(document.getElementById('status-bar-under-token'), { type: 'info', message, agentDetails, autoDismiss: true });
    }
    function clearStatusUnderToken() {
        clearStatusBar(document.getElementById('status-bar-under-token'));
    }
    function showSpinnerUnderToken(message, agentDetails) {
        setStatusBar(document.getElementById('status-bar-under-token'), { type: 'progress', message, agentDetails, showSpinner: true });
    }
    function hideSpinnerUnderToken() {
        clearStatusBar(document.getElementById('status-bar-under-token'));
    }

    // Status bar control for main status bar
    function showStatus(message, agentDetails) {
        setStatusBar(document.getElementById('status-bar'), { type: 'info', message, agentDetails, autoDismiss: true });
    }
    function clearStatus() {
        clearStatusBar(document.getElementById('status-bar'));
    }
    function showSpinner(message, agentDetails) {
        setStatusBar(document.getElementById('status-bar'), { type: 'progress', message, agentDetails, showSpinner: true });
    }
    function hideSpinner() {
        clearStatusBar(document.getElementById('status-bar'));
    }

    /**
     * Enables the message input and send button
     */
    function enableMessageInput() {
        const messageInput = document.getElementById('message-input');
        const sendButton = document.getElementById('send-button');
        if (messageInput) messageInput.disabled = false;
        if (sendButton) sendButton.disabled = messageInput.value.trim().length === 0;
    }

    // --- Planning Bar Logic (Improved) ---
    let planningBarCollapsed = false;
    function renderPlanningBar(planSteps) {
        const bar = document.getElementById('planning-bar');
        if (!bar) return;
        bar.innerHTML = '';
        if (!planSteps || !planSteps.length) {
            bar.style.display = 'none';
            return;
        }
        bar.style.display = 'block';
        bar.setAttribute('role', 'region');
        bar.setAttribute('aria-label', 'Plan Progress');
        // Collapsible control
        const collapseBtn = document.createElement('button');
        collapseBtn.className = 'planning-bar__collapse';
        collapseBtn.innerHTML = planningBarCollapsed ? 'Show Plan ▲' : 'Hide Plan ▼';
        collapseBtn.onclick = () => {
            planningBarCollapsed = !planningBarCollapsed;
            renderPlanningBar(planSteps);
        };
        bar.appendChild(collapseBtn);
        if (planningBarCollapsed) {
            return;
        }
        // Progress bar with animation
        const doneCount = planSteps.filter(s => s.status === 'done').length;
        const progress = planSteps.length ? Math.round((doneCount / planSteps.length) * 100) : 0;
        const progressBar = document.createElement('div');
        progressBar.className = 'planning-progress-bar';
        progressBar.innerHTML = `<div class="planning-progress-bar__fill" style="width:${progress}%; transition: width 0.5s;"></div>`;
        bar.appendChild(progressBar);
        // Steps
        planSteps.forEach((step, idx) => {
            const stepDiv = document.createElement('div');
            stepDiv.className = 'planning-step planning-step--' + step.status;
            if (step.status === 'in-progress') stepDiv.classList.add('current');
            let icon = '⏳', statusLabel = 'Pending';
            if (step.status === 'done') { icon = '✅'; statusLabel = 'Done'; }
            else if (step.status === 'in-progress') { icon = '🔄'; statusLabel = 'In Progress'; }
            else if (step.status === 'error') { icon = '❌'; statusLabel = 'Error'; }
            // Details indicator
            let detailsIndicator = '';
            if (step.details) {
                detailsIndicator = '<span class="planning-step__details-indicator" title="Has details">🛈</span>';
            }
            stepDiv.innerHTML = `<span class="planning-step__icon">${icon}</span> <span class="planning-step__text">${Utils.escapeHtml(step.text)}</span> <span class="planning-step__status-label">${statusLabel}</span> ${detailsIndicator}`;
            // Timestamps/duration (optional, if present)
            if (step.startedAt || step.endedAt) {
                const tsDiv = document.createElement('div');
                tsDiv.className = 'planning-step__timestamps';
                let tsText = '';
                if (step.startedAt) tsText += `Started: ${new Date(step.startedAt).toLocaleTimeString()} `;
                if (step.endedAt) tsText += `Ended: ${new Date(step.endedAt).toLocaleTimeString()}`;
                if (step.startedAt && step.endedAt) {
                    const duration = Math.round((step.endedAt - step.startedAt) / 1000);
                    tsText += ` (Duration: ${duration}s)`;
                }
                tsDiv.textContent = tsText;
                stepDiv.appendChild(tsDiv);
            }
            // Details preview on hover, expand/collapse on click
            if (step.details) {
                const detailsDiv = document.createElement('div');
                detailsDiv.className = 'planning-step__details';
                detailsDiv.textContent = step.details;
                stepDiv.appendChild(detailsDiv);
                stepDiv.title = step.details;
            }
            stepDiv.onclick = () => {
                stepDiv.classList.toggle('expanded');
            };
            bar.appendChild(stepDiv);
        });
        // Plan summary
        const allDone = planSteps.every(s => s.status === 'done');
        const anyError = planSteps.some(s => s.status === 'error');
        const summaryDiv = document.createElement('div');
        summaryDiv.className = 'planning-bar__summary';
        if (allDone) {
            summaryDiv.innerHTML = '<span class="planning-bar__summary--done">Plan complete! 🎉</span>';
        } else if (anyError) {
            const firstErrorIdx = planSteps.findIndex(s => s.status === 'error');
            summaryDiv.innerHTML = `<span class="planning-bar__summary--error">Plan failed at step ${firstErrorIdx + 1}.</span>`;
        } else {
            summaryDiv.innerHTML = `<span class="planning-bar__summary--progress">${doneCount} of ${planSteps.length} steps done.</span>`;
        }
        bar.appendChild(summaryDiv);
    }
    function updatePlanningBar(planSteps) {
        renderPlanningBar(planSteps);
    }
    function hidePlanningBar() {
        const bar = document.getElementById('planning-bar');
        if (bar) bar.style.display = 'none';
    }

    // Public API
    return {
        init,
        setupEventHandlers,
        addMessage,
        clearChatWindow,
        updateMessageContent,
        getUserInput,
        clearUserInput,
        createEmptyAIMessage,
        showStatus,
        clearStatus,
        addSearchResult,
        addReadResult,
        showSpinner,
        hideSpinner,
        showStatusUnderToken,
        clearStatusUnderToken,
        showSpinnerUnderToken,
        hideSpinnerUnderToken,
        /**
         * Adds a chat bubble with raw HTML content (for tool results)
         * @param {string} sender - 'user' or 'ai'
         * @param {string} html - HTML string for the bubble content
         * @returns {Element} - The created message element
         */
        addHtmlMessage(sender, html) {
            const chatWindow = document.getElementById('chat-window');
            const messageElement = Utils.createFromTemplate('message-template');
            messageElement.classList.add(`${sender}-message`);
            const contentElement = messageElement.querySelector('.chat-app__message-content');
            contentElement.innerHTML = html;
            chatWindow.appendChild(messageElement);
            messageElement.scrollIntoView({ behavior: 'smooth', block: 'end' });
            return messageElement;
        },
        showError,
        showEmptyState,
        hideEmptyState,
        enableMessageInput,
        renderPlanningBar,
        updatePlanningBar,
        hidePlanningBar,
    };
})(); 