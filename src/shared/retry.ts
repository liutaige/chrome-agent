// ============================================================================
// Exponential Backoff Retry Wrapper
// Used for all API calls (DeepSeek + Doubao Vision) and chrome.tabs.sendMessage.
// ============================================================================

export interface RetryConfig {
  maxRetries: number;        // Max retry attempts (default 3)
  baseDelayMs: number;       // Starting delay (default 1000ms)
  maxDelayMs: number;        // Cap on delay (default 16000ms)
  jitterMs: number;          // Random jitter range (default ±250ms)
  timeoutMs: number;         // AbortController timeout (default 30000ms)
  retryOnStatuses: number[]; // HTTP status codes that trigger retry (default: 429, 5xx)
  respectRetryAfter: boolean;// Honor Retry-After header on 429 (default true)
}

export interface RetryResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  attempts: number;
  totalTimeMs: number;
  lastStatus?: number;
}

const DEFAULT_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 16000,
  jitterMs: 250,
  timeoutMs: 30000,
  retryOnStatuses: [429, 500, 502, 503, 504],
  respectRetryAfter: true,
};

/** Circuit breaker state for a single API endpoint. */
interface CircuitState {
  consecutiveFailures: number;
  lastFailureTime: number;
  open: boolean;
}

const circuits = new Map<string, CircuitState>();

const CIRCUIT_BREAK_THRESHOLD = 5;   // Open after 5 consecutive non-200 responses
const CIRCUIT_RESET_MS = 60000;      // Auto-reset after 60 seconds

function getCircuitKey(url: string): string {
  // Normalize: strip query params, extract host + path
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

function checkCircuitBreaker(url: string): string | null {
  const key = getCircuitKey(url);
  const state = circuits.get(key);
  if (!state?.open) return null;
  if (Date.now() - state.lastFailureTime > CIRCUIT_RESET_MS) {
    // Auto-reset
    circuits.delete(key);
    return null;
  }
  return `Circuit breaker open for ${key}. Too many consecutive failures.`;
}

function recordCircuitResult(url: string, ok: boolean): void {
  const key = getCircuitKey(url);
  if (ok) {
    circuits.delete(key);
    return;
  }
  const state = circuits.get(key) ?? { consecutiveFailures: 0, lastFailureTime: 0, open: false };
  state.consecutiveFailures++;
  state.lastFailureTime = Date.now();
  if (state.consecutiveFailures >= CIRCUIT_BREAK_THRESHOLD) {
    state.open = true;
  }
  circuits.set(key, state);
}

/** Compute exponential backoff delay with jitter. */
function computeDelay(retryCount: number, config: RetryConfig, retryAfterHeader?: number): number {
  if (retryAfterHeader !== undefined && config.respectRetryAfter) {
    return retryAfterHeader * 1000; // Retry-After is in seconds
  }
  const exponential = Math.min(config.baseDelayMs * Math.pow(2, retryCount), config.maxDelayMs);
  const jitter = (Math.random() * 2 - 1) * config.jitterMs;
  return Math.max(0, exponential + jitter);
}

/** Sleep for a given duration. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a fetch with exponential backoff retry and circuit breaker protection.
 *
 * Features:
 * - Exponential backoff: 1s → 2s → 4s (configurable)
 * - Random jitter ±250ms to prevent thundering herd
 * - Circuit breaker: 5 consecutive non-200 → auto-pause, notify user
 * - Retry-After header honored on 429
 * - AbortController timeout protection (30s default)
 * - Configurable retryable status codes
 *
 * @param url - The URL to fetch
 * @param init - Standard fetch init (method, headers, body, signal, etc.)
 * @param config - Retry configuration overrides
 * @returns RetryResult with success status, data, or error details
 */
export async function fetchWithRetry<T = unknown>(
  url: string,
  init?: RequestInit,
  config?: Partial<RetryConfig>,
): Promise<RetryResult<T>> {
  const cfg: RetryConfig = { ...DEFAULT_CONFIG, ...config };
  const startTime = Date.now();
  let lastStatus: number | undefined;

  // Check circuit breaker before attempting
  const circuitError = checkCircuitBreaker(url);
  if (circuitError) {
    return { success: false, error: circuitError, attempts: 0, totalTimeMs: 0 };
  }

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    // Create a fresh AbortController for each attempt (signals are one-time use)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), cfg.timeoutMs);

    // Merge the abort signal with any caller-provided signal
    const mergedInit: RequestInit = { ...init };
    if (init?.signal) {
      // If the caller provided a signal, forward abort to our controller
      init.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    mergedInit.signal = controller.signal;

    try {
      const response = await fetch(url, mergedInit);
      clearTimeout(timeoutId);
      lastStatus = response.status;

      if (response.ok) {
        recordCircuitResult(url, true);
        const data = (await response.json()) as T;
        return {
          success: true,
          data,
          attempts: attempt + 1,
          totalTimeMs: Date.now() - startTime,
          lastStatus,
        };
      }

      // Non-OK response — check if retryable
      if (cfg.retryOnStatuses.includes(response.status)) {
        recordCircuitResult(url, false);

        if (response.status === 429 && cfg.respectRetryAfter) {
          const retryAfter = response.headers.get('Retry-After');
          const delaySec = retryAfter ? parseInt(retryAfter, 10) : undefined;
          const delay = computeDelay(attempt, cfg, delaySec);
          console.warn(`[retry] 429 on ${url}, Retry-After=${retryAfter}, waiting ${delay}ms (attempt ${attempt + 1}/${cfg.maxRetries + 1})`);
          await sleep(delay);
          continue;
        }

        if (attempt < cfg.maxRetries) {
          const delay = computeDelay(attempt, cfg);
          console.warn(`[retry] ${response.status} on ${url}, waiting ${delay}ms (attempt ${attempt + 1}/${cfg.maxRetries + 1})`);
          await sleep(delay);
          continue;
        }
      }

      // Non-retryable status or max retries exhausted
      const errorBody = await response.text().catch(() => '(could not read body)');
      return {
        success: false,
        error: `HTTP ${response.status}: ${errorBody.slice(0, 500)}`,
        attempts: attempt + 1,
        totalTimeMs: Date.now() - startTime,
        lastStatus,
      };
    } catch (err) {
      clearTimeout(timeoutId);

      if (err instanceof DOMException && err.name === 'AbortError') {
        recordCircuitResult(url, false);
        if (attempt < cfg.maxRetries) {
          const delay = computeDelay(attempt, cfg);
          console.warn(`[retry] Timeout on ${url}, waiting ${delay}ms (attempt ${attempt + 1}/${cfg.maxRetries + 1})`);
          await sleep(delay);
          continue;
        }
        return {
          success: false,
          error: `Request timed out after ${cfg.timeoutMs}ms (${cfg.maxRetries + 1} attempts)`,
          attempts: attempt + 1,
          totalTimeMs: Date.now() - startTime,
          lastStatus,
        };
      }

      // Network error
      recordCircuitResult(url, false);
      if (attempt < cfg.maxRetries) {
        const delay = computeDelay(attempt, cfg);
        console.warn(`[retry] Network error on ${url}: ${err instanceof Error ? err.message : String(err)}, waiting ${delay}ms`);
        await sleep(delay);
        continue;
      }
      return {
        success: false,
        error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
        attempts: attempt + 1,
        totalTimeMs: Date.now() - startTime,
        lastStatus,
      };
    }
  }

  // Unreachable but TypeScript wants it
  return {
    success: false,
    error: 'Max retries exhausted',
    attempts: cfg.maxRetries + 1,
    totalTimeMs: Date.now() - startTime,
    lastStatus,
  };
}

/**
 * Get the current state of all circuit breakers.
 * Useful for diagnostics and the Side Panel status display.
 */
export function getCircuitBreakerStatus(): Map<string, { open: boolean; consecutiveFailures: number; lastFailureTime: number }> {
  const result = new Map<string, { open: boolean; consecutiveFailures: number; lastFailureTime: number }>();
  for (const [key, state] of circuits) {
    result.set(key, { ...state });
  }
  return result;
}

/** Reset all circuit breakers (e.g., after user updates API keys). */
export function resetAllCircuitBreakers(): void {
  circuits.clear();
}

/** Reset a specific circuit breaker. */
export function resetCircuitBreaker(url: string): void {
  circuits.delete(getCircuitKey(url));
}
