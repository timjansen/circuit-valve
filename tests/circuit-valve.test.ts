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

describe('CircuitBreaker with fullCloseOnFailPercentage', () => {
  let fakeTime: number;
  let advance: (s: number) => void;
  let nowFn: () => number;
  beforeEach(() => {
    fakeTime = 1000;
    advance = (s: number) => { fakeTime += s; };
    nowFn = () => fakeTime;
  });

  it('opens circuit when failure percentage exceeds threshold', async () => {
    const valve = createValve({
      fullCloseOnFailPercentage: 50, // 50% failure threshold
      controlPeriodS: 2,
      nowFn
    });
    const sometimesFail = async (fail: boolean) => {
      if (fail) throw new Error('fail');
      return 'ok';
    };
    const wrapped = valve.add(sometimesFail);

    // 4 requests: 2 fail, 2 succeed (50% fail, should not open)
    await expect(wrapped(false)).resolves.toBe('ok');
    await expect(wrapped(true)).rejects.toThrow('fail');
    await expect(wrapped(false)).resolves.toBe('ok');
    await expect(wrapped(true)).rejects.toThrow('fail');
    // Next request, still at threshold, should not open
    await expect(wrapped(false)).resolves.toBe('ok');
    // Add one more fail to exceed threshold (3/6 = 50%, still not above)
    await expect(wrapped(true)).rejects.toThrow('fail');
    // Add one more fail to go above threshold (4/7 > 50%)
    await expect(wrapped(true)).rejects.toThrow('fail');
    // Now, circuit should be open
    await expect(wrapped(false)).rejects.toBeInstanceOf(CircuitBreakerException);
  });
});

describe('CircuitBreaker reopenWithReqPerS and reopenWithSimultanousRequests', () => {
  let fakeTime: number;
  let advance: (s: number) => void;
  let nowFn: () => number;
  beforeEach(() => {
    fakeTime = 1000;
    advance = (s: number) => { fakeTime += s; };
    nowFn = () => fakeTime;
  });

  it('applies reopenWithReqPerS and reopenWithSimultanousRequests after full close', async () => {
    const valve = createValve({
      fullCloseAfterNFailures: 2,
      fullCloseDurationS: 1,
      maxReqPerSecond: 10,
      maxSimultaneousRequests: 5,
      reopenWithReqPerS: 2,
      reopenWithSimultanousRequests: 1,
      controlPeriodS: 1,
      nowFn
    });
    const alwaysFail = async () => { throw new Error('fail'); };
    const wrapped = valve.add(alwaysFail);

    // Trigger full close
    await expect(wrapped()).rejects.toThrow('fail');
    await expect(wrapped()).rejects.toThrow('fail');
    await expect(wrapped()).rejects.toBeInstanceOf(CircuitBreakerException);
    console.log('2');
    // Advance time to after full close duration
    advance(1.1);
    // Now, circuit should allow calls again, but with reduced limits
    // Fill up the single allowed simultaneous request
    let resolveFirst: (() => void) | undefined;
    const slow = () => new Promise<void>(res => { resolveFirst = res; });
    const wrappedSlow = valve.add(slow);
    const p = wrappedSlow();
    let rateLimited = false;
    console.log('3');
    try {
      await expect(wrappedSlow()).rejects.toBeInstanceOf(RateLimitedException);
      console.log('3.1');
      rateLimited = true;
    } finally {
      console.log('3.2');
      if (resolveFirst) resolveFirst();
      console.log('3.3');
      await p;
    }
    console.log('4');
    expect(rateLimited).toBe(true);
    // Now, test rate limit: only 2 per second allowed
    advance(5);
    const fast = async () => 'ok';
    const wrappedFast = valve.add(fast);
    await wrappedFast();
    // Advance time slightly to simulate real requests within the same second
    advance(0.1);
    await wrappedFast();
    advance(0.1);
    console.log('7');
    await expect(wrappedFast()).rejects.toBeInstanceOf(RateLimitedException);
    console.log('8');
    // Advance time to clear buffer, should allow again
    advance(1.1);
    console.log('9');
    await expect(wrappedFast()).resolves.toBe('ok');
    console.log('9.1');
  }, 1500); // 1.5s timeout for this test
});

