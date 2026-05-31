// ============================================================================
// ReAct Loop Orchestrator
//
// "思考 → 感知 → 操作 → 验证" 完整闭环
//
// Drives the conversation between DeepSeek and the content script:
//   1. DeepSeek decides what tool to call
//   2. Background Worker executes the tool via content script
//   3. Result feeds back to DeepSeek
//   4. Repeat until finish_task or user stops
//
// Features:
//   - AbortController-based cancellation
//   - Step-by-step checkpoint persistence
//   - Error self-healing (retry + circuit breaker + degradation)
//   - Streaming thought display to Side Panel
//   - ask_user pause/resume
// ============================================================================

import { streamChat, chat, type ChatMessage, type CompletedToolCall } from '../api/deepseek';
import {
  callDoubaoVision,
  isDoubaoCircuitOpen,
  stripDataUrlPrefix,
  buildDegradationNotice,
} from '../api/doubao';
import {
  saveConversation,
  saveLoopSummary,
  setReactState,
  getReactState,
  registerActiveSession,
  unregisterActiveSession,
} from '../shared/storage';
import type {
  ReactLoopState,
  OperationRecord,
  ConversationHistory,
} from '../shared/storage';
import type { Action, SemanticStructureResponse } from '../shared/messages';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ReactLoopConfig {
  tabId: number;
  userTask: string;
  maxSteps?: number; // default 10
  abortSignal?: AbortSignal;
  onStreamUpdate?: (update: StreamUpdate) => void;
  onStepComplete?: (step: LoopStep) => void;
  onAskUser?: (question: string) => Promise<string | null>; // returns null if cancelled
  onError?: (error: Error, stepIndex: number) => void;
  onComplete?: (summary: string) => void;
}

export interface StreamUpdate {
  type: 'stream_chunk' | 'step_status';
  stepId: string;
  delta?: string;
  done?: boolean;
  status?: 'thinking' | 'executing' | 'completed' | 'errored' | 'waiting_user';
  detail?: string;
}

export interface LoopStep {
  index: number;
  thought: string;
  toolCall?: { name: string; arguments: Record<string, unknown> };
  result?: { success: boolean; data?: unknown; error?: string };
  tokensUsed: number;
}

export type LoopStatus = 'idle' | 'thinking' | 'executing' | 'waiting_user' | 'completed' | 'errored' | 'stopped';

// ─── Internal State ────────────────────────────────────────────────────────

const MAX_STEPS_DEFAULT = 50;
const MAX_GLOBAL_TOOL_CALLS = 50;

// Operation hash tracking for idempotency
const executedOperations = new Map<number, Set<string>>(); // per tabId

// ─── Main Loop ─────────────────────────────────────────────────────────────

/**
 * Execute the full ReAct loop for a user task.
 *
 * This is the OUTER LOOP: it sets up the conversation, calls DeepSeek,
 * executes tool calls, feeds results back, and repeats until finish.
 */
