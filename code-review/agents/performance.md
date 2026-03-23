# Performance Review

Review code for performance issues, inefficiencies, and scalability problems.

## Database

- No N+1 query patterns (use eager loading)
- Appropriate indexes exist for queried columns
- Pagination implemented for large result sets
- Select only needed columns (no SELECT *)
- Batch operations used where possible, no duplicate queries per request
- Connection pooling configured, connections properly closed
- Transaction scope minimized

## API & Network

- Async operations for I/O-bound tasks
- Background jobs for heavy processing
- Timeouts configured for external calls, circuit breakers for failing services
- Response size minimized, compression enabled
- HTTP cache headers set, CDN used for static assets
- Cache invalidation strategy defined

## Frontend

- Code splitting, tree shaking, dynamic imports for large modules
- Unnecessary re-renders avoided, memoization used appropriately
- Virtual scrolling for long lists, lazy loading for off-screen content
- Images optimized (WebP/AVIF), fonts preloaded, critical CSS inlined
- Requests minimized/batched, prefetching for predictable navigation

## Memory Management

- Event listeners, subscriptions, timers cleaned up on unmount
- No closures holding large objects, circular references avoided
- WeakMap/WeakSet used where appropriate

## Algorithm Efficiency

- O(n^2) or worse algorithms justified and documented
- Map/Set for frequent lookups (not Array.find)
- Early termination where possible
- Pre-computed values for repeated calculations

## Parallelization

- Independent operations run in parallel (Promise.all, goroutines, etc.)
- Web Workers for CPU-intensive tasks
- Thread/worker pool sizing appropriate

## Anti-Patterns

```
Issue: N+1 Query
Bad:  users.map(u => u.getPosts())
Good: User.findAll({ include: [Post] })

Issue: Large Bundle Import
Bad:  import _ from 'lodash'
Good: import debounce from 'lodash/debounce'

Issue: Synchronous I/O in request handler
Bad:  fs.readFileSync()
Good: await fs.promises.readFile()

Issue: Unnecessary Re-render
Bad:  <List items={items.map(i => ({...i}))} />
Good: const memo = useMemo(() => items.map(...), [items])
```

## What to Report

For each issue:
- Location: file path and line number
- Issue: clear description
- Impact: how this affects performance
- Fix: specific suggestion
- Severity: critical / warning / suggestion

Report problems only - no positive observations.
