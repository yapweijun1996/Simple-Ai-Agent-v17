// js/planning-agent.js

class PlanningAgent {
  constructor(availableTools = [], debug = false) {
    this.availableTools = availableTools;
    this.debug = debug;
  }

  setDebug(debug) {
    this.debug = !!debug;
  }

  /**
   * Generates a simple plan based on the user query.
   * @param {string} userQuery - The user's question or task.
   * @returns {Array} plan - Array of plan steps.
   */
  async createPlan(userQuery) {
    if (this.debug) console.log('[PlanningAgent-DEBUG] createPlan input:', userQuery);
    const plan = [];
    try {
      // Use SearchTermGeneratorAgent for smarter search terms
      const searchTerms = (typeof SearchTermGeneratorAgent !== 'undefined' && SearchTermGeneratorAgent.generateSearchTerms)
        ? SearchTermGeneratorAgent.generateSearchTerms(userQuery)
        : [userQuery];
      let stepNum = 1;
      for (const term of searchTerms) {
        plan.push({
          step: stepNum++,
          description: `Search for information about: "${term}"`,
          tool: 'web_search',
          arguments: { query: term }
        });
      }
      // Read top 3 results for each search term
      for (let i = 0; i < searchTerms.length * 3; i++) {
        plan.push({
          step: stepNum++,
          description: `Read content from top result #${i + 1}`,
          tool: 'read_url',
          arguments: { url: '<<TO_BE_FILLED_BY_EXECUTOR>>' }
        });
      }
      plan.push({
        step: stepNum++,
        description: 'Summarize the findings from all read results',
        tool: 'summarize',
        arguments: { snippets: [] }
      });
      if (this.debug) console.log('[PlanningAgent-DEBUG] Generated plan:', JSON.stringify(plan, null, 2));
      return plan;
    } catch (err) {
      if (this.debug) console.error('[PlanningAgent-DEBUG] Error in createPlan:', err);
      throw err;
    }
  }
}

// Export for use in other modules
if (typeof module !== 'undefined') module.exports = { PlanningAgent };
if (typeof window !== 'undefined') window.PlanningAgent = PlanningAgent; 