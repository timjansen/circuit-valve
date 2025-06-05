import { createValve, RateLimitedException, CircuitBreakerException } from '../src/index';

describe('CircuitValve Rate Limiter', () => {
  let fakeTime: number;
  let advance: (s: number) => void;
  let nowFn: () => number;
  beforeEach(() => {
    fakeTime = 1000;
    advance = (s: number) => { fakeTime += s; };
    nowFn = () => fakeTime;
  });

  it('throws RateLimitedException when maximum simultaneous requests exceeded', async () => {
    const valve = createValve({ maxSimultaneousRequests: 1, nowFn });
    const asyncTask = () => new Promise(resolve => setTimeout(() => resolve('done'), 1));
    const wrapped = valve.add(asyncTask);

    // Start first call but do not await
    const p = wrapped();
    await expect(wrapped()).rejects.toBeInstanceOf(RateLimitedException);
    await p; // finish first
  });

  it('throws RateLimitedException when requests per second exceeded', async () => {
    const valve = createValve({ maxReqPerSecond: 1, controlPeriodS: 1, nowFn });
    const fast = async () => 'ok';
    const wrapped = valve.add(fast);

    // First call
    await wrapped();
    // Advance time by a small amount, but still within the same second
    advance(0.1);
    // Second call should be rate limited
    await expect(wrapped()).rejects.toBeInstanceOf(RateLimitedException);
    // Advance time to allow next call
    advance(1);
    await wrapped();
  });
});

describe('CircuitBreaker', () => {
  let fakeTime: number;
  let advance: (s: number) => void;
  let nowFn: () => number;
  beforeEach(() => {
    fakeTime = 1000;
    advance = (s: number) => { fakeTime += s; };
    nowFn = () => fakeTime;
  });

  it('opens circuit after consecutive failures', async () => {
    const valve = createValve({ fullCloseAfterNFailures: 2, fullCloseDurationS: 1, nowFn });
    let count = 0;
    const failing = async () => { count++; throw new Error('fail'); };
    const wrapped = valve.add(failing);

    // First two calls fail with original error
    await expect(wrapped()).rejects.toThrow('fail');
    await expect(wrapped()).rejects.toThrow('fail');
    // Third call should throw CircuitBreakerException
    await expect(wrapped()).rejects.toBeInstanceOf(CircuitBreakerException);
  });

  it('closes circuit after fullCloseDurationS and allows calls again', async () => {
    const valve = createValve({ fullCloseAfterNFailures: 1, fullCloseDurationS: 1, nowFn });
    const failing = async () => { throw new Error('fail'); };
    const wrapped = valve.add(failing);

    // First call fails and opens the circuit
    await expect(wrapped()).rejects.toThrow('fail');
    // Second call should throw CircuitBreakerException
    await expect(wrapped()).rejects.toBeInstanceOf(CircuitBreakerException);
    // Advance time to after fullCloseDurationS
    advance(1.1);
    // After duration, circuit should allow calls again (and fail with original error)
    await expect(wrapped()).rejects.toThrow('fail');
  });
});

describe('Retry mechanism', () => {
  let fakeTime: number;
  let nowFn: () => number;
  beforeEach(() => {
    fakeTime = 1000;
    nowFn = () => fakeTime;
  });

  it('retries on failure and succeeds', async () => {
    const valve = createValve({ maxRetryCount: 2, nowFn });
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

describe('Soft break functionality', () => {
  let fakeTime: number;
  let advance: (s: number) => void;
  let nowFn: () => number;
  beforeEach(() => {
    fakeTime = 1000;
    advance = (s: number) => { fakeTime += s; };
    nowFn = () => fakeTime;
  });

  it('reduces allowed request rate when failure percentage exceeds threshold', async () => {
    const valve = createValve({
      maxReqPerSecond: 10,
      minReqPerSecond: 2,
      softBreakFailMinPercentage: 50, // If >50% fail, reduce rate
      softBreakReqDecreaseFactor: 0.5, // Halve the rate
      controlPeriodS: 2,
      softBreakCheckAfterS: 0, // Always allow soft break check
      nowFn
    });
    const alwaysFail = async () => { throw new Error('fail'); };
    const wrapped = valve.add(alwaysFail);

    // Fill buffer with 4 requests, 3 fail (75% fail rate)
    for (let i = 0; i < 4; i++) {
      await expect(wrapped()).rejects.toThrow('fail');
      advance(0.5);
    }
    // Advance time to trigger soft break check
    advance(2);
    // Make a dummy request to trigger soft break check
    const alwaysSucceed = async () => 'ok';
    const wrapped2 = valve.add(alwaysSucceed);
    await wrapped2();
    // Now, make requests in a tight window to hit the new rate limit (should be 5 per 2s window)
    for (let i = 0; i < 5; i++) {
      await expect(wrapped2()).resolves.toBe('ok');
    }
    // The next call should be rate limited
    await expect(wrapped2()).rejects.toBeInstanceOf(RateLimitedException);
  });
});
