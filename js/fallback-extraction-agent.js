// js/fallback-extraction-agent.js
// FallbackExtractionAgent: provides hierarchy of fallback extraction strategies
const FallbackExtractionAgent = (function() {
  'use strict';

  /**
   * Returns an array of functions that attempt to extract content from the document.
   * Each function should return a non-empty string or an empty string on failure.
   * @param {Document} doc - Parsed HTML document
   * @param {string} url - The URL being processed
   * @returns {Array<() => string>}
   */
  function getStrategies(doc, url) {
    return [
      // 1. Meta description
      () => {
        const meta = doc.querySelector('meta[name="description"]');
        return meta && meta.content ? meta.content.trim() : '';
      },
      // 2. Document title
      () => doc.title ? doc.title.trim() : '',
      // 3. Full body text
      () => doc.body && doc.body.textContent ? doc.body.textContent.trim() : ''
    ];
  }

  return { getStrategies };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FallbackExtractionAgent };
} 