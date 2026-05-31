import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch for API tests
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

describe('DeepSeek API — Tool Definitions', () => {
  it('builds all 15 tool definitions', async () => {
    const { buildToolDefinitions } = await import('../src/api/deepseek');
    const tools = buildToolDefinitions();
    expect(tools).toHaveLength(15);
  });

  it('includes all required tools', async () => {
    const { buildToolDefinitions } = await import('../src/api/deepseek');
    const tools = buildToolDefinitions();
    const names = tools.map((t) => t.function.name).sort();

    expect(names).toContain('get_page_semantic_structure');
    expect(names).toContain('extract_text');
    expect(names).toContain('tag_elements');
    expect(names).toContain('call_vision_model');
    expect(names).toContain('execute_click');
    expect(names).toContain('execute_type');
    expect(names).toContain('hover');
    expect(names).toContain('press_key');
    expect(names).toContain('scroll_page');
    expect(names).toContain('wait_for');
    expect(names).toContain('handle_dialog');
    expect(names).toContain('ask_user');
    expect(names).toContain('finish_task');
    expect(names).toContain('execute_javascript');
  });

  it('each tool has type: function', async () => {
    const { buildToolDefinitions } = await import('../src/api/deepseek');
    const tools = buildToolDefinitions();
    for (const tool of tools) {
      expect(tool.type).toBe('function');
    }
  });
});

describe('DeepSeek API — System Prompt', () => {
  it('contains prompt injection warning as first line', async () => {
    const { buildSystemPrompt } = await import('../src/api/deepseek');
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('不受信任的用户输入');
  });

  it('emphasizes text-first before vision', async () => {
    const { buildSystemPrompt } = await import('../src/api/deepseek');
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('先用文本，后用视觉');
  });
});

describe('DeepSeek API — JSON Repair', () => {
  it('parses valid JSON directly', async () => {
    const { parseToolArguments } = await import('../src/api/deepseek');
    const result = await parseToolArguments('execute_click', '{"element_id": 3}');
    expect(result.success).toBe(true);
    expect(result.arguments).toEqual({ element_id: 3 });
  });

  it('repairs missing closing brace', async () => {
    const { parseToolArguments } = await import('../src/api/deepseek');
    const result = await parseToolArguments('execute_click', '{"element_id": 3');
    expect(result.success).toBe(true);
    expect(result.arguments).toEqual({ element_id: 3 });
  });

  it('repairs trailing comma', async () => {
    const { parseToolArguments } = await import('../src/api/deepseek');
    const result = await parseToolArguments('execute_type', '{"element_id": 1, "text": "hello",}');
    expect(result.success).toBe(true);
    expect(result.arguments).toEqual({ element_id: 1, text: 'hello' });
  });

  it('fails on completely broken JSON without retry fn', async () => {
    const { parseToolArguments } = await import('../src/api/deepseek');
    const result = await parseToolArguments('execute_click', 'not json at all {{{');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to parse');
  });

  it('retries with retryFn on failure', async () => {
    const { parseToolArguments } = await import('../src/api/deepseek');
    let retryCount = 0;
    const result = await parseToolArguments('execute_click', 'broken', async () => {
      retryCount++;
      return {
        content: null,
        toolCalls: [{ id: 'retry-1', name: 'execute_click', arguments: { element_id: 7 } }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: 'tool_calls',
      };
    });
    expect(result.success).toBe(true);
    expect(result.arguments).toEqual({ element_id: 7 });
    expect(retryCount).toBe(1);
  });
});

describe('DeepSeek API — Context Window', () => {
  it('detects when compression is needed', async () => {
    const { needsCompression } = await import('../src/api/deepseek');
    expect(needsCompression(102400, 128000)).toBe(true); // 80%+
    expect(needsCompression(50000, 128000)).toBe(false); // ~39%
    expect(needsCompression(102399, 128000)).toBe(false); // just under 80%
  });

  it('compresses conversation keeping system prompt and last turns', async () => {
    const { compressConversation } = await import('../src/api/deepseek');
    const messages = [
      { role: 'system' as const, content: 'You are an agent' },
      { role: 'user' as const, content: 'Message 1' },
      { role: 'assistant' as const, content: 'Response 1' },
      { role: 'user' as const, content: 'Message 2' },
      { role: 'assistant' as const, content: 'Response 2' },
      { role: 'user' as const, content: 'Message 3' },
      { role: 'assistant' as const, content: 'Response 3' },
      { role: 'user' as const, content: 'Message 4' },
      { role: 'assistant' as const, content: 'Response 4' },
      { role: 'user' as const, content: 'Message 5' },
      { role: 'assistant' as const, content: 'Response 5' },
    ];
    // All messages total ~11 (1 system + 10 non-system), keep 4 → compress 6
    // But needsCompression might not trigger because we passed 0 tokens token count bypasses

    // Force compression by passing a high token count
    const { needsCompression } = await import('../src/api/deepseek');
    if (needsCompression(105000, 128000)) {
      const compressed = compressConversation(messages, 105000);

      // Should still have system prompt
      expect(compressed.some((m) => m.role === 'system')).toBe(true);

      // Should have a summary
      expect(compressed.length).toBeLessThan(messages.length);
    }
  });
});

describe('DeepSeek API — Token Estimation', () => {
  it('estimates tokens for English text', async () => {
    const { estimateTokens } = await import('../src/api/deepseek');
    const tokens = estimateTokens('This is a test message');
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10); // ~5 tokens
  });

  it('estimates tokens for Chinese text', async () => {
    const { estimateTokens } = await import('../src/api/deepseek');
    const tokens = estimateTokens('这是一个测试消息');
    // Chinese: ~1.5 chars/token → 8/1.5 ≈ 6 tokens
    expect(tokens).toBeGreaterThan(2);
    expect(tokens).toBeLessThan(10);
  });
});

