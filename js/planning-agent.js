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
      if (/search|find|look up|what is|news|info/i.test(userQuery)) {
        plan.push({
          step: 1,
          description: `Search for information about: "${userQuery}"`,
          tool: 'web_search',
          arguments: { query: userQuery }
        });
        // Read top 3 results (placeholders for URLs)
        for (let i = 0; i < 3; i++) {
          plan.push({
            step: 2 + i,
            description: `Read content from top result #${i + 1}`,
            tool: 'read_url',
            arguments: { url: '<<TO_BE_FILLED_BY_EXECUTOR>>' }
          });
        }
        plan.push({
          step: 5,
          description: 'Summarize the findings from all read results',
          tool: 'summarize',
          arguments: { snippets: [] }
        });
      } else if (/code|implement|example|write|fix/i.test(userQuery)) {
        plan.push({
          step: 1,
          description: `Generate code for: "${userQuery}"`,
          tool: 'code_generation',
          arguments: { prompt: userQuery }
        });
      } else {
        // Default: Multi-step plan for general queries
        plan.push({
          step: 1,
          description: `Search for information about: "${userQuery}"`,
          tool: 'web_search',
          arguments: { query: userQuery }
        });
        for (let i = 0; i < 3; i++) {
          plan.push({
            step: 2 + i,
            description: `Read content from top result #${i + 1}`,
            tool: 'read_url',
            arguments: { url: '<<TO_BE_FILLED_BY_EXECUTOR>>' }
          });
        }
        plan.push({
          step: 5,
          description: 'Summarize the findings from all read results',
          tool: 'summarize',
          arguments: { snippets: [] }
        });
      }
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