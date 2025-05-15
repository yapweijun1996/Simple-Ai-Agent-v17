// js/instruction-agent.js
// InstructionAgent: builds or updates the system prompt dynamically based on tools
const InstructionAgent = (function() {
  'use strict';

  /**
   * Generate a system prompt given a list of tool names and instructions.
   * @param {string[]} tools - List of available tool names
   * @returns {string} - The complete system prompt
   */
  function buildSystemPrompt(tools) {
    const lines = [
      'You are an AI assistant with access to the following external tools:'
    ];
    tools.forEach(t => lines.push(`- ${t}(...)`));
    lines.push(`Use these tools to answer any question requiring up-to-date facts or details. Return tool calls only as JSON objects.`);
    return lines.join('\n');
  }

  return { buildSystemPrompt };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { InstructionAgent };
}

if (typeof window !== 'undefined') window.InstructionAgent = InstructionAgent; 