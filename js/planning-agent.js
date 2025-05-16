// js/planning-agent.js

class PlanningAgent {
  constructor(availableTools = [], debug = false, options = {}) {
    this.availableTools = availableTools;
    this.debug = debug;
    // Number of read_url steps per search term (configurable)
    this.readStepsPerTerm = options.readStepsPerTerm || 3;
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
      // Generate search terms (async LLM-driven if available)
      let searchTerms;
      if (typeof SearchTermGeneratorAgent !== 'undefined' && SearchTermGeneratorAgent.generateSearchTerms) {
        searchTerms = await SearchTermGeneratorAgent.generateSearchTerms(userQuery);
      } else {
        searchTerms = [userQuery];
      }
      let stepNum = 1;
      // For each term, add a search step and configurable number of read steps
      for (const term of searchTerms) {
        plan.push({
          step: stepNum++,
          description: `Search for information about: "${term}"`,
          tool: 'web_search',
          arguments: { query: term }
        });
        for (let i = 0; i < this.readStepsPerTerm; i++) {
          plan.push({
            step: stepNum++,
            description: `Read content from top result #${i + 1} for "${term}"`,
            tool: 'read_url',
            arguments: { url: '<<TO_BE_FILLED_BY_EXECUTOR>>' }
          });
        }
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