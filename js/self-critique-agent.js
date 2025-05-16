// js/self-critique-agent.js

const SelfCritiqueAgent = (function() {
  'use strict';

  async function reviewAnswer(answer, userQuery) {
    // Use LLM for richer critique if available
    try {
      const settings = (typeof SettingsController !== 'undefined' && SettingsController.getSettings)
        ? SettingsController.getSettings()
        : {};
      const model = settings.selectedModel || 'gpt-4.1-mini';
      const prompt = `You are a critique assistant. Given the question: "${userQuery}" and the answer: "${answer}", provide constructive critique if the answer is too short or unhelpful. If the answer is adequate, reply "OK".`;
      const res = await ApiService.sendOpenAIRequest(model, [
        { role: 'system', content: 'You critique AI-generated answers for completeness and usefulness.' },
        { role: 'user', content: prompt }
      ]);
      const critique = res.choices[0].message.content.trim();
      return critique === 'OK' ? null : critique;
    } catch (err) {
      // Fallback to simple heuristics
      if (!answer || answer.length < 50) return 'Answer too short, read more or try another source.';
      if (/not found|no information|no useful/i.test(answer)) {
        return 'No useful info found, try a new search term.';
      }
      return null;
    }
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