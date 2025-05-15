// js/content-extraction-agent.js
// ContentExtractionAgent: selects which DOM selectors to use for content extraction
const ContentExtractionAgent = (function() {
  'use strict';

  /**
   * Get an array of CSS selectors or tag names to extract text from.
   * @param {Document} doc - Parsed HTML document
   * @param {string} url - The URL being processed
   * @returns {string[]} - List of selectors in priority order
   */
  function getSelectors(doc, url) {
    // TODO: implement dynamic selection logic (e.g., detect <article>, schema.org, etc.)
    return ['p', 'h1', 'h2', 'h3'];
  }

  return { getSelectors };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ContentExtractionAgent };
} 