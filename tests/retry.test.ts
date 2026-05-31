import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchWithRetry, getCircuitBreakerStatus, resetAllCircuitBreakers } from '../src/shared/retry';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
  resetAllCircuitBreakers();
});

describe('fetchWithRetry', () => {
  it('returns success on first successful attempt', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: 'hello' }),
    });

    const result = await fetchWithRetry<{ data: string }>('https://api.example.com/test');

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ data: 'hello' });
    expect(result.attempts).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 status', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: () => null },
        text: () => Promise.resolve('Rate limited'),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true }),
      });

    const result = await fetchWithRetry('https://api.example.com/test', undefined, {
      baseDelayMs: 10,
      jitterMs: 0,
    });

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries on 5xx errors', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: { get: () => null },
        text: () => Promise.resolve('Service Unavailable'),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        headers: { get: () => null },
        text: () => Promise.resolve('Bad Gateway'),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ recovered: true }),
      });

    const result = await fetchWithRetry('https://api.example.com/test', undefined, {
      baseDelayMs: 10,
      jitterMs: 0,
      maxRetries: 3,
    });

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(3);
  });

  it('returns failure after max retries', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      headers: { get: () => null },
      text: () => Promise.resolve('Internal Server Error'),
    });

    const result = await fetchWithRetry('https://api.example.com/test', undefined, {
      maxRetries: 2,
      baseDelayMs: 10,
      jitterMs: 0,
    });

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(3); // 1 initial + 2 retries
    expect(result.error).toContain('500');
  });

  it('does not retry on 4xx errors (except 429)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      headers: { get: () => null },
      text: () => Promise.resolve('Unauthorized'),
    });

    const result = await fetchWithRetry('https://api.example.com/test', undefined, {
      baseDelayMs: 10,
      jitterMs: 0,
    });

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(1); // No retries
  });

  it('honors Retry-After header on 429', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: (name: string) => name === 'Retry-After' ? '1' : null },
        text: () => Promise.resolve('Rate limited'),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true }),
      });

    const result = await fetchWithRetry('https://api.example.com/test', undefined, {
      respectRetryAfter: true,
    });

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it('handles network errors with retry', async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ recovered: true }),
      });

    const result = await fetchWithRetry('https://api.example.com/test', undefined, {
      baseDelayMs: 10,
      jitterMs: 0,
    });

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it('handles AbortError timeout with retry', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    mockFetch
      .mockRejectedValueOnce(abortError)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ recovered: true }),
      });

    const result = await fetchWithRetry('https://api.example.com/test', undefined, {
      baseDelayMs: 10,
      jitterMs: 0,
      timeoutMs: 100,
    });

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
  });
});

describe('Circuit Breaker', () => {
  it('opens after 5 consecutive failures', async () => {
    // This test verifies circuit breaker integration.
    // We need 5 consecutive failures to the same endpoint.
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      headers: { get: () => null },
      text: () => Promise.resolve('Error'),
    });

    const url = 'https://api.example.com/circuit-test';
    const config = { maxRetries: 0, baseDelayMs: 1, jitterMs: 0 };

    // 5 failures → circuit should open
    for (let i = 0; i < 5; i++) {
      await fetchWithRetry(url, undefined, config);
    }

    // The 6th call should be blocked by circuit breaker
    const result = await fetchWithRetry(url, undefined, config);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Circuit breaker open');
  });

  it('getCircuitBreakerStatus returns current state', () => {
    // After the previous test, we should have an open circuit
    const status = getCircuitBreakerStatus();
    // May or may not have entries depending on reset
    expect(status).toBeInstanceOf(Map);
  });

  it('resetAllCircuitBreakers clears all circuits', async () => {
    // First create an open circuit
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      headers: { get: () => null },
      text: () => Promise.resolve('Error'),
    });

    const url = 'https://api.example.com/reset-test';
    for (let i = 0; i < 5; i++) {
      await fetchWithRetry(url, undefined, { maxRetries: 0, baseDelayMs: 1, jitterMs: 0 });
    }

    resetAllCircuitBreakers();

    const status = getCircuitBreakerStatus();
    expect(status.size).toBe(0);
  });
});
