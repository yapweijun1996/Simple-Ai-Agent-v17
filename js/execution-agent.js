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
    let webSearchResults = null;
    let i = 0;
    while (i < plan.length) {
      const step = plan[i];
      if (this.debug) console.log('[ExecutionAgent-DEBUG] Executing step:', step);
      // Fill in read_url step URLs dynamically from web_search results
      if (step.tool === 'read_url' && step.arguments.url === '<<TO_BE_FILLED_BY_EXECUTOR>>') {
        if (Array.isArray(webSearchResults)) {
          // Find the index of this read_url step among all read_url steps
          const readUrlSteps = plan.filter(s => s.tool === 'read_url');
          const thisReadUrlIndex = readUrlSteps.indexOf(step);
          if (webSearchResults[thisReadUrlIndex]) {
            step.arguments.url = webSearchResults[thisReadUrlIndex].url;
            if (this.debug) console.log(`[ExecutionAgent-DEBUG] Filled read_url step #${thisReadUrlIndex + 1} with URL:`, step.arguments.url);
          } else {
            if (this.debug) console.warn(`[ExecutionAgent-DEBUG] No web search result for read_url step #${thisReadUrlIndex + 1}, skipping step.`);
            if (typeof narrateFn === 'function') {
              await narrateFn(`Skipping read_url step #${thisReadUrlIndex + 1}: No corresponding web search result.`);
            }
            i++;
            continue;
          }
        } else {
          if (this.debug) console.warn('[ExecutionAgent-DEBUG] No web search results available to fill read_url step, skipping.');
          if (typeof narrateFn === 'function') {
            await narrateFn('Skipping read_url step: No web search results available.');
          }
          i++;
          continue;
        }
      }
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
        i++;
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
        // Store web_search results for dynamic URL filling
        if (step.tool === 'web_search' && Array.isArray(result)) {
          webSearchResults = result;
        }
        // Fallback: If web_search returns empty, run instant_answer
        if (step.tool === 'web_search' && Array.isArray(result) && result.length === 0) {
          // Only add instant_answer if not already in the plan
          const alreadyHasInstant = plan.some(s => s.tool === 'instant_answer');
          if (!alreadyHasInstant) {
            const instantStep = {
              step: step.step + 1,
              description: `Fallback: Get instant answer for "${step.arguments.query}"`,
              tool: 'instant_answer',
              arguments: { query: step.arguments.query }
            };
            if (this.debug) console.log('[ExecutionAgent-DEBUG] Adding fallback instant_answer step:', instantStep);
            plan.splice(i + 1, 0, instantStep);
          }
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
      i++;
    }
    if (this.debug) console.log('[ExecutionAgent-DEBUG] All step results:', results);
    return results;
  }
}

// Export for use in other modules
if (typeof module !== 'undefined') module.exports = { ExecutionAgent };
if (typeof window !== 'undefined') window.ExecutionAgent = ExecutionAgent; 