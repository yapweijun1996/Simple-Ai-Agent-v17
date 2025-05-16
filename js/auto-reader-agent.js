// js/auto-reader-agent.js
// AutoReaderAgent: reads pages adaptively using dynamic reader settings

(function() {
  'use strict';

  // Determine ReaderSettingsAgent implementation
  let rsa;
  if (typeof module !== 'undefined' && module.exports) {
    // Node.js environment
    try {
      rsa = require('./reader-settings-agent.js').ReaderSettingsAgent;
    } catch (e) {
      rsa = global.ReaderSettingsAgent;
    }
  } else {
    // Browser environment
    rsa = window.ReaderSettingsAgent;
  }

  /**
   * Reads content from a URL in adaptive chunks, consulting an LLM if more is needed.
   * @param {Function} readUrlFn - Handler for read_url tool, returns {snippet, hasMore} or string
   * @param {string} url - URL to read
   * @param {string} userQuery - Original user query
   * @param {Function} llmAskFn - Function to ask LLM if more content is needed
   * @returns {Promise<string>} Combined content
   */
  async function readAdaptively(readUrlFn, url, userQuery, llmAskFn) {
    let start = 0;
    let content = '';
    // Fetch dynamic reader settings
    const settings = rsa.getSettingsFor(url, userQuery);
    let chunkSize = settings.chunkSize;
    let maxChunks = settings.maxChunks;

    for (let i = 0; i < maxChunks; i++) {
      let result;
      try {
        result = await readUrlFn({ url, start, length: chunkSize });
      } catch (err) {
        console.warn(`AutoReaderAgent: readUrlFn error: ${err.message}`);
        break;
      }

      let snippet = '';
      if (typeof result === 'string') {
        snippet = result;
      } else if (result && typeof result === 'object' && 'snippet' in result) {
        snippet = result.snippet;
      } else {
        snippet = String(result || '');
      }
      content += snippet;

      if (typeof llmAskFn === 'function') {
        const prompt = `Given this content, do you have enough info to answer: "${userQuery}"?\n\n${content}`;
        const response = await llmAskFn(prompt);
        if (response && response.toLowerCase().startsWith('yes')) break;
      }

      start += chunkSize;
    }
    return content;
  }

  const AutoReaderAgent = { readAdaptively };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { AutoReaderAgent };
  }
  if (typeof window !== 'undefined') {
    window.AutoReaderAgent = AutoReaderAgent;
  }
})();