export async function runReactLoop(config: ReactLoopConfig): Promise<void> {
  const {
    tabId,
    userTask,
    maxSteps = MAX_STEPS_DEFAULT,
    abortSignal,
    onStreamUpdate,
    onStepComplete,
    onAskUser,
    onError,
    onComplete,
  } = config;

  // Check abort
  if (abortSignal?.aborted) return;

  // Build initial messages
  const { buildSystemPrompt } = await import('../api/deepseek');
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: userTask },
  ];

  let totalTokens = 0;
  let globalToolCallCount = 0;
  let _abortRetries = 0;
  const steps: LoopStep[] = [];
  const observationHistory: string[] = [];
  const operationHistory: OperationRecord[] = [];

  // Initialize session state
  await registerActiveSession({
    tabId,
    url: '',
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    loopStatus: 'thinking',
  });

  // Initialize conversation in persistent storage
  const conversation: ConversationHistory = {
    tabId,
    messages: [],
    totalTokens: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // Step 1: Get initial page structure
  onStreamUpdate?.({
    type: 'step_status',
    stepId: 'init',
    status: 'executing',
    detail: '正在读取页面结构...',
  });

  const initResult = await sendToContentScript(tabId, 'get_page_semantic_structure', {}, abortSignal);
  if (initResult.success && initResult.data) {
    const structure = initResult.data as SemanticStructureResponse['data'];
    messages.push({
      role: 'user',
      content: `当前页面: ${structure.title}\nURL: ${structure.url}\n\n页面语义骨架:\n${JSON.stringify(structure, null, 2)}`,
    });
    observationHistory.push(`页面: ${structure.title} (${structure.interactiveElements.length} 个交互元素)`);
  }

  // Main loop
  for (let stepIndex = 0; stepIndex < maxSteps; stepIndex++) {
    // Check global stop flag (set by Side Panel stop button)
    if (abortSignal?.aborted || (globalThis as any).__stopRequested?.(tabId)) {
      _abortRetries = 0;
      onStreamUpdate?.({
        type: 'step_status',
        stepId: `step_${stepIndex}`,
        status: 'errored',
        detail: '任务已取消',
      });
      await finalizeSession(tabId, steps, 'stopped');
      return;
    }

    // Check global tool call limit
    if (globalToolCallCount >= MAX_GLOBAL_TOOL_CALLS) {
      onStreamUpdate?.({
        type: 'step_status',
        stepId: `step_${stepIndex}`,
        status: 'errored',
        detail: '达到最大操作次数限制',
      });
      await finalizeSession(tabId, steps, 'errored');
      onError?.(new Error(`达到最大操作次数 (${MAX_GLOBAL_TOOL_CALLS})`), stepIndex);
      return;
    }

    onStreamUpdate?.({
      type: 'step_status',
      stepId: `step_${stepIndex}`,
      status: 'thinking',
      detail: `第 ${stepIndex + 1}/${maxSteps} 步 — 正在思考...`,
    });

    // Persist checkpoint
    await persistCheckpoint(tabId, stepIndex, observationHistory, operationHistory);

    // Call DeepSeek
    let fullThought = '';
    let toolCall: CompletedToolCall | null = null;

    try {
      const result = await streamChat(
        messages,
        {
          onTextDelta: (delta, fullText) => {
            fullThought = fullText;
            onStreamUpdate?.({
              type: 'stream_chunk',
              stepId: `step_${stepIndex}`,
              delta,
            });
          },
          onComplete: (usage) => {
            totalTokens += usage.totalTokens;
          },
        },
        undefined,
        abortSignal,
      );

      fullThought = result.content ?? '';
      totalTokens += result.usage.totalTokens;

      // Pick the first tool call (if any)
      if (result.toolCalls.length > 0) {
        toolCall = result.toolCalls[0];

        // Validate tool call arguments
        const { parseToolArguments } = await import('../api/deepseek');
        const parseResult = await parseToolArguments(
          toolCall.name,
          JSON.stringify(toolCall.arguments),
          async () => {
            // Retry: call DeepSeek again with error feedback
            messages.push({
              role: 'user',
              content: 'Your last response was not valid JSON. Please retry with valid format.',
            });
            return chat(messages, undefined, abortSignal);
          },
        );

        if (!parseResult.success) {
          onStreamUpdate?.({
            type: 'step_status',
            stepId: `step_${stepIndex}`,
            status: 'errored',
            detail: `JSON 解析失败: ${parseResult.error}`,
          });
          continue;
        }

        toolCall.arguments = parseResult.arguments!;
      }

    } catch (err) {
      if (abortSignal?.aborted) return;
      onStreamUpdate?.({
        type: 'step_status',
        stepId: `step_${stepIndex}`,
        status: 'errored',
        detail: `DeepSeek API 调用失败: ${err instanceof Error ? err.message : String(err)}`,
      });
      onError?.(err instanceof Error ? err : new Error(String(err)), stepIndex);
      continue;
    }

    // Add assistant message to history
    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: fullThought,
    };
    if (toolCall) {
      assistantMsg.tool_calls = [{
        id: toolCall.id,
        type: 'function' as const,
        function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
        index: 0,
      }];
    }
    messages.push(assistantMsg);

    // Check for special actions
    if (toolCall?.name === 'finish_task') {
      onStreamUpdate?.({
        type: 'step_status',
        stepId: `step_${stepIndex}`,
        status: 'completed',
        detail: `任务完成: ${toolCall.arguments.summary}`,
      });
      steps.push({
        index: stepIndex,
        thought: fullThought,
        toolCall: { name: toolCall.name, arguments: toolCall.arguments },
        tokensUsed: totalTokens,
      });
      await finalizeSession(tabId, steps, 'completed');
      onComplete?.(toolCall.arguments.summary as string);
      return;
    }

    if (toolCall?.name === 'ask_user') {
      onStreamUpdate?.({
        type: 'step_status',
        stepId: `step_${stepIndex}`,
        status: 'waiting_user',
        detail: `等待用户回答: ${toolCall.arguments.question}`,
      });

      await persistCheckpoint(tabId, stepIndex, observationHistory, operationHistory, 'waiting_user');

      const answer = onAskUser
        ? await onAskUser(toolCall.arguments.question as string)
        : null;

      if (answer === null || abortSignal?.aborted) {
        await finalizeSession(tabId, steps, 'stopped');
        return;
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: answer,
      });
      steps.push({
        index: stepIndex,
        thought: fullThought,
        toolCall: { name: toolCall.name, arguments: toolCall.arguments },
        result: { success: true, data: { answer } },
        tokensUsed: totalTokens,
      });
      onStepComplete?.(steps[steps.length - 1]);
      continue;
    }

    // Execute tool call
    if (toolCall) {
      globalToolCallCount++;
      onStreamUpdate?.({
        type: 'step_status',
        stepId: `step_${stepIndex}`,
        status: 'executing',
        detail: `正在执行: ${toolCall.name}...`,
      });

      const toolResult = await executeToolCall(
        tabId,
        toolCall.name,
        toolCall.arguments,
        stepIndex,
        abortSignal,
      );

      observationHistory.push(`[${toolCall.name}] ${toolResult.success ? '成功' : '失败'}: ${toolResult.data ?? toolResult.error ?? ''}`);

      if (!toolResult.success && toolResult.error) {
        // If aborted, retry up to 3 times before reporting error
        const isAbort = toolResult.error.includes('Abort') || toolResult.error.includes('abort');
        if (isAbort && _abortRetries < 3) {
          _abortRetries++;
          onStreamUpdate?.({
            type: 'step_status',
            stepId: `step_${stepIndex}`,
            status: 'thinking',
            detail: `操作中断，自动重试 (${_abortRetries}/3)...`,
          });
          stepIndex--; // Retry same step
          continue;
        }

        _abortRetries = 0; // Reset for next non-abort error
        onStreamUpdate?.({
          type: 'step_status',
          stepId: `step_${stepIndex}`,
          status: 'errored',
          detail: `执行失败: ${toolResult.error}`,
        });
      }

      // Track operation for idempotency
      if (!executedOperations.has(tabId)) {
        executedOperations.set(tabId, new Set());
      }
      executedOperations.get(tabId)!.add(`${toolCall.name}:${JSON.stringify(toolCall.arguments).slice(0, 100)}`);

      operationHistory.push({
        step: stepIndex,
        action: toolCall.name,
        params: toolCall.arguments,
        result: toolResult.success ? 'success' : 'failed',
        timestamp: Date.now(),
        preHash: '',
        postHash: '',
        retryCount: 0,
      });

      // Feed result back to DeepSeek
      const toolResultStr = toolResult.success
        ? JSON.stringify(toolResult.data).slice(0, 2000)
        : `错误: ${toolResult.error}`;

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: toolResultStr,
      });

      steps.push({
        index: stepIndex,
        thought: fullThought,
        toolCall: { name: toolCall.name, arguments: toolCall.arguments },
        result: toolResult,
        tokensUsed: totalTokens,
      });
      onStepComplete?.(steps[steps.length - 1]);

      // Check for context window compression
      const { compressConversation } = await import('../api/deepseek');
      const compressedMessages = compressConversation(
        messages.filter((m) => m.role !== 'system'),
        totalTokens,
      );
      if (compressedMessages !== messages.filter((m) => m.role !== 'system')) {
        messages.length = 1; // Keep system message
        messages.push(...compressedMessages);
      }
    } else {
      // No tool call — just a text response. Push a continuation prompt.
      messages.push({
        role: 'user',
        content: '请继续。如果任务已完成，请调用 finish_task。如果还有下一步操作（获取语义结构、打标签、执行操作等），请继续。',
      });
      steps.push({
        index: stepIndex,
        thought: fullThought,
        tokensUsed: totalTokens,
      });
      onStepComplete?.(steps[steps.length - 1]);
    }

    // Persist conversation (map ChatMessage to ConversationMessage format)
    conversation.messages = messages.map((m) => ({
      role: m.role as 'user' | 'assistant' | 'system' | 'tool',
      content: m.content,
      timestamp: Date.now(),
    }));
    conversation.totalTokens = totalTokens;
    conversation.updatedAt = Date.now();
    await saveConversation(conversation);
  }

  // Max steps reached
  onStreamUpdate?.({
    type: 'step_status',
    stepId: 'final',
    status: 'errored',
    detail: '达到最大步数限制，任务未完成',
  });
  await finalizeSession(tabId, steps, 'errored');
}

// ─── Tool Execution ────────────────────────────────────────────────────────

async function executeToolCall(
  tabId: number,
  toolName: string,
  args: Record<string, unknown>,
  stepIndex: number,
  abortSignal?: AbortSignal,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  // Check for idempotent operation duplicates
  const opKey = `${toolName}:${JSON.stringify(args).slice(0, 100)}`;
  if (executedOperations.has(tabId) && executedOperations.get(tabId)!.has(opKey)) {
    // Non-idempotent operations should not be repeated
    const nonIdempotent = ['execute_click', 'execute_type', 'hover'];
    if (nonIdempotent.includes(toolName)) {
      console.warn(`[react-loop] Skipping duplicate non-idempotent operation: ${opKey}`);
      return { success: true, data: { skipped: true, reason: 'duplicate non-idempotent operation' } };
    }
  }

  // Vision model — handled specially
  if (toolName === 'call_vision_model') {
    return executeVisionCall(tabId, args, stepIndex, abortSignal);
  }

  // Background-only actions (no content script needed)
  if (toolName === 'navigate_to_url') {
    try {
      const url = (args.url as string) ?? '';
      const fullUrl = url.startsWith('http') ? url : `https://${url}`;

      // Mark this as an agent-initiated navigation (don't abort ourselves)
      (globalThis as any).__markAgentNavigation?.(tabId);

      await chrome.tabs.update(tabId, { url: fullUrl });
      await new Promise(r => setTimeout(r, 2000)); // Wait for page to load
      return { success: true, data: { navigated: true, url: fullUrl } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // All other tools go through the content script
  // If abort signal is already aborted, pass undefined (fresh attempt)
  const signal = abortSignal?.aborted ? undefined : abortSignal;
  const result = await sendToContentScript(tabId, toolName as Action, args, signal);

  // Wait for page to settle after actions that might trigger navigation/DOM changes
  if (result.success && ['execute_click', 'execute_type', 'press_key'].includes(toolName)) {
    await new Promise(r => setTimeout(r, 500));
  }

  return result;
}

/**
 * Execute a vision model call:
 *   1. Capture screenshot
 *   2. Crop to tagged element bounds
 *   3. Send to Doubao
 *   4. Return element ID
 */
async function executeVisionCall(
  tabId: number,
  args: Record<string, unknown>,
  _stepIndex: number,
  abortSignal?: AbortSignal,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  // Check circuit breaker
  if (isDoubaoCircuitOpen(tabId)) {
    return { success: false, error: buildDegradationNotice() };
  }

  try {
    // Get tagged element bounds from content script
    const boundsResult = await sendToContentScript(tabId, 'call_vision_model', args, abortSignal);
    if (!boundsResult.success) return boundsResult;

    const boundsData = boundsResult.data as { question: string; boundsUnion: { x: number; y: number; width: number; height: number }; tagCount: number };
    if (!boundsData?.boundsUnion || boundsData.tagCount === 0) {
      return { success: false, error: 'No tagged elements to screenshot' };
    }

    // Capture screenshot — use JPEG at 60% quality to stay within SW memory limits
    const tab = await chrome.tabs.get(tabId);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'jpeg',
      quality: 60,
    });

    // Get DPR for coordinate correction
    let dpr = 1;
    try {
      dpr = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.devicePixelRatio,
      }).then((r) => r[0]?.result ?? 1) as number;
    } catch { /* use default 1 */ }

    const imageBase64 = stripDataUrlPrefix(dataUrl);
    const visionResult = await callDoubaoVision(tabId, { imageBase64, question: boundsData.question, devicePixelRatio: dpr });

    if (!visionResult.success) return { success: false, error: visionResult.error };

    return { success: true, data: { elementId: visionResult.elementId, confidence: visionResult.confidence } };
  } catch (err) {
    console.error('[react-loop] Vision call failed:', err);
    return { success: false, error: `Vision call error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── Content Script Communication ──────────────────────────────────────────

async function sendToContentScript(
  tabId: number,
  action: string,
  params: Record<string, unknown>,
  abortSignal?: AbortSignal,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.pendingUrl) {
      return { success: false, error: 'Tab is navigating' };
    }

    const documentId = (tab as unknown as { documentId: string }).documentId;

    const result = await new Promise<{ success: boolean; data?: unknown; error?: string }>(
      (resolve) => {
        const timeoutId = setTimeout(() => {
          resolve({ success: false, error: 'Content script timeout' });
        }, 5000);

        if (abortSignal) {
          abortSignal.addEventListener('abort', () => {
            clearTimeout(timeoutId);
            resolve({ success: false, error: 'Aborted' });
          }, { once: true });
        }

        chrome.tabs.sendMessage(tabId, { action, ...params }, (response) => {
          clearTimeout(timeoutId);
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(response ?? { success: false, error: 'No response' });
          }
        });
      },
    );

    // Verify documentId hasn't changed (navigation guard)
    const currentTab = await chrome.tabs.get(tabId);
    if ((currentTab as unknown as { documentId: string }).documentId !== documentId) {
      return { success: false, error: 'Navigation detected — result discarded' };
    }

    return result;
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Checkpoint Persistence ────────────────────────────────────────────────

async function persistCheckpoint(
  tabId: number,
  stepIndex: number,
  observations: string[],
  ops: OperationRecord[],
  status: LoopStatus = 'thinking',
): Promise<void> {
  const state: ReactLoopState = {
    tabId,
    stepIndex,
    status,
    observationHistory: observations,
    operationHistory: ops,
    tagLocatorMap: new Map(),
    lastActivityTimestamp: Date.now(),
  };

  await setReactState(tabId, state);
  await registerActiveSession({
    tabId,
    url: '',
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    loopStatus: status,
  });
}

async function finalizeSession(
  tabId: number,
  steps: LoopStep[],
  finalStatus: LoopStatus,
): Promise<void> {
  // Build summary
  const summaryParts = steps.map((s) => {
    const tool = s.toolCall ? `[${s.toolCall.name}]` : '[思考]';
    const result = s.result
      ? s.result.success ? '✓' : `✗ ${s.result.error ?? ''}`
      : '';
    return `${tool} ${result}`;
  });

  const summary = summaryParts.join('\n');
  await saveLoopSummary(tabId, summary);

  await persistCheckpoint(tabId, steps.length - 1, [], [], finalStatus);
  await unregisterActiveSession(tabId);

  // Clear executed operations tracking
  executedOperations.delete(tabId);

  console.log(`[react-loop] Session finalized: ${finalStatus}. ${steps.length} steps, summary:\n${summary}`);
}

// ─── Recovery ──────────────────────────────────────────────────────────────

/**
 * Check if there's an in-progress session that can be recovered.
 * Called on Service Worker startup.
 */
export async function checkRecoverableSession(): Promise<{
  recoverable: boolean;
  tabId?: number;
  stepIndex?: number;
  status?: LoopStatus;
} | null> {
  try {
    const { findInProgressSessions } = await import('../shared/storage');
    const inProgress = await findInProgressSessions();

    if (inProgress.length === 0) return null;

    const session = inProgress[0];
    const state = await getReactState(session.tabId);

    return {
      recoverable: true,
      tabId: session.tabId,
      stepIndex: state?.stepIndex ?? 0,
      status: state?.status ?? 'idle',
    };
  } catch {
    return null;
  }
}

// ─── Abort ─────────────────────────────────────────────────────────────────

/**
 * Abort a running ReAct loop for a tab.
 */
export async function abortReactLoop(tabId: number): Promise<void> {
  await finalizeSession(tabId, [], 'stopped');
}
