/**
 * ./js/utils.js
 * Utilities Module - Contains encryption/decryption and helper functions
 */
const Utils = (function() {
    'use strict';

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // Add a module-level variable to track the timer for clearing the under-token status bar
    let underTokenStatusTimer = null;

    // Debug logging helper
    function debugLog(...args) {
        if (typeof window !== 'undefined' && window.ChatController && window.ChatController.getSettings && window.ChatController.getSettings().debug) {
            console.log('[AI-DEBUG]', ...args);
        }
    }

    /**
     * Decrypts text using XOR cipher
     * @param {string} ciphertext - The encrypted text
     * @param {string} key - The decryption key
     * @returns {string} - Decrypted text
     */
    function decrypt(ciphertext, key) {
        let decoded = "";
        for (let i = 0; i < ciphertext.length; i += 3) {
            let numStr = ciphertext.slice(i, i + 3);
            let encryptedChar = parseInt(numStr);
            let keyChar = key.charCodeAt((i / 3) % key.length);
            let decryptedChar = encryptedChar ^ keyChar;
            decoded += String.fromCharCode(decryptedChar);
        }
        return decoder.decode(new Uint8Array(encoder.encode(decoded)));
    }

    /**
     * Encrypts text using XOR cipher (for cookie storage)
     * @param {string} text - The text to encrypt
     * @param {string} key - The encryption key
     * @returns {string} - Encrypted text
     */
    function encrypt(text, key) {
        let encoded = "";
        const textBytes = encoder.encode(text);
        
        for (let i = 0; i < textBytes.length; i++) {
            const charCode = textBytes[i];
            const keyChar = key.charCodeAt(i % key.length);
            const encryptedChar = charCode ^ keyChar;
            // Pad to ensure 3 digits for each character
            encoded += encryptedChar.toString().padStart(3, '0');
        }
        
        return encoded;
    }

    /**
     * Handles Server-Sent Events (SSE) parsing from stream responses
     * @param {string} line - The SSE line to parse
     * @returns {Object|null} - Parsed data or null if not parseable
     */
    function parseSSELine(line) {
        if (!line.startsWith('data: ')) return null;
        
        const dataStr = line.slice(6).trim();
        if (dataStr === '[DONE]') return { done: true };
        
        try {
            return { data: JSON.parse(dataStr) };
        } catch (err) {
            debugLog('Stream parsing error', err);
            return null;
        }
    }

    /**
     * Creates an element from a template
     * @param {string} templateId - The ID of the template element
     * @returns {Element} - The cloned template content
     */
    function createFromTemplate(templateId) {
        const template = document.getElementById(templateId);
        if (!template) {
            debugLog(`Template not found: ${templateId}`);
            return null;
        }
        return template.content.cloneNode(true).firstElementChild;
    }

    /**
     * Updates the token usage display and shows a temporary status message under the token usage bar.
     * @param {number} totalTokens - The total tokens used
     * Shows a status message for 2 seconds in the under-token status bar.
     */
    function updateTokenDisplay(totalTokens) {
        const tokenDisplay = document.getElementById('token-usage');
        if (tokenDisplay) {
            tokenDisplay.textContent = `Total tokens used: ${totalTokens}`;
        }
        // Show status under token usage
        if (typeof UIController !== 'undefined' && typeof SettingsController !== 'undefined') {
            const agentDetails = SettingsController.getSettings();
            UIController.showStatusUnderToken('Token usage updated.', agentDetails);
            if (underTokenStatusTimer) {
                clearTimeout(underTokenStatusTimer);
            }
            underTokenStatusTimer = setTimeout(() => {
                UIController.clearStatusUnderToken();
                underTokenStatusTimer = null;
            }, 2000);
        }
    }

    /**
     * Sets a cookie with the given name, value, and expiration days
     * @param {string} name - Cookie name
     * @param {string} value - Cookie value
     * @param {number} days - Days until expiration
     */
    function setCookie(name, value, days = 30) {
        const expirationDate = new Date();
        expirationDate.setDate(expirationDate.getDate() + days);
        
        const cookieValue = encodeURIComponent(value) + 
            (days ? `; expires=${expirationDate.toUTCString()}` : '') + 
            '; path=/; SameSite=Strict';
        
        document.cookie = `${name}=${cookieValue}`;
    }

    /**
     * Gets a cookie by name
     * @param {string} name - Cookie name
     * @returns {string|null} - Cookie value or null if not found
     */
    function getCookie(name) {
        const nameEQ = name + '=';
        const cookies = document.cookie.split(';');
        
        for (let i = 0; i < cookies.length; i++) {
            let cookie = cookies[i].trim();
            if (cookie.indexOf(nameEQ) === 0) {
                return decodeURIComponent(cookie.substring(nameEQ.length));
            }
        }
        
        return null;
    }

    /**
     * Deletes a cookie by name
     * @param {string} name - Cookie name
     */
    function deleteCookie(name) {
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; SameSite=Strict`;
    }

    /**
     * Saves the password to a cookie (securely)
     * @param {string} password - The password to save
     */
    function savePasswordToCookie(password) {
        // Create a simple encryption for the password
        // Using a fixed salt + current domain as encryption key
        const encryptionKey = 'AI-Chat-App-' + window.location.hostname;
        const encryptedPassword = encrypt(password, encryptionKey);
        setCookie('chat_pwd', encryptedPassword);
    }

    /**
     * Gets the saved password from cookie
     * @returns {string|null} - The decrypted password or null if not found
     */
    function getPasswordFromCookie() {
        const encryptedPassword = getCookie('chat_pwd');
        if (!encryptedPassword) return null;
        
        try {
            const encryptionKey = 'AI-Chat-App-' + window.location.hostname;
            return decrypt(encryptedPassword, encryptionKey);
        } catch (err) {
            console.error('Error decrypting password from cookie:', err);
            deleteCookie('chat_pwd');
            return null;
        }
    }

    /**
     * Clears the saved password from cookie
     */
    function clearSavedPassword() {
        deleteCookie('chat_pwd');
    }

    /**
     * Saves settings to a cookie
     * @param {Object} settings - The settings object to save
     */
    function saveSettingsToCookie(settings) {
        setCookie('chat_settings', JSON.stringify(settings));
    }

    /**
     * Gets saved settings from cookie
     * @returns {Object|null} - The settings object or null if not found
     */
    function getSettingsFromCookie() {
        const settingsStr = getCookie('chat_settings');
        if (!settingsStr) return null;
        
        try {
            return JSON.parse(settingsStr);
        } catch (err) {
            console.error('Error parsing settings from cookie:', err);
            deleteCookie('chat_settings');
            return null;
        }
    }

    /**
     * Safely escapes HTML special characters in a string
     * @param {string} str - The string to escape
     * @returns {string} - The escaped string
     */
    function escapeHtml(str) {
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
        return String(str).replace(/[&<>"']/g, s => map[s]);
    }

    // Add fetch helpers for timeout and retry
    async function fetchWithTimeout(resource, options = {}, timeout = 30000) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);
        options.signal = controller.signal;
        try {
            return await fetch(resource, options);
        } finally {
            clearTimeout(id);
        }
    }

    async function fetchWithRetry(url, options = {}, maxAttempts = 3, delay = 1000, timeout = 30000) {
        let attempt = 0;
        while (attempt < maxAttempts) {
            try {
                const controller = new AbortController();
                const id = setTimeout(() => controller.abort('timeout'), timeout);
                const response = await fetch(url, { ...options, signal: controller.signal });
                clearTimeout(id);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response;
            } catch (err) {
                if (err.name === 'AbortError') {
                    debugLog(`Fetch attempt ${attempt + 1} aborted:`, err.message || err);
                    throw err; // Do not retry on AbortError
                }
                attempt++;
                if (attempt >= maxAttempts) throw err;
                await new Promise(res => setTimeout(res, delay));
            }
        }
    }

    // Add CORS proxy list and proxy-based retry helper
    const corsProxies = [
        // Direct fetch first
        '',
        // Widely used public CORS proxies
        'https://cors-anywhere.herokuapp.com/',
        'https://jsonp.afeld.me/?url=',
        'https://api.allorigins.win/raw?url=',
        'https://api.allorigins.xyz/raw?url=',
        'https://corsproxy.io/?',
        'https://thingproxy.freeboard.io/fetch/?url=',
        'https://cors.eu.org/',
        'https://api.codetabs.com/v1/proxy?quest=',
        'https://yacdn.org/proxy/',
        'https://cors.bridged.cc/',
        'https://cors.sho.sh/',
        'https://cors.ironproxy.xyz/',
        'https://norobe-cors-anywhere.herokuapp.com/',
        'https://corsproxy.github.io/?url=',
        'https://cors-proxy.elfsight.com/'
    ];

    async function fetchWithProxyRetry(resource, options = {}, proxies = corsProxies, retries = proxies.length, retryDelay = 1000, timeout = 30000) {
        let lastError;
        for (let attempt = 1; attempt <= retries; attempt++) {
            const prefix = proxies[(attempt - 1) % proxies.length];
            const url = prefix
                ? (prefix.endsWith('?') || prefix.includes('?url=')
                    ? prefix + (resource)
                    : prefix + resource)
                : resource;
            try {
                const response = await fetchWithTimeout(url, options, timeout);
                if (!response.ok) {
                    const text = await response.text();
                    throw new Error(`HTTP ${response.status}: ${text}`);
                }
                return response;
            } catch (err) {
                lastError = err;
                debugLog(`Proxy fetch attempt ${attempt} via ${prefix || 'direct'} failed:`, err);
                if (attempt < retries) await new Promise(r => setTimeout(r, retryDelay));
            }
        }
        throw lastError;
    }

    /**
     * Pretty-print utility for debug logs
     * @param {any} obj
     * @returns {string}
     */
    function pretty(obj) {
        try {
            return JSON.stringify(obj, null, 2);
        } catch {
            return String(obj);
        }
    }

    /**
     * Sanitizes a JSON string for safe parsing
     * @param {string} jsonStr
     * @returns {string}
     */
    function sanitizeJsonString(jsonStr) {
        // Remove trailing commas before } or ]
        jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');
        // Replace single quotes with double quotes
        jsonStr = jsonStr.replace(/'/g, '"');
        // Remove newlines inside string values
        jsonStr = jsonStr.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/gs, (m) => m.replace(/\n/g, ''));
        return jsonStr;
    }

    /**
     * Wraps a function to log its call and arguments if debug mode is enabled
     * @param {Function} fn - The function to wrap
     * @param {string} name - The function name for logging
     * @param {string} [module] - Optional module name for prefix
     * @returns {Function}
     */
    function debugWrap(fn, name, module = 'FUNC') {
        return function(...args) {
            try {
                const debug = (typeof SettingsController !== 'undefined' && SettingsController.getSettings && SettingsController.getSettings().debug);
                if (debug) {
                    console.log(`[${module}] ${name} called`, ...args);
                }
            } catch {}
            return fn.apply(this, args);
        };
    }

    /**
     * Wraps all functions in an object with debugWrap
     * @param {Object} obj - The object whose functions to wrap
     * @param {string} [module] - Optional module name for prefix
     * @returns {Object} - New object with wrapped functions
     */
    function debugWrapAll(obj, module = 'FUNC') {
        const wrapped = {};
        for (const key in obj) {
            if (typeof obj[key] === 'function') {
                wrapped[key] = debugWrap(obj[key], key, module);
            } else {
                wrapped[key] = obj[key];
            }
        }
        return wrapped;
    }

    // Public API
    return {
        decrypt,
        encrypt,
        parseSSELine,
        createFromTemplate,
        updateTokenDisplay,
        setCookie,
        getCookie,
        deleteCookie,
        savePasswordToCookie,
        getPasswordFromCookie,
        clearSavedPassword,
        saveSettingsToCookie,
        getSettingsFromCookie,
        escapeHtml,
        fetchWithTimeout,
        fetchWithRetry,
        fetchWithProxyRetry,
        debugLog,
        pretty,
        sanitizeJsonString,
        debugWrap,
        debugWrapAll
    };
})(); 