const MemoryAgent = (function() {
  'use strict';
  let history = [];

  function addTurn(userQuery, agentAnswer, facts = {}) {
    history.push({ userQuery, agentAnswer, facts });
  }

  function getRelevantContext(currentQuery) {
    // Return last topic or facts for context-aware agents
    const last = history[history.length - 1] || {};
    const facts = last.facts || {};
    const lastTopic = (typeof facts.topic === 'string' && facts.topic) ? facts.topic : extractTopic(last.userQuery);
    return {
      lastTopic: lastTopic || '',
      facts: facts
    };
  }

  function extractTopic(query) {
    if (!query) return '';
    // Naive: extract last noun/entity
    return query.split(' ').slice(-1)[0];
  }

  function getConversationSummary() {
    return history.map(turn => `Q: ${turn.userQuery}\nA: ${turn.agentAnswer}`).join('\n');
  }

  function clear() {
    history = [];
  }

  return {
    addTurn,
    getRelevantContext,
    getConversationSummary,
    clear
  };
})(); 