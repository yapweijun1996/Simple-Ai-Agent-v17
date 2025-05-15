const SearchTermGeneratorAgent = (function() {
  'use strict';

  function generateSearchTerms(userQuery) {
    // Use MemoryAgent for context
    const context = MemoryAgent.getRelevantContext(userQuery);
    let baseTerm = userQuery.trim();
    if (baseTerm.length < 5 && context.lastTopic) {
      baseTerm = `${context.lastTopic} ${baseTerm}`;
    }
    // Expand for broad queries
    const searchTerms = [baseTerm];
    if (/all|list|every/i.test(baseTerm)) {
      // Example: generate sub-queries for 'all' (customize as needed)
      if (context.lastTopic) {
        searchTerms.push(`${context.lastTopic} specs`, `${context.lastTopic} review`, `${context.lastTopic} price`);
      }
    }
    return searchTerms;
  }

  return { generateSearchTerms };
})(); 