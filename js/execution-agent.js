// js/execution-agent.js

class ExecutionAgent {
  /**
   * @param {Object} toolHandlers - An object mapping tool names to handler functions.
   * Example: { web_search: async (args) => {...}, read_url: async (args) => {...} }
   */
  constructor(toolHandlers = {}) {
    this.toolHandlers = toolHandlers;
  }

  /**
   * Executes a plan step by step.
   * @param {Array} plan - Array of plan steps.
   * @param {Function} narrateFn - Optional. Function to narrate each step (e.g., UI message).
   * @returns {Array} results - Array of results for each step.
   */
  async executePlan(plan, narrateFn = null) {
    const results = [];
    for (const step of plan) {
      // Narrate the action
      if (typeof narrateFn === 'function') {
        await narrateFn(`Step ${step.step}: ${step.description}`);
      }
      // Find the tool handler
      const toolFn = this.toolHandlers[step.tool];
      if (!toolFn) {
        const errorMsg = `Error: Tool handler for "${step.tool}" not found.`;
        if (typeof narrateFn === 'function') {
          await narrateFn(errorMsg);
        }
        results.push({ step: step.step, error: errorMsg });
        continue;
      }
      // Execute the tool
      try {
        const result = await toolFn(step.arguments);
        results.push({ step: step.step, result });
        if (typeof narrateFn === 'function') {
          await narrateFn(`Result: ${JSON.stringify(result)}`);
        }
      } catch (err) {
        const errorMsg = `Error in step ${step.step}: ${err.message}`;
        if (typeof narrateFn === 'function') {
          await narrateFn(errorMsg);
        }
        results.push({ step: step.step, error: errorMsg });
        break; // Stop execution on error (or could continue)
      }
    }
    return results;
  }
}

// Export for use in other modules
if (typeof module !== 'undefined') module.exports = { ExecutionAgent };
if (typeof window !== 'undefined') window.ExecutionAgent = ExecutionAgent; 