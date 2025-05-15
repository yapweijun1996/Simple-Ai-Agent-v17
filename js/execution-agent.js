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
        continue;
      }
      // Fill in read_url step URLs dynamically from web_search results
      if (step.tool === 'read_url' && step.arguments.url === '<<TO_BE_FILLED_BY_EXECUTOR>>') {
        if (Array.isArray(webSearchResults)) {
          const readUrlSteps = plan.filter(s => s.tool === 'read_url');
          const thisReadUrlIndex = readUrlSteps.indexOf(step);
          if (webSearchResults[thisReadUrlIndex]) {
            step.arguments.url = webSearchResults[thisReadUrlIndex].url;
            this.debugLog('STEP', `Filled read_url step #${thisReadUrlIndex + 1} with URL: ${step.arguments.url}`);
          } else {
            this.debugLog('WARN', `No web search result for read_url step #${thisReadUrlIndex + 1}, skipping step.`);
            if (typeof narrateFn === 'function') {
              await narrateFn(`Skipping read_url step #${thisReadUrlIndex + 1}: No corresponding web search result.`);
            }
            this.debugLog('STEP', 'Plan state after step:', plan);
            console.groupEnd();
            i++;
            continue;
          }
        } else {
          this.debugLog('WARN', 'No web search results available to fill read_url step, skipping.');
          if (typeof narrateFn === 'function') {
            await narrateFn('Skipping read_url step: No web search results available.');
          }
          this.debugLog('STEP', 'Plan state after step:', plan);
          console.groupEnd();
          i++;
          continue;
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
        continue;
      }
      try {
        this.debugLog('STEP', `Calling tool: ${step.tool} with args:`, step.arguments);
        if (step.tool === 'read_url') {
          let snippet = '';
          let url = step.arguments.url;
          let start = 0;
          let chunkSize = 2000;
          let maxChunks = 5;
          let totalLength = 0;
          let shouldContinue = true;
          let chunkCount = 0;
          while (shouldContinue && chunkCount < maxChunks && totalLength < 10000) {
            this.debugLog('STEP', `read_url chunk: url=${url}, start=${start}, length=${chunkSize}`);
            const result = await toolFn({ url, start, length: chunkSize });
            this.debugLog('STEP', 'read_url result:', result);
            if (!result || !result.snippet) break;
            snippet += result.snippet;
            totalLength += result.snippet.length;
            // Ask LLM if more is needed
            let aiReply = '';
            try {
              const prompt = `Given the following snippet from ${url}, do you need more content to answer the user's question? Please reply with "YES" or "NO" and a brief reason. If YES, estimate how many more characters you need.\n\nSnippet:\n${result.snippet}`;
              this.debugLog('STEP', 'Deep reading LLM prompt:', prompt);
              const selectedModel = (typeof SettingsController !== 'undefined' && SettingsController.getSettings) ? SettingsController.getSettings().selectedModel : 'gpt-4.1-mini';
              if (selectedModel.startsWith('gpt')) {
                if (typeof ApiService !== 'undefined' && ApiService.sendOpenAIRequest) {
                  const res = await ApiService.sendOpenAIRequest(selectedModel, [
                    { role: 'system', content: 'You are an assistant that decides if more content is needed from a web page.' },
                    { role: 'user', content: prompt }
                  ]);
                  aiReply = res.choices[0].message.content.trim().toLowerCase();
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
                    aiReply = candidate.content.parts.map(p => p.text).join(' ').trim().toLowerCase();
                  } else if (candidate.content.text) {
                    aiReply = candidate.content.text.trim().toLowerCase();
                  }
                }
              }
              this.debugLog('STEP', 'Deep reading LLM response:', aiReply);
            } catch (err) {
              this.debugLog('WARN', 'Error in deep reading LLM call:', err && err.stack ? err.stack : err);
              shouldContinue = false;
              break;
            }
            if (aiReply.startsWith('yes') && totalLength < 10000) {
              start += chunkSize;
              chunkCount++;
              shouldContinue = true;
            } else {
              shouldContinue = false;
            }
          }
          collectedSnippets.push(snippet);
          this.debugLog('STEP', 'Collected snippets after read_url:', collectedSnippets);
          results.push({ step: step.step, result: { url, snippet } });
          this.debugLog('STEP', `Deep reading complete for ${url}, snippet length: ${snippet.length}`);
          if (typeof narrateFn === 'function') {
            await narrateFn(`Deep reading complete for ${url}, snippet length: ${snippet.length}`);
          }
        } else {
          const result = await toolFn(step.arguments);
          this.debugLog('STEP', 'Tool call result:', result);
          results.push({ step: step.step, result });
          this.debugLog('STEP', `Result for step ${step.step} :`, result);
          if (typeof narrateFn === 'function') {
            await narrateFn(`Result: ${JSON.stringify(result)}`);
          }
          if (step.tool === 'web_search' && Array.isArray(result)) {
            webSearchResults = result;
            this.debugLog('STEP', 'Web search results:', webSearchResults);
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
        this.debugLog('ERROR', `Error in step ${step.step}: ${err.message}`, err && err.stack ? err.stack : err);
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
    } catch (err) {
      this.debugLog('ERROR', 'Final answer synthesis failed.', err && err.stack ? err.stack : err);
      if (typeof narrateFn === 'function') await narrateFn(`Final answer synthesis failed. Error: ${err && err.message ? err.message : err}`);
    }
  }
}

// Export for use in other modules
if (typeof module !== 'undefined') module.exports = { ExecutionAgent };
if (typeof window !== 'undefined') window.ExecutionAgent = ExecutionAgent; 