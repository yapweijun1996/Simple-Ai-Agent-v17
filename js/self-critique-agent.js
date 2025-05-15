// js/self-critique-agent.js

const SelfCritiqueAgent = (function() {
  'use strict';

  function reviewAnswer(answer, userQuery) {
    if (!answer || answer.length < 50) return 'Answer too short, read more or try another source.';
    if (/not found|no information|no useful/i.test(answer)) {
      return 'No useful info found, try a new search term.';
    }
    return null; // No issues
  }

  function revisePlanIfNeeded(plan, critique, newSearchTerm) {
    if (critique && newSearchTerm) {
      plan.push({
        step: plan.length + 1,
        description: 'Try alternative search',
        tool: 'web_search',
        arguments: { query: newSearchTerm }
      });
    }
    return plan;
  }

  return { reviewAnswer, revisePlanIfNeeded };
})(); 