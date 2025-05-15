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

  // Helper for structured debug logging
  debugLog(level, msg, obj = null, style = '') {
    if (!this.debug) return;
    const base = `%c[ExecutionAgent][${level}]`;
    const color = level === 'ERROR' ? 'color: #d32f2f; font-weight: bold;' :
                 level === 'WARN' ? 'color: #fbc02d; font-weight: bold;' :
                 level === 'STEP' ? 'color: #1976d2; font-weight: bold;' :
                 'color: #333;';
    if (obj) {
      console.log(base + ' ' + msg, color + (style || ''), obj);
    } else {
      console.log(base + ' ' + msg, color + (style || ''));
    }
  }

  /**
   * Executes a plan step by step.
   * @param {Array} plan - Array of plan steps.
   * @param {Function} narrateFn - Optional. Function to narrate each step (e.g., UI message).
   * @returns {Array} results - Array of results for each step.
   */
  async executePlan(plan, narrateFn = null) {
    this.debugLog('STEP', '--- PLAN EXECUTION START ---');
    this.debugLog('STEP', 'Full plan:', plan);
    const results = [];
    let webSearchResults = null;
    let collectedSnippets = [];
    let i = 0;
    const planStart = Date.now();
    console.groupCollapsed('%c[ExecutionAgent][PLAN] Plan Execution', 'color: #512da8; font-weight: bold;');
    while (i < plan.length) {
      const step = plan[i];
      const stepLabel = `Step ${step.step} [${step.tool}]`;
      const stepStart = Date.now();
      console.groupCollapsed(`%c[ExecutionAgent][STEP] ${stepLabel} - ${step.description}`, 'color: #1976d2; font-weight: bold;');
      this.debugLog('STEP', `[Agent] Entering plan step: ${stepLabel}`, step);
      this.debugLog('STEP', `Executing ${stepLabel}: ${step.description}`);
      this.debugLog('STEP', 'Step arguments:', step.arguments);
      this.debugLog('STEP', 'Plan state before step:', plan);
      // Handle summarize step internally BEFORE tool handler lookup
      if (step.tool === 'summarize') {
        step.arguments.snippets = collectedSnippets.slice();
        this.debugLog('STEP', `Passing collected snippets to summarize step`, collectedSnippets);
        await this.summarizeAndSynthesize(collectedSnippets.slice(), plan[0]?.arguments?.query || '', narrateFn);
        const stepEnd = Date.now();
        this.debugLog('STEP', `Completed ${stepLabel} in ${stepEnd - stepStart}ms`);
        this.debugLog('STEP', 'Plan state after step:', plan);
        console.groupEnd();
        i++;
        this.debugLog('STEP', `[Agent] Exiting plan step: ${stepLabel}`, step);
        continue;
      }
      // Fill in read_url step URLs dynamically from web_search results
      if (step.tool === 'read_url' && step.arguments.url === '<<TO_BE_FILLED_BY_EXECUTOR>>') {
        if (!Array.isArray(webSearchResults)) {
          this.debugLog('STEP', '[Agent] Skipping read_url step: No web search results available.', step);
        } else {
          const readUrlSteps = plan.filter(s => s.tool === 'read_url');
          const thisReadUrlIndex = readUrlSteps.indexOf(step);
          if (!webSearchResults[thisReadUrlIndex]) {
            this.debugLog('STEP', `[Agent] Skipping read_url step #${thisReadUrlIndex + 1}: No corresponding web search result.`, step);
          }
        }
      }
      if (typeof narrateFn === 'function') {
        await narrateFn(`Step ${step.step}: ${step.description}`);
      }
      const toolFn = this.toolHandlers[step.tool];
      if (!toolFn) {
        this.debugLog('ERROR', `Tool handler for "${step.tool}" not found.`);
        if (typeof narrateFn === 'function') {
          await narrateFn(`Error: Tool handler for "${step.tool}" not found.`);
        }
        results.push({ step: step.step, error: `Error: Tool handler for "${step.tool}" not found.` });
        this.debugLog('STEP', 'Plan state after step:', plan);
        console.groupEnd();
        i++;
        this.debugLog('STEP', `[Agent] Exiting plan step: ${stepLabel}`, step);
        continue;
      }
      try {
        this.debugLog('STEP', `[Agent] Tool handler called: ${step.tool}`, step.arguments);
        if (step.tool === 'read_url') {
          let snippet = '';
          let url = step.arguments.url;
          // Use AutoReaderAgent for adaptive reading
          snippet = await AutoReaderAgent.readAdaptively(
            this.toolHandlers.read_url,
            url,
            plan[0]?.arguments?.query || '',
            async (prompt) => {
              // Use LLM for "enough info?" check (reuse deep reading logic)
              const selectedModel = (typeof SettingsController !== 'undefined' && SettingsController.getSettings) ? SettingsController.getSettings().selectedModel : 'gpt-4.1-mini';
              if (selectedModel.startsWith('gpt')) {
                if (typeof ApiService !== 'undefined' && ApiService.sendOpenAIRequest) {
                  const res = await ApiService.sendOpenAIRequest(selectedModel, [
                    { role: 'system', content: 'You are an assistant that decides if more content is needed from a web page.' },
                    { role: 'user', content: prompt }
                  ]);
                  return res.choices[0].message.content.trim();
                }
              } else if (selectedModel.startsWith('gemini') || selectedModel.startsWith('gemma')) {
                if (typeof ApiService !== 'undefined' && ApiService.createGeminiSession) {
                  const session = ApiService.createGeminiSession(selectedModel);
                  const chatHistory = [
                    { role: 'system', content: 'You are an assistant that decides if more content is needed from a web page.' },
                    { role: 'user', content: prompt }
                  ];
                  const result = await session.sendMessage(prompt, chatHistory);
                  const candidate = result.candidates[0];
                  if (candidate.content.parts) {
                    return candidate.content.parts.map(p => p.text).join(' ').trim();
                  } else if (candidate.content.text) {
                    return candidate.content.text.trim();
                  }
                }
              }
              return 'NO';
            }
          );
          collectedSnippets.push(snippet);
          this.debugLog('STEP', 'Collected snippets after read_url:', collectedSnippets);
          results.push({ step: step.step, result: { url, snippet } });
          this.debugLog('STEP', `Deep reading complete for ${url}, snippet length: ${snippet.length}`);
          if (typeof narrateFn === 'function') {
            await narrateFn(`Read content from [Source](${url}):\n${snippet.slice(0, 500)}${snippet.length > 500 ? '... (truncated)' : ''}`);
          }
        } else {
          const result = await toolFn(step.arguments);
          this.debugLog('STEP', 'Tool call result:', result);
          results.push({ step: step.step, result });
          this.debugLog('STEP', `Result for step ${step.step} :`, result);
          if (typeof narrateFn === 'function') {
            if (step.tool === 'web_search' && Array.isArray(result)) {
              if (result.length === 0) {
                await narrateFn('No search results found.');
              } else {
                const formatted = result.slice(0, 3).map((r, i) => `${i+1}. [${r.title}](${r.url}): ${r.snippet}`).join('\n');
                await narrateFn(`Top search results:\n${formatted}`);
              }
            } else if (step.tool === 'instant_answer' && result && typeof result === 'object') {
              await narrateFn(`Instant answer: ${JSON.stringify(result)}`);
            } else if (result && result.error) {
              await narrateFn(`Error: ${result.error}`);
            } else {
              await narrateFn(`Result: ${JSON.stringify(result)}`);
            }
          }
          if (step.tool === 'web_search' && Array.isArray(result)) {
            this.debugLog('STEP', '[Agent] SourceFilteringAgent: Filtering web search results...', result);
            webSearchResults = filterRelevantResults(result, step.arguments.query);
            this.debugLog('STEP', '[Agent] DeduplicationAgent: Deduplicating web search results...', webSearchResults);
            webSearchResults = deduplicateResults(webSearchResults);
            this.debugLog('STEP', '[Agent] Filtered and deduplicated web search results:', webSearchResults);
            // --- AI-driven selection of which results to read ---
            if (webSearchResults.length > 0) {
              const prompt = `Given these search results for the query: "${step.arguments.query}", which results (by number) are most relevant to read in detail?\n\n${webSearchResults.map((r, idx) => `${idx+1}. ${r.title} - ${r.snippet}`).join('\n')}\n\nReply with a comma-separated list of result numbers.`;
              this.debugLog('STEP', 'Result selection LLM prompt:', prompt);
              let aiReply = '';
              let selectedIndices = [];
              try {
                const selectedModel = (typeof SettingsController !== 'undefined' && SettingsController.getSettings) ? SettingsController.getSettings().selectedModel : 'gpt-4.1-mini';
                if (selectedModel.startsWith('gpt')) {
                  if (typeof ApiService !== 'undefined' && ApiService.sendOpenAIRequest) {
                    const res = await ApiService.sendOpenAIRequest(selectedModel, [
                      { role: 'system', content: 'You are an assistant helping to select the most relevant search results.' },
                      { role: 'user', content: prompt }
                    ]);
                    aiReply = res.choices[0].message.content.trim();
                  }
                } else if (selectedModel.startsWith('gemini') || selectedModel.startsWith('gemma')) {
                  if (typeof ApiService !== 'undefined' && ApiService.createGeminiSession) {
                    const session = ApiService.createGeminiSession(selectedModel);
                    const chatHistory = [
                      { role: 'system', content: 'You are an assistant helping to select the most relevant search results.' },
                      { role: 'user', content: prompt }
                    ];
                    const result = await session.sendMessage(prompt, chatHistory);
                    const candidate = result.candidates[0];
                    if (candidate.content.parts) {
                      aiReply = candidate.content.parts.map(p => p.text).join(' ').trim();
                    } else if (candidate.content.text) {
                      aiReply = candidate.content.text.trim();
                    }
                  }
                }
                this.debugLog('STEP', `AI reply for result selection: ${aiReply}`);
                const match = aiReply && aiReply.match(/([\d, ]+)/);
                if (match) {
                  selectedIndices = match[1].split(',').map(s => parseInt(s.trim(), 10) - 1).filter(n => !isNaN(n) && n >= 0 && n < webSearchResults.length);
                }
                this.debugLog('STEP', 'Selected indices for read_url:', selectedIndices);
              } catch (err) {
                this.debugLog('WARN', 'Error in AI-driven result selection:', err && err.stack ? err.stack : err);
                selectedIndices = [0, 1, 2].filter(idx => idx < webSearchResults.length);
              }
              let readUrlStepIdx = 0;
              for (let j = 0; j < plan.length; j++) {
                if (plan[j].tool === 'read_url') {
                  if (selectedIndices[readUrlStepIdx] !== undefined && webSearchResults[selectedIndices[readUrlStepIdx]]) {
                    plan[j].arguments.url = webSearchResults[selectedIndices[readUrlStepIdx]].url;
                  } else {
                    this.debugLog('STEP', `Removing read_url step at index ${j} due to insufficient selected results.`);
                    plan.splice(j, 1);
                    j--;
                  }
                  readUrlStepIdx++;
                }
              }
              this.debugLog('STEP', 'Plan after result selection:', plan);
            }
          }
          if (step.tool === 'web_search' && Array.isArray(result) && result.length === 0) {
            const alreadyHasInstant = plan.some(s => s.tool === 'instant_answer');
            if (!alreadyHasInstant) {
              const instantStep = {
                step: step.step + 1,
                description: `Fallback: Get instant answer for "${step.arguments.query}"`,
                tool: 'instant_answer',
                arguments: { query: step.arguments.query }
              };
              this.debugLog('STEP', 'Adding fallback instant_answer step:', instantStep);
              plan.splice(i + 1, 0, instantStep);
              this.debugLog('STEP', 'Plan after adding instant_answer:', plan);
            }
          }
        }
      } catch (err) {
        this.debugLog('ERROR', `[Agent] Error in step ${step.step}: ${err.message}`, err && err.stack ? err.stack : err);
        if (typeof narrateFn === 'function') {
          await narrateFn(`Error in step ${step.step}: ${err.message}`);
        }
        results.push({ step: step.step, error: `Error in step ${step.step}: ${err.message}` });
        this.debugLog('STEP', 'Plan state after step:', plan);
        console.groupEnd();
        break;
      }
      const stepEnd = Date.now();
      this.debugLog('STEP', `Completed ${stepLabel} in ${stepEnd - stepStart}ms`);
      this.debugLog('STEP', 'Plan state after step:', plan);
      console.groupEnd();
      i++;
      this.debugLog('STEP', `[Agent] Exiting plan step: ${stepLabel}`, step);
    }
    const planEnd = Date.now();
    this.debugLog('STEP', `--- PLAN EXECUTION END --- (${planEnd - planStart}ms)`);
    this.debugLog('STEP', 'Final results:', results);
    console.groupEnd();
    return results;
  }

  /**
   * Recursively summarizes snippets and synthesizes a final answer.
   * @param {Array<string>} snippets - The content snippets to summarize.
   * @param {string} userQuery - The original user question.
   * @param {Function} narrateFn - Narration callback.
   * @param {number} round - Recursion round.
   */
  async summarizeAndSynthesize(snippets, userQuery, narrateFn, round = 1) {
    if (!snippets || !snippets.length) return;
    const selectedModel = (typeof SettingsController !== 'undefined' && SettingsController.getSettings) ? SettingsController.getSettings().selectedModel : 'gpt-4.1-mini';
    const MAX_PROMPT_LENGTH = 5857;
    const SUMMARIZATION_TIMEOUT = 88000;
    function splitIntoBatches(snips, maxLen) {
      const batches = [];
      let current = [];
      let currentLen = 0;
      for (const s of snips) {
        if (currentLen + s.length > maxLen && current.length) {
          batches.push(current);
          current = [];
          currentLen = 0;
        }
        current.push(s);
        currentLen += s.length;
      }
      if (current.length) batches.push(current);
      return batches;
    }
    if (snippets.length === 1) {
      const prompt = `Summarize the following information extracted from web pages (be as concise as possible):\n\n${snippets[0]}`;
      let aiReply = '';
      this.debugLog('STEP', `[Summarize] Round ${round}: Summarizing single snippet...`);
      this.debugLog('STEP', 'Summarization LLM prompt:', prompt);
      if (typeof narrateFn === 'function') await narrateFn(`Round ${round}: Summarizing information...`);
      try {
        if (selectedModel.startsWith('gpt')) {
          if (typeof ApiService !== 'undefined' && ApiService.sendOpenAIRequest) {
            const res = await ApiService.sendOpenAIRequest(selectedModel, [
              { role: 'system', content: 'You are an assistant that synthesizes information from multiple sources.' },
              { role: 'user', content: prompt }
            ], SUMMARIZATION_TIMEOUT);
            aiReply = res.choices[0].message.content.trim();
          }
        } else if (selectedModel.startsWith('gemini') || selectedModel.startsWith('gemma')) {
          if (typeof ApiService !== 'undefined' && ApiService.createGeminiSession) {
            const session = ApiService.createGeminiSession(selectedModel);
            const chatHistory = [
              { role: 'system', content: 'You are an assistant that synthesizes information from multiple sources.' },
              { role: 'user', content: prompt }
            ];
            const result = await session.sendMessage(prompt, chatHistory);
            const candidate = result.candidates[0];
            if (candidate.content.parts) {
              aiReply = candidate.content.parts.map(p => p.text).join(' ').trim();
            } else if (candidate.content.text) {
              aiReply = candidate.content.text.trim();
            }
          }
        }
        this.debugLog('STEP', 'Summarization LLM response:', aiReply);
        if (aiReply && typeof narrateFn === 'function') {
          await narrateFn(`Summary:\n${aiReply}`);
        }
      } catch (err) {
        this.debugLog('ERROR', 'Summarization failed.', err && err.stack ? err.stack : err);
        if (typeof narrateFn === 'function') await narrateFn(`Summarization failed. Error: ${err && err.message ? err.message : err}`);
        return;
      }
      await this.synthesizeFinalAnswer(aiReply, userQuery, narrateFn);
      this.debugLog('STEP', '[Agent] Summarization complete. Single summary length:', aiReply.length);
      return;
    }
    const batches = splitIntoBatches(snippets, MAX_PROMPT_LENGTH);
    let batchSummaries = [];
    const totalBatches = batches.length;
    try {
      for (let i = 0; i < totalBatches; i++) {
        const batch = batches[i];
        this.debugLog('STEP', `[Summarize] Round ${round}: Summarizing batch ${i + 1} of ${totalBatches}...`);
        const batchPrompt = `Summarize the following information extracted from web pages (be as concise as possible):\n\n${batch.join('\n---\n')}`;
        this.debugLog('STEP', 'Summarization LLM prompt:', batchPrompt);
        if (typeof narrateFn === 'function') await narrateFn(`Round ${round}: Summarizing batch ${i + 1} of ${totalBatches}...`);
        let batchReply = '';
        if (selectedModel.startsWith('gpt')) {
          if (typeof ApiService !== 'undefined' && ApiService.sendOpenAIRequest) {
            const res = await ApiService.sendOpenAIRequest(selectedModel, [
              { role: 'system', content: 'You are an assistant that synthesizes information from multiple sources.' },
              { role: 'user', content: batchPrompt }
            ], SUMMARIZATION_TIMEOUT);
            batchReply = res.choices[0].message.content.trim();
          }
        } else if (selectedModel.startsWith('gemini') || selectedModel.startsWith('gemma')) {
          if (typeof ApiService !== 'undefined' && ApiService.createGeminiSession) {
            const session = ApiService.createGeminiSession(selectedModel);
            const chatHistory = [
              { role: 'system', content: 'You are an assistant that synthesizes information from multiple sources.' },
              { role: 'user', content: batchPrompt }
            ];
            const result = await session.sendMessage(batchPrompt, chatHistory);
            const candidate = result.candidates[0];
            if (candidate.content.parts) {
              batchReply = candidate.content.parts.map(p => p.text).join(' ').trim();
            } else if (candidate.content.text) {
              batchReply = candidate.content.text.trim();
            }
          }
        }
        this.debugLog('STEP', 'Summarization LLM response:', batchReply);
        batchSummaries.push(batchReply);
      }
      const combined = batchSummaries.join('\n---\n');
      if (combined.length > MAX_PROMPT_LENGTH) {
        this.debugLog('STEP', `[Summarize] Round ${round + 1}: Combining summaries...`);
        if (typeof narrateFn === 'function') await narrateFn(`Round ${round + 1}: Combining summaries...`);
        await this.summarizeAndSynthesize(batchSummaries, userQuery, narrateFn, round + 1);
      } else {
        this.debugLog('STEP', `[Summarize] Round ${round}: Finalizing summary...`);
        if (typeof narrateFn === 'function') await narrateFn(`Round ${round}: Finalizing summary...`);
        if (typeof narrateFn === 'function') await narrateFn(`Summary:\n${combined}`);
        await this.synthesizeFinalAnswer(combined, userQuery, narrateFn);
      }
      this.debugLog('STEP', '[Agent] Summarization complete. Combined summary length:', combined.length);
    } catch (err) {
      this.debugLog('ERROR', 'Summarization failed.', err && err.stack ? err.stack : err);
      if (typeof narrateFn === 'function') await narrateFn(`Summarization failed. Error: ${err && err.message ? err.message : err}`);
    }
  }

  /**
   * Synthesizes a final answer from summaries and the original question.
   * @param {string} summaries - The summaries to synthesize from.
   * @param {string} userQuery - The original user question.
   * @param {Function} narrateFn - Narration callback.
   */
  async synthesizeFinalAnswer(summaries, userQuery, narrateFn) {
    if (!summaries || !userQuery) return;
    const selectedModel = (typeof SettingsController !== 'undefined' && SettingsController.getSettings) ? SettingsController.getSettings().selectedModel : 'gpt-4.1-mini';
    const prompt = `Based on the following summaries, provide a final, concise answer to the original question.\n\nSummaries:\n${summaries}\n\nOriginal question: ${userQuery}`;
    let finalAnswer = '';
    this.debugLog('STEP', '[Synthesize] Final answer LLM prompt:', prompt);
    try {
      if (selectedModel.startsWith('gpt')) {
        if (typeof ApiService !== 'undefined' && ApiService.sendOpenAIRequest) {
          const res = await ApiService.sendOpenAIRequest(selectedModel, [
            { role: 'system', content: 'You are an assistant that synthesizes information from multiple sources and provides a final answer.' },
            { role: 'user', content: prompt }
          ]);
          finalAnswer = res.choices[0].message.content.trim();
        }
      } else if (selectedModel.startsWith('gemini') || selectedModel.startsWith('gemma')) {
        if (typeof ApiService !== 'undefined' && ApiService.createGeminiSession) {
          const session = ApiService.createGeminiSession(selectedModel);
          const chatHistory = [
            { role: 'system', content: 'You are an assistant that synthesizes information from multiple sources and provides a final answer.' },
            { role: 'user', content: prompt }
          ];
          const result = await session.sendMessage(prompt, chatHistory);
          const candidate = result.candidates[0];
          if (candidate.content.parts) {
            finalAnswer = candidate.content.parts.map(p => p.text).join(' ').trim();
          } else if (candidate.content.text) {
            finalAnswer = candidate.content.text.trim();
          }
        }
      }
      this.debugLog('STEP', '[Synthesize] Final answer LLM response:', finalAnswer);
      if (finalAnswer && typeof narrateFn === 'function') {
        await narrateFn(`Final Answer:\n${finalAnswer}`);
      }
      if (!isAnswerRelevant(finalAnswer, userQuery)) {
        this.debugLog('STEP', '[Agent] CriticAgent: Final answer flagged as too generic or not relevant.', finalAnswer);
        if (typeof narrateFn === 'function') {
          await narrateFn('The answer may be too generic or not relevant. Please try to be more specific in your query.');
        }
      }
    } catch (err) {
      this.debugLog('ERROR', 'Final answer synthesis failed.', err && err.stack ? err.stack : err);
      if (typeof narrateFn === 'function') await narrateFn(`Final answer synthesis failed. Error: ${err && err.message ? err.message : err}`);
    }
  }
}