describe('Soft break recovers and increases dynamicReqPerS as fail rate drops', () => {
  let fakeTime: number;
  let advance: (s: number) => void;
  let nowFn: () => number;
  beforeEach(() => {
    fakeTime = 1000;
    advance = (s: number) => { fakeTime += s; };
    nowFn = () => fakeTime;
  });

  it('increases dynamicReqPerS as failure rate drops below softBreakFailMaxPercentage', async () => {
    const valve = createValve({
      maxReqPerSecond: 10,
      minReqPerSecond: 2,
      softBreakFailMinPercentage: 50, // If >50% fail, reduce rate
      softBreakReqDecreaseFactor: 0.5, // Halve the rate
      softBreakFailMaxPercentage: 10, // If <10% fail, increase rate
      softBreakReqIncreaseFactor: 2, // Double the rate when recovering
      controlPeriodS: 2,
      softBreakCheckAfterS: 0, // Always allow soft break check
      nowFn
    });
    // Fail enough to trigger soft break
    const alwaysFail = async () => { throw new Error('fail'); };
    const wrappedFail = valve.add(alwaysFail);
    for (let i = 0; i < 4; i++) {
      await expect(wrappedFail()).rejects.toThrow('fail');
      advance(0.5);
    }
    // Succeed enough to drop fail rate
    advance(2); // Move out of failure window
    const alwaysSucceed = async () => 'ok';
    const wrappedSucceed = valve.add(alwaysSucceed);
    for (let i = 0; i < 10; i++) {
      await expect(wrappedSucceed()).resolves.toBe('ok');
      advance(0.2);
    }
    // Make a dummy call to trigger soft break check
    await wrappedSucceed();
    // Now, dynamicReqPerS should have increased (doubled from the reduced value, but not above maxReqPerSecond)
    // We can't access dynamicReqPerS directly, so we test by making requests in a tight window
    let allowed = 0;
    for (let i = 0; i < 5; i++) {
      try {
        await wrappedSucceed();
        allowed++;
      } catch (e) {
        break;
      }
    }
    expect(allowed).toBeGreaterThan(2); // Should be more than the reduced rate (2)
  });
});

describe('Soft break reduces dynamicReqPerS as fail rate increases, increases dynamicReqPerS as fail rate decreases', () => {
  let fakeTime: number;
  let advance: (s: number) => void;
  let nowFn: () => number;
  beforeEach(() => {
    fakeTime = 1000;
    advance = (s: number) => { fakeTime += s; };
    nowFn = () => fakeTime;
  });

  it('dynamicReqPerS following fail rate', async () => {
    const valve = createValve({
      maxReqPerSecond: 10,
      minReqPerSecond: 2,
      softBreakFailMinPercentage: 50, // If >50% fail, reduce rate
      softBreakReqDecreaseFactor: 0.5, // Halve the rate
      softBreakFailMaxPercentage: 10, // If <10% fail, increase rate
      softBreakReqIncreaseFactor: 2, // Double the rate when recovering
      controlPeriodS: 2,
      softBreakCheckAfterS: 2,
      nowFn
    });
    // Succeed enough to keep fail rate low initially
    const alwaysSucceed = async () => 'ok';
    const wrappedSucceed = valve.add(alwaysSucceed);
    for (let i = 0; i < 4; i++) {
      await expect(wrappedSucceed()).resolves.toBe('ok');
      advance(0.5);
    }
    // Fail enough to trigger soft break
    advance(2); // Move out of success window
    const alwaysFail = async () => { throw new Error('fail'); };
    const wrappedFail = valve.add(alwaysFail);
    for (let i = 0; i < 4; i++) {
      await expect(wrappedFail()).rejects.toThrow('fail');
      advance(0.5);
    }
    // Make a dummy call to trigger soft break check (all failures are still within controlPeriodS)
    await wrappedFail().catch(() => {});
    // Now, dynamicReqPerS should have decreased (halved from the max value, but not below minReqPerSecond)
    let allowed = 0;
    for (let i = 0; i < 10; i++) {
      try {
        await wrappedSucceed();
        allowed++;
      } catch (e) {
        break;
      }
    }
    expect(allowed).toBeLessThanOrEqual(5); // Should be less than the max rate (10 per 2s window)
    expect(allowed).toBeGreaterThanOrEqual(2); // But not less than minReqPerSecond

    advance(1); // Move out of failure window
    await expect(wrappedSucceed()).resolves.toBe('ok');
    advance(1); // Move out of failure window
    await expect(wrappedSucceed()).resolves.toBe('ok');
    advance(2); // Move out of success window
    // Now should be unthrottled again
    allowed = 0;
        for (let i = 0; i < 10; i++) {
      try {
        await wrappedSucceed();
        allowed++;
      } catch (e) {
        break;
      }
    }
    expect(allowed).toEqual(10);

  });
});