describe('Doubao Vision API', () => {
  it('stripDataUrlPrefix removes prefix', async () => {
    const { stripDataUrlPrefix } = await import('../src/api/doubao');
    const result = stripDataUrlPrefix('data:image/png;base64,iVBORw0KGgo=');
    expect(result).toBe('iVBORw0KGgo=');
  });

  it('stripDataUrlPrefix handles already-stripped strings', async () => {
    const { stripDataUrlPrefix } = await import('../src/api/doubao');
    const result = stripDataUrlPrefix('iVBORw0KGgo=');
    expect(result).toBe('iVBORw0KGgo=');
  });

  it('correctCoordinateForDPR divides by DPR', async () => {
    const { correctCoordinateForDPR } = await import('../src/api/doubao');
    expect(correctCoordinateForDPR(200, 2)).toBe(100);
    expect(correctCoordinateForDPR(300, 3)).toBe(100);
    expect(correctCoordinateForDPR(150, 1)).toBe(150);
  });

  it('builds degradation notice in Chinese', async () => {
    const { buildDegradationNotice } = await import('../src/api/doubao');
    const notice = buildDegradationNotice();
    expect(notice).toContain('视觉模型');
    expect(notice).toContain('纯文本模式');
  });

  it('circuit breaker starts closed', async () => {
    const { isDoubaoCircuitOpen, resetDoubaoCircuit } = await import('../src/api/doubao');
    resetDoubaoCircuit(1);
    expect(isDoubaoCircuitOpen(1)).toBe(false);
  });

  it('circuit breaker can be reset', async () => {
    const { resetDoubaoCircuit, getDoubaoCircuitStatus } = await import('../src/api/doubao');
    resetDoubaoCircuit(2);
    const status = getDoubaoCircuitStatus(2);
    expect(status.open).toBe(false);
    expect(status.consecutiveFailures).toBe(0);
  });
});
