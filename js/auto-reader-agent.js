// js/auto-reader-agent.js

const AutoReaderAgent = (function() {
  'use strict';

  async function readAdaptively(readUrlFn, url, userQuery, llmAskFn) {
    let start = 0, chunkSize = 2000, maxChunks = 5, content = '';
    for (let i = 0; i < maxChunks; i++) {
      let result;
      try {
        result = await readUrlFn({ url, start, length: chunkSize });
      } catch (e) {
        console.warn(`AutoReaderAgent: readUrlFn error: ${e.message}`);
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

  return { readAdaptively };
})(); 