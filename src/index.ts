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
    /** Unique name for this valve (required) */
    name: string;

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

    // Event reporting and logging
    eventReporter?: ValveEventReporter; // Optional event reporter for valve events. Pass ConsoleValveEventReporter or a custom implementation of ValveEventReporter to receive events like high failure rates, retries, circuit openings, etc.
}

export interface Valve {
    add<T extends (...args: any[]) => Promise<any>>(wrappee: T, options?: Partial<Pick<ValveOptions, 'failureByException' | 'failureByTimeoutS' | 'maxRetryCount'>>): T;
}

export interface ValveEventReporter {
    onHighFailureRate?(failureRate: number, options: ValveOptions, name: string): void;
    onRetry?(attempt: number, error: any, options: ValveOptions, name: string): void;
    onCircuitOpen?(duration: number, options: ValveOptions, name: string): void;
    onCircuitClose?(options: ValveOptions, name: string): void;
    onRateLimit?(type: 'reqPerS' | 'simultaneous', current: number, limit: number, options: ValveOptions, name: string): void;
}

/**
 * A console-based implementation of ValveEventReporter that logs valve events to the console.
 * 
 * This reporter outputs different types of valve events using appropriate console methods:
 * - Warnings for high failure rates, circuit opening, and rate limiting
 * - Info messages for retries and circuit closing
 * 
 * @example
 * ```typescript
 * const reporter = new ConsoleValveEventReporter();
 * // pass this reporter to the valve options
 * ```
 */
export class ConsoleValveEventReporter implements ValveEventReporter {
    onHighFailureRate(failureRate: number, _options: ValveOptions, name: string) {
        console.warn(`[Valve:${name}] High failure rate detected: ${failureRate.toFixed(2)}%`);
    }
    onRetry(attempt: number, error: any, _options: ValveOptions, name: string) {
        console.info(`[Valve:${name}] Retry attempt ${attempt} after error:`, error);
    }
    onCircuitOpen(duration: number, _options: ValveOptions, name: string) {
        console.warn(`[Valve:${name}] Circuit opened for ${duration.toFixed(2)} seconds.`);
    }
    onCircuitClose(_options: ValveOptions, name: string) {
        console.info(`[Valve:${name}] Circuit closed.`);
    }
    onRateLimit(type: 'reqPerS' | 'simultaneous', current: number, limit: number, _options: ValveOptions, name: string) {
        console.warn(`[Valve:${name}] Rate limit exceeded (${type}): current=${current}, limit=${limit}`);
    }
}

// Global registry for all valves
const circuitValveRegistry: Record<string, { getStats: () => any; valve: Valve }> = (globalThis as any).circuitValveRegistry = (globalThis as any).circuitValveRegistry || {};

export function createValve(opts: ValveOptions): Valve {
    if (!opts.name || typeof opts.name !== 'string') {
        throw new Error('ValveOptions.name is required and must be a string');
    }
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
        eventReporter: undefined,
        ...opts
    };

    // Check buffer size is sufficient for maxReqPerSecond
    if (options.maxReqPerSecond > options.controlPeriodMaxRequests / options.controlPeriodS) {
        throw new Error(
            `ValveOptions.controlPeriodMaxRequests (${options.controlPeriodMaxRequests}) is too small for maxReqPerSecond (${options.maxReqPerSecond}) and controlPeriodS (${options.controlPeriodS}). ` +
            `Increase controlPeriodMaxRequests to at least maxReqPerSecond * controlPeriodS to ensure accurate rate limiting.`
        );
    }

    let buffer: RequestRecord[] = new Array(options.controlPeriodMaxRequests);
    let bufferStart = 0; // index of oldest
    let bufferEnd = 0;   // index to write next
    let bufferCount = 0; // number of valid entries
    let failCount = 0;   // number of failures in buffer
    let currentSimultaneous = 0;
    let consecFailures = 0;
    let circuitOpenUntil = 0;
    let fullCloseCount = 0;

    let dynamicReqPerS = options.maxReqPerSecond;
    let dynamicSimul = options.maxSimultaneousRequests;
    let lastSoftCheck = 0;

    const eventReporter: ValveEventReporter = options.eventReporter || new ConsoleValveEventReporter();

    function now() {
        return options.nowFn ? options.nowFn() : Date.now() / 1000;
    }

    function prune() {
        const cutoff = now() - options.controlPeriodS;
        while (bufferCount > 0) {
            const rec = buffer[bufferStart];
            if (rec && rec.timestamp < cutoff) {
                if (!rec.success) failCount--;
                bufferStart = (bufferStart + 1) % options.controlPeriodMaxRequests;
                bufferCount--;
            } else {
                break;
            }
        }
    }

    function failureRate() {
        if (!bufferCount) return 0;
        return (failCount / bufferCount) * 100;
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
        eventReporter.onCircuitOpen?.(duration, options, options.name);
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
                dynamicReqPerS = options.reopenWithReqPerS ?? options.maxReqPerSecond;
                dynamicSimul = options.reopenWithSimultanousRequests ?? options.maxSimultaneousRequests;
                lastSoftCheck = now();
                eventReporter.onCircuitClose?.(options, options.name);
            }

            prune();
            checkSoftBreak();

            // rate limiter
            const rate = bufferCount / options.controlPeriodS;
            if (rate >= dynamicReqPerS) {
                eventReporter.onRateLimit?.('reqPerS', rate, dynamicReqPerS, options, options.name);
                throw new RateLimitedException(dynamicReqPerS, dynamicSimul, 'reqPerS');
            }
            if (currentSimultaneous >= dynamicSimul) {
                eventReporter.onRateLimit?.('simultaneous', currentSimultaneous, dynamicSimul, options, options.name);
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
                    if (attempt > 0) {
                        eventReporter.onRetry?.(attempt, err, options, options.name);
                    }
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
            // Add to ring buffer
            if (bufferCount == options.controlPeriodMaxRequests) {
                // Remove oldest
                if (!buffer[bufferStart].success) failCount--;
                bufferStart = (bufferStart + 1) % options.controlPeriodMaxRequests;
                bufferCount--;
            }
            buffer[bufferEnd] = { timestamp: nowAfterExecution, success, duration };
            if (!success) failCount++;
            bufferEnd = (bufferEnd + 1) % options.controlPeriodMaxRequests;
            bufferCount++;
            if (success)
                consecFailures = 0;

            // after execution
            prune();
            // circuit breaker
            const failRate = failureRate();
            if (failRate > options.softBreakFailMinPercentage) {
                eventReporter.onHighFailureRate?.(failRate, options, options.name);
            }
            if (consecFailures >= options.fullCloseAfterNFailures || failRate > options.fullCloseOnFailPercentage) {
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

    // Register in global registry
    circuitValveRegistry[options.name] = {
        getStats: () => {
            // Compute reqPerS as number of requests in the last controlPeriodS seconds
            const nowTs = now();
            let countInWindow = 0;
            for (let i = 0, idx = bufferStart; i < bufferCount; i++, idx = (idx + 1) % options.controlPeriodMaxRequests) {
                const rec = buffer[idx];
                if (rec && rec.timestamp >= nowTs - options.controlPeriodS) {
                    countInWindow++;
                }
            }
            return {
                name: options.name,
                reqPerS: countInWindow / options.controlPeriodS,
                failRate: failureRate(),
                currentSimultaneous,
                circuitOpen: circuitOpenUntil > now(),
                dynamicReqPerS,
                dynamicSimul,
                bufferSize: bufferCount,
                fullCloseCount,
            };
        },
        valve: { add }
    };
    // happy-server integration

    function registerHappyServerExtension(): boolean {
        if (typeof (globalThis as any).happyServerExtension === 'object' && (globalThis as any).happyServerExtension) {
            (globalThis as any).happyServerExtension[`circuit-valve-${options.name}`] = () => circuitValveRegistry[options.name].getStats();
            return true;
        }
        return false;
    }
    if (!registerHappyServerExtension())
        setTimeout(registerHappyServerExtension, 3000);

    return {
        add
    };
}

export function removeValve(name: string) {
    delete circuitValveRegistry[name];
    if (typeof (globalThis as any).happyServerExtension === 'object' && (globalThis as any).happyServerExtension) {
        delete (globalThis as any).happyServerExtension[`circuit-valve-${name}`];
    }
}

/**
 * Decorator to wrap a function with an existing valve by name.
 * Usage:
 *   @ValveGuard('my-db')
 *   async function myFunc(...) { ... }
 * Throws if the valve does not exist in the registry.
 */
export function ValveGuard(valveName: string) {
    return function (
        target: any,
        propertyKey?: string | symbol,
        descriptor?: TypedPropertyDescriptor<any>
    ) {
        // For method decorator
        if (descriptor && typeof descriptor.value === 'function') {
            const original = descriptor.value;
            descriptor.value = function (...args: any[]) {
                const entry = circuitValveRegistry[valveName];
                if (!entry || !entry.valve) throw new Error(`Valve '${valveName}' not found in registry`);
                return entry.valve.add(original).apply(this, args);
            };
            return descriptor;
        }
        // For function/class decorator (direct)
        if (typeof target === 'function') {
            const entry = circuitValveRegistry[valveName];
            if (!entry || !entry.valve) throw new Error(`Valve '${valveName}' not found in registry`);
            return entry.valve.add(target);
        }
        throw new Error('ValveGuard can only be used on functions or methods');
    };
}
