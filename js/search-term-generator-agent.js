const SearchTermGeneratorAgent = (function() {
  'use strict';

  async function generateSearchTerms(userQuery) {
    // Try LLM-driven search term generation if available
    try {
      const settings = (typeof SettingsController !== 'undefined' && SettingsController.getSettings)
        ? SettingsController.getSettings()
        : {};
      const model = settings.selectedModel || 'gpt-4.1-mini';
      const prompt = `Generate a JSON array of 3 search queries that best match the user question: "${userQuery}".`;
      const res = await ApiService.sendOpenAIRequest(model, [
        { role: 'system', content: 'You are an assistant that generates effective search queries.' },
        { role: 'user', content: prompt }
      ]);
      const content = res.choices[0].message.content.trim();
      let terms = JSON.parse(content);
      if (Array.isArray(terms) && terms.length > 0) return terms;
    } catch (err) {
      // Fallback to heuristic generation
    }
    // Heuristic fallback
    const context = MemoryAgent.getRelevantContext(userQuery);
    let baseTerm = userQuery.trim();
    if (baseTerm.length < 5 && context.lastTopic) {
      baseTerm = `${context.lastTopic} ${baseTerm}`;
    }
    const searchTerms = [baseTerm];
    if (/all|list|every/i.test(baseTerm) && context.lastTopic) {
      searchTerms.push(`${context.lastTopic} specs`, `${context.lastTopic} review`, `${context.lastTopic} price`);
    }
    return searchTerms;
  }

  return { generateSearchTerms };
})(); 