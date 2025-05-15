// js/execution-agent.js

class ExecutionAgent {
  /**
   * @param {Object} toolHandlers - An object mapping tool names to handler functions.
   * @param {boolean} debug - Enable debug logging (default: false)
   */
  constructor(toolHandlers = {}, debug = false) {
    this.toolHandlers = toolHandlers;
    this.debug = debug;
  }

  setDebug(debug) {
    this.debug = !!debug;
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
      if (this.debug) console.log('[ExecutionAgent-DEBUG] Executing step:', step);
      // Narrate the action
      if (typeof narrateFn === 'function') {
        await narrateFn(`Step ${step.step}: ${step.description}`);
      }
      // Find the tool handler
      const toolFn = this.toolHandlers[step.tool];
      if (!toolFn) {
        const errorMsg = `Error: Tool handler for "${step.tool}" not found.`;
        if (this.debug) console.error('[ExecutionAgent-DEBUG] ' + errorMsg);
        if (typeof narrateFn === 'function') {
          await narrateFn(errorMsg);
        }
        results.push({ step: step.step, error: errorMsg });
        continue;
      }
      // Execute the tool
      try {
        if (this.debug) console.log('[ExecutionAgent-DEBUG] Calling tool:', step.tool, 'with args:', step.arguments);
        const result = await toolFn(step.arguments);
        results.push({ step: step.step, result });
        if (this.debug) console.log('[ExecutionAgent-DEBUG] Result for step', step.step, ':', result);
        if (typeof narrateFn === 'function') {
          await narrateFn(`Result: ${JSON.stringify(result)}`);
        }
      } catch (err) {
        const errorMsg = `Error in step ${step.step}: ${err.message}`;
        if (this.debug) console.error('[ExecutionAgent-DEBUG] ' + errorMsg, err);
        if (typeof narrateFn === 'function') {
          await narrateFn(errorMsg);
        }
        results.push({ step: step.step, error: errorMsg });
        break; // Stop execution on error (or could continue)
      }
    }
    if (this.debug) console.log('[ExecutionAgent-DEBUG] All step results:', results);
    return results;
  }
}

// Export for use in other modules
if (typeof module !== 'undefined') module.exports = { ExecutionAgent };
if (typeof window !== 'undefined') window.ExecutionAgent = ExecutionAgent; 