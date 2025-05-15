// js/auto-reader-agent.js

const AutoReaderAgent = (function() {
  'use strict';

  async function readAdaptively(readUrlFn, url, userQuery, llmAskFn) {
    let start = 0, chunkSize = 2000, maxChunks = 5, content = '';
    for (let i = 0; i < maxChunks; i++) {
      const snippet = await readUrlFn(url, start, chunkSize);
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