// Export for use in other modules
if (typeof module !== 'undefined') module.exports = { ExecutionAgent };
if (typeof window !== 'undefined') window.ExecutionAgent = ExecutionAgent;

// Source Filtering Agent
function filterRelevantResults(results, query) {
  // Example: Only keep car-related results for car queries
  if (/car|auto|vehicle|model|spec/i.test(query)) {
    return results.filter(r => /car|auto|vehicle|sedan|suv|hatchback|proton|toyota|honda|tesla|bmw|mercedes|nissan|ford|chevrolet|hyundai|kia|mazda|mitsubishi|volkswagen|audi|lexus|subaru|volvo|peugeot|renault|citroen|fiat|jeep|land rover|jaguar|porsche|mini|infiniti|acura|cadillac|chrysler|dodge|ram|gmc|lincoln|buick|genesis|alfa romeo|aston martin|bentley|bugatti|ferrari|lamborghini|maserati|mclaren|rolls-royce/i.test(r.title + r.snippet + r.url));
  }
  return results;
}

// Deduplication Agent
function deduplicateResults(results) {
  const seen = new Set();
  return results.filter(r => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

// Critic Agent
function isAnswerRelevant(answer, query) {
  return answer && answer.length > 30 && !/database|tool|winner|nominee|not sure|no relevant|no result|no answer|unclear|generic|broad|ambiguous|all models|all specs|all prices/i.test(answer);
} 