# Circuit Valve 🚦

**Circuit Valve** is a robust TypeScript library for backend services, blending the best of circuit breakers, rate limiters, and retry logic into a single, easy-to-use package. It helps your services stay resilient, avoid overloading dependencies, and gracefully handle failures—so your systems keep running smoothly, even when things get bumpy!

---

## Why Circuit Valve?

- **Protect your dependencies:** Prevents hammering databases, APIs, or other services when they're struggling.
- **Stay stable under pressure:** Dynamically adjusts request rates and concurrency to match real-world conditions.
- **Fail fast, recover smart:** Circuit breaker logic stops repeated failures and lets you control how and when to try again.
- **Retry with care:** Built-in retry mechanism with smart limits, so you don't make things worse.

---

## Features ✨

- **Efficient ring buffer** for tracking recent requests and failures (O(1) operations)
- **Accurate rate limiting** by requests per second and simultaneous requests
- **Circuit breaker** that opens on too many failures, with configurable recovery
- **Soft breaker**: Dynamic rate/concurrency reduction when failures spike, with gradual recovery
- **Customizable retry**: Automatic retries with limits on count, time, and failure rate
- **Event hooks** for logging, monitoring, or alerting
- **Global registry** for stats and integration with observability tools
- **Decorator support**: Use `@ValveGuard('valveName')` to protect class methods or functions with a named valve

---

## Quick Example

```typescript
import { createValve, RateLimitedException, CircuitBreakerException } from 'circuit-valve';

const valve = createValve({
  name: 'my-db',
  maxReqPerSecond: 10,
  maxSimultaneousRequests: 3,
  controlPeriodS: 5,
  controlPeriodMaxRequests: 50,
  fullCloseAfterNFailures: 5,
  fullCloseDurationS: 30,
  maxRetryCount: 2,
});

// Wrap your async function
const safeQuery = valve.add(async (sql) => {
  // ...call your DB here...
});

try {
  await safeQuery('SELECT * FROM users');
} catch (err) {
  if (err instanceof RateLimitedException) {
    // Too many requests! Back off and retry later
  } else if (err instanceof CircuitBreakerException) {
    // Circuit is open! Dependency is unhealthy
  } else {
    // Handle other errors
  }
}
```

---


## Decorator Usage: ValveGuard

You can use the `@ValveGuard('valveName')` decorator to automatically wrap a function or class method with an existing valve from the global registry. This is handy for enforcing rate limits and circuit breaking on service methods or handlers without manual wrapping.

**Example:**

```typescript
import { createValve, ValveGuard } from 'circuit-valve';

createValve({
  name: 'my-db',
  maxReqPerSecond: 10,
  // ...other options...
});

class MyService {
  @ValveGuard('my-db')
  async fetchData(sql: string) {
    // ...call your DB here...
  }
}

// Or for standalone functions:
const safeQuery = ValveGuard('my-db')(async (sql: string) => {
  // ...call your DB here...
});
```

If the valve does not exist, the decorator will throw an error at call time.


---

## How It Works

- **Rate Limiting:**
  - Set `maxReqPerSecond` and/or `maxSimultaneousRequests`.
  - If limits are exceeded, throws `RateLimitedException` (your function is NOT called).
- **Circuit Breaker:**
  - Opens if too many failures in a row or high failure rate.
  - While open, all calls throw `CircuitBreakerException`.
  - After a cooldown, circuit reopens (optionally with lower limits for a soft start).
- **Soft Breaker:**
  - If failure rate is high, dynamically lowers allowed rates/concurrency.
  - Gradually recovers as things stabilize.
- **Retry:**
  - If enabled, failed calls are retried (with limits on count, time, and failure rate).
- **Stats & Observability:**
  - Each valve is globally registered for stats and can be integrated with monitoring tools.

---

## Configuration Options

| Option                        | Description                                                                 | Default         |
|-------------------------------|-----------------------------------------------------------------------------|-----------------|
| `name`                        | Unique name for this valve (required)                                       | —               |
| `maxReqPerSecond`             | Max requests per second                                                     | ∞               |
| `maxSimultaneousRequests`     | Max concurrent requests                                                     | ∞               |
| `controlPeriodS`              | Time window for rate/failure stats (seconds)                                | 5               |
| `controlPeriodMaxRequests`    | Max requests tracked in buffer                                              | 1000            |
| `failureByException`          | Count exceptions as failures                                                | true            |
| `failureByTimeoutS`           | Count as failure if execution exceeds this many seconds                     | ∞               |
| `fullCloseAfterNFailures`     | Open circuit after N consecutive failures                                   | ∞               |
| `fullCloseOnFailPercentage`   | Open circuit if failure % in window exceeds this                            | ∞               |
| `fullCloseDurationS`          | How long to keep circuit open (seconds)                                     | 10              |
| `fullCloseDurationIncreaseFactor` | Multiplier for close duration if circuit reopens quickly                  | 1               |
| `fullCloseDurationMaxS`       | Max time to keep circuit open (seconds)                                     | 120             |
| `reopenWithReqPerS`           | Rate limit (req/s) after reopening circuit                                  | maxReqPerSecond |
| `reopenWithSimultanousRequests`| Simultaneous limit after reopening circuit                                  | maxSimultaneousRequests |
| `minReqPerSecond`             | Minimum req/sec in soft break mode                                          | 0               |
| `minSimultaneousRequests`     | Minimum concurrent in soft break mode                                       | 0               |
| `softBreakFailMinPercentage`  | If failure % exceeds this, lower rates                                      | 0               |
| `softBreakReqDecreaseFactor`  | Factor to decrease req/sec in soft break                                    | 0.9             |
| `softBreakSimulDecreaseFactor`| Factor to decrease concurrency in soft break                                | 0.9             |
| `softBreakFailMaxPercentage`  | If failure % drops below this, increase rates                               | 0               |
| `softBreakCheckAfterS`        | Minimum seconds between soft break checks                                   | 60              |
| `softBreakReqIncreaseFactor`  | Factor to increase req/sec in soft break recovery                           | 1.05            |
| `softBreakSimulIncreaseFactor`| Factor to increase concurrency in soft break recovery                       | 1.05            |
| `maxRetryCount`               | Retries on failure                                                          | 0               |
| `retryOnlyIfFailPctUnder`     | Only retry if failure % is under this                                       | 100             |
| `retryTimeoutS`               | Only retry if previous retries took less than this (seconds)                | ∞               |
| `nowFn`                       | Custom time function (for testing)                                          | Date.now/1000   |
| `eventReporter`               | Custom event reporter for logging/monitoring                                | ConsoleValveEventReporter |

---

## Advanced: Event Reporting

You can pass a custom `eventReporter` to receive callbacks for high failure rates, retries, circuit open/close, and rate limiting. A default console reporter is included.

---

## Removing a Valve

If you need to clean up a valve (e.g., in tests or dynamic systems):

```typescript
import { removeValve } from 'circuit-valve';
removeValve('my-db');
```

---

## Installation

```bash
npm install circuit-valve
```

---

## License

MIT

---

## Contributing

PRs and issues welcome!
