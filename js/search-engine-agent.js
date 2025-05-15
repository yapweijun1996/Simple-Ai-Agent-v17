// js/search-engine-agent.js
// SearchEngineAgent: chooses the search engine and constructs the search URL
const SearchEngineAgent = (function() {
  'use strict';

  /**
   * Decide which search engine to use for a given query.
   * @param {string} query
   * @returns {string} engine key (e.g., 'duckduckgo', 'google', 'bing')
   */
  function chooseEngine(query) {
    // TODO: implement dynamic selection based on query or settings
    return 'duckduckgo';
  }

  /**
   * Build the search URL for the given engine and query.
   * @param {string} engine
   * @param {string} query
   * @returns {string}
   */
  function buildSearchUrl(engine, query) {
    const encoded = encodeURIComponent(query);
    switch (engine) {
      case 'google':
        return `https://www.google.com/search?q=${encoded}`;
      case 'bing':
        return `https://www.bing.com/search?q=${encoded}`;
      case 'duckduckgo':
      default:
        return `https://html.duckduckgo.com/html/?q=${encoded}`;
    }
  }

  return { chooseEngine, buildSearchUrl };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SearchEngineAgent };
} 