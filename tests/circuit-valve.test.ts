import { createValve, RateLimitedException, CircuitBreakerException } from '../src/index';

describe('CircuitValve Rate Limiter', () => {
  it('throws RateLimitedException when maximum simultaneous requests exceeded', async () => {
    const valve = createValve({ maxSimultaneousRequests: 1 });
    const asyncTask = () => new Promise(resolve => setTimeout(() => resolve('done'), 50));
    const wrapped = valve.add(asyncTask);

    // Start first call but do not await
    const p = wrapped();
    await expect(wrapped()).rejects.toBeInstanceOf(RateLimitedException);
    await p; // finish first
  });

  it('throws RateLimitedException when requests per second exceeded', async () => {
    const valve = createValve({ maxReqPerSecond: 1, controlPeriodS: 1 });
    const fast = async () => 'ok';
    const wrapped = valve.add(fast);

    // First call
    await wrapped();
    // Immediate second call should be rate limited
    await expect(wrapped()).rejects.toBeInstanceOf(RateLimitedException);
  });
});

describe('CircuitBreaker', () => {
  it('opens circuit after consecutive failures', async () => {
    const valve = createValve({ fullCloseAfterNFailures: 2, fullCloseDurationS: 1 });
    let count = 0;
    const failing = async () => { count++; throw new Error('fail'); };
    const wrapped = valve.add(failing);

    // First two calls fail with original error
    await expect(wrapped()).rejects.toThrow('fail');
    await expect(wrapped()).rejects.toThrow('fail');
    // Third call should throw CircuitBreakerException
    await expect(wrapped()).rejects.toBeInstanceOf(CircuitBreakerException);
  });
});

describe('Retry mechanism', () => {
  it('retries on failure and succeeds', async () => {
    const valve = createValve({ maxRetryCount: 2 });
    let attempts = 0;
    const sometimesFail = async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error('temporary');
      }
      return 'success';
    };
    const wrapped = valve.add(sometimesFail, { maxRetryCount: 2 });

    const result = await wrapped();
    expect(result).toBe('success');
    expect(attempts).toBe(3);
  });
});
