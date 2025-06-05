// src/index.ts

export class CircuitValveException extends Error { }

export class RateLimitedException extends CircuitValveException {
    constructor(
        public currentReqPerS: number,
        public currentSimultanousConnections: number,
        public reason: 'reqPerS' | 'simultaneous',
        message?: string
    ) {
        super(message || 'Rate limit exceeded');
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

export class CircuitBreakerException extends CircuitValveException {
    constructor(message?: string) {
        super(message || 'Circuit breaker is open');
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

interface RequestRecord {
    timestamp: number;
    success: boolean;
    duration: number;
}

export interface ValveOptions {
    // This is a general setting, which period is being monitored for rates and failures.
    controlPeriodS?: number;       // duration of the period that is checked to stay in maxReqPerSecond. Default: 5s. 
    controlPeriodMaxRequests?: number; // maximum number of requests in the control period to watch. Default: 1000

    // This is the max number of requests allowed, if the circuit breaker is fully open
    maxReqPerSecond?: number;     // default: no limit
    maxSimultaneousRequests?: number;   // default: no limit

    // This defines a failure
    failureByException?: boolean; // if true (default), exceptions count as failure. Can be overwritten in the wrapper.
    failureByTimeoutS?: number;  // if set, it counts as a failure if it exceeds this many seconds. Can be overridden in the wrapper.

    // This setting configures the full close of the valve (real circuit breaker)
    fullCloseAfterNFailures?: number;   // if this many requests break in a row (without success), fully close
    fullCloseOnFailPercentage?: number; // if this percentage of requests break within the controlPeriodS, fully close (100-based)
    fullCloseDurationS?: number;        // when fully closed for the first time, do not make any request for this duration (see also fullCloseDurationIncreaseFactor). Default: 10s
    fullCloseDurationIncreaseFactor?: number; // if the circuit breaker breaks again after closing, crease by this factor (>=1, default 1) 
    fullCloseDurationMaxS?: number;      // the max wait period after failing several times. Default: 120s 
    reopenWithReqPerS?: number;                     // after fullCloseDurationS, default is maxReqPerSecond
    reopenWithSimultanousRequests?: number;         // after fullCloseDurationS, default is maxSimultaneousRequests

    // Soft break: in soft break mode, the valve will limit the requests to a lower number when the system is unstable otherwise
    minReqPerSecond?: number;     // in soft break mode, always allow at least this many requests/second
    minSimultaneousRequests?: number;     // in soft break mode, always allow at least this many simultanous requests

    softBreakFailMinPercentage?: number;   // if more than this percentage of requests fail in controlPeriodS, lower the rate by the two following percentages
    softBreakReqDecreaseFactor?: number; // when failures reach softBreakFailMinPercentage, the allowed request rate should be decreased by softBreakReqDecreaseFactor (but not below minReqPerSecond; default: 0.9)
    softBreakSimulDecreaseFactor?: number; // when failures reach softBreakFailMinPercentage, the allowed number of simultanous requests should be decreased by softBreakSimulDecreaseFactor (but not below minSimultaneousRequests; default: 0.9)
    softBreakFailMaxPercentage?: number;   // if the failure percentage is less than that, the soft break can be opened (default: 0)
    softBreakCheckAfterS?: number;   // this many seconds after changing the soft break, if softBreakFailMaxPercentage has been reached, the soft valve may be slowly opened (default: 60s)
    softBreakReqIncreaseFactor?: number; // when the softBreak value opend, the allowed request rate should be increased by softBreakReqIncreaseFactor (but not above maxReqPerSecond; default: 1.05)
    softBreakSimulIncreaseFactor?: number; // when the softBreak value opend, the allowed number of simultanous requests should be increased by softBreakSimulDecreaseFactor (but not above maxSimultaneousRequests; default: 1.05)

    // Retry: allow enabling Retry
    maxRetryCount?: number; // if >0, will be retried this often on exception (default: 0, never retry)
    retryOnlyIfFailPctUnder?: number; // if set, you can limit the use of the retry mechanism to be used only when the fail rate is below the given percentage
    retryTimeoutS?: number;           // if set, a retry is only attempted if previous retry attempts took less that this duration (in seconds)

    // For testing: allow injecting a custom time function
    nowFn?: () => number; // For testing: allow injecting a custom time function
}

export interface Valve {
    add<T extends (...args: any[]) => Promise<any>>(wrappee: T, options?: Partial<Pick<ValveOptions, 'failureByException' | 'failureByTimeoutS' | 'maxRetryCount'>>): T;
}

export function createValve(opts: ValveOptions): Valve {
    // defaults
    const options = {
        controlPeriodS: 5,
        controlPeriodMaxRequests: 1000,
        maxReqPerSecond: Infinity,
        maxSimultaneousRequests: Infinity,
        failureByException: true,
        failureByTimeoutS: Infinity,
        fullCloseAfterNFailures: Infinity,
        fullCloseOnFailPercentage: Infinity,
        fullCloseDurationS: 10,
        fullCloseDurationIncreaseFactor: 1,
        fullCloseDurationMaxS: 120,
        reopenWithReqPerS: undefined,
        reopenWithSimultanousRequests: undefined,
        minReqPerSecond: 0,
        minSimultaneousRequests: 0,
        softBreakFailMinPercentage: 0,
        softBreakReqDecreaseFactor: 0.9,
        softBreakSimulDecreaseFactor: 0.9,
        softBreakFailMaxPercentage: 0,
        softBreakCheckAfterS: 60,
        softBreakReqIncreaseFactor: 1.05,
        softBreakSimulIncreaseFactor: 1.05,
        maxRetryCount: 0,
        retryOnlyIfFailPctUnder: 100,
        retryTimeoutS: Infinity,
        nowFn: undefined,
        ...opts
    };

    let buffer: RequestRecord[] = [];
    let currentSimultaneous = 0;
    let consecFailures = 0;
    let circuitOpenUntil = 0;
    let fullCloseCount = 0;

    let dynamicReqPerS = options.maxReqPerSecond;
    let dynamicSimul = options.maxSimultaneousRequests;
    let lastSoftCheck = 0;

    function now() {
        return options.nowFn ? options.nowFn() : Date.now() / 1000;
    }

    function prune() {
        const cutoff = now() - options.controlPeriodS;
        buffer = buffer.filter(r => r.timestamp >= cutoff);
        if (buffer.length > options.controlPeriodMaxRequests) {
            buffer.splice(0, buffer.length - options.controlPeriodMaxRequests);
        }
    }

    function failureRate() {
        if (!buffer.length) return 0;
        const fails = buffer.filter(r => !r.success).length;
        return (fails / buffer.length) * 100;
    }

    function openCircuit() {
        const duration = Math.min(
            options.fullCloseDurationS * Math.pow(options.fullCloseDurationIncreaseFactor, fullCloseCount),
            options.fullCloseDurationMaxS
        );
        circuitOpenUntil = now() + duration;
        fullCloseCount++;
        dynamicReqPerS = options.reopenWithReqPerS ?? options.maxReqPerSecond;
        dynamicSimul = options.reopenWithSimultanousRequests ?? options.maxSimultaneousRequests;
    }

    function checkSoftBreak() {
        const since = now() - lastSoftCheck;
        if (since < options.softBreakCheckAfterS) return;
        const rate = failureRate();
        if (rate >= options.softBreakFailMinPercentage) {
            dynamicReqPerS = Math.max(options.minReqPerSecond, dynamicReqPerS * options.softBreakReqDecreaseFactor);
            dynamicSimul = Math.max(options.minSimultaneousRequests, dynamicSimul * options.softBreakSimulDecreaseFactor);
        } else if (rate <= options.softBreakFailMaxPercentage) {
            dynamicReqPerS = Math.min(options.maxReqPerSecond, dynamicReqPerS * options.softBreakReqIncreaseFactor);
            dynamicSimul = Math.min(options.maxSimultaneousRequests, dynamicSimul * options.softBreakSimulIncreaseFactor);
        }
        lastSoftCheck = now();
    }

    function add<T extends (...args: any[]) => Promise<any>>(fn: T, override: Partial<Pick<ValveOptions, 'failureByException' | 'failureByTimeoutS' | 'maxRetryCount'>> = {}): T {
        const failByEx = override.failureByException ?? options.failureByException;
        const failTimeoutS = override.failureByTimeoutS ?? options.failureByTimeoutS;
        const retries = override.maxRetryCount ?? options.maxRetryCount;

        const wrapped = (async (...args: any[]) => {
            const invocationStart = now();
            prune();

            // Circuit closed?
            if (now() < circuitOpenUntil) {
                throw new CircuitBreakerException();
            }

            // reopen
            if (circuitOpenUntil && now() >= circuitOpenUntil) {
                circuitOpenUntil = 0;
                consecFailures = 0;
                dynamicReqPerS = options.maxReqPerSecond;
                dynamicSimul = options.maxSimultaneousRequests;
                lastSoftCheck = now();
            }

            prune();
            checkSoftBreak();

            // rate limiter
            const rate = buffer.length / options.controlPeriodS;
            if (rate >= dynamicReqPerS) {
                throw new RateLimitedException(dynamicReqPerS, dynamicSimul, 'reqPerS');
            }
            if (currentSimultaneous >= dynamicSimul) {
                throw new RateLimitedException(dynamicReqPerS, dynamicSimul, 'simultaneous');
            }

            // execute with retry
            currentSimultaneous++;
            let result: any;
            let lastError: any;
            let success = false;
            let elapsedRetries = 0;
            for (let attempt = 0; attempt <= retries; attempt++) {
                const start = now();
                try {
                    result = failTimeoutS == Infinity ? await fn(...args) : await Promise.race([
                        fn(...args),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('cv-timeout')), (failTimeoutS - elapsedRetries) * 1000))
                    ]);
                    elapsedRetries += now() - start;
                    success = true;
                    break;
                } catch (err: any) {
                    lastError = err;
                    if (!failByEx && err.message != 'cv-timeout')
                        break;
                    elapsedRetries += now() - start;
                    consecFailures++;
                    if (attempt == retries || elapsedRetries > options.retryTimeoutS || failureRate() > options.retryOnlyIfFailPctUnder)
                        break;
                    continue;
                }
            }
            // record and cleanup
            currentSimultaneous--;
            const nowAfterExecution = now();
            const duration = nowAfterExecution - invocationStart;
            buffer.push({ timestamp: nowAfterExecution, success, duration });
            if (success)
                consecFailures = 0;

            // after execution
            prune();
            // circuit breaker
            if (consecFailures >= options.fullCloseAfterNFailures || failureRate() >= options.fullCloseOnFailPercentage) {
                openCircuit();
            }
            if (success) {
                return result;
            } else {
                throw lastError;
            }
        }) as T;

        return wrapped;
    }

    return {
        add
    };
}
