# Code Quality Review

Review code for correctness, maintainability, architecture, and simplicity.

## Correctness

### Logic & Data Flow
- Logic errors: off-by-one, incorrect conditionals, wrong operators
- Data flows correctly from input to output, transformations are correct
- State managed properly, no inconsistent state
- All errors checked, appropriate wrapping, no silent failures
- Resource management: proper cleanup, no leaks

### Completeness
- Implementation addresses all aspects of the requirement
- Wiring correct: components registered, routes added, handlers wired, configs updated
- No missing imports, unimplemented interfaces, incomplete migrations
- Edge cases handled: empty inputs, null values, concurrent access, error paths

### Concurrency (correctness only — parallelization perf is in performance agent)
- Race conditions, deadlocks, thread/coroutine leaks
- Data races from missing synchronization

## Readability & Structure

### Naming
- Variables describe content, functions describe action, classes describe responsibility
- No single-letter names (except loops/lambdas), abbreviations avoided
- Consistent conventions (camelCase, PascalCase, etc.)

### Functions & Structure
- Functions focused (single responsibility), ideally < 20 lines
- Nesting depth <= 3 levels, early returns and guard clauses used
- One concern per file, logical directory organization
- Clear module boundaries, minimal public API surface
- Dependencies flow in one direction, no circular dependencies

### Separation of Concerns
- Business logic separated from I/O
- UI separated from data fetching
- Configuration externalized
- Cross-cutting concerns isolated

## Type Safety

- All function parameters and return types specified
- No `any` types (or justified)
- Interfaces for complex objects, generics used appropriately
- Optional chaining, nullish coalescing, null checks, default values

## Error Handling

- Errors caught at appropriate level, specific error types used
- Error messages helpful, original error preserved (cause)
- Graceful degradation, retry logic where appropriate
- User-friendly error messages for non-critical failures

## Over-Engineering Detection

### Excessive Abstraction
- Wrapper adds nothing (method just calls another with same signature)
- Factory for single implementation
- Layer cake: handler -> service -> repository when each just passes through
- DTO/Mapper overkill: multiple types representing same data

### Premature Generalization
- Generic solution for specific problem (event bus for one event type)
- Config objects for 2-3 options when direct parameters suffice
- Plugin architecture for fixed functionality

### Unnecessary Indirection
- Pass-through wrappers that only delegate
- Excessive method chaining / builder pattern for simple constructions
- Middleware stacking that could be one

### Future-Proofing & Dead Code
- Unused extension points, hooks, callbacks with no callers
- Versioned internal APIs when only one version used
- Feature flags always on/off
- Fallbacks that never trigger, legacy mode always disabled

## Documentation Gaps

- Complex logic missing explanation (why, not what)
- Public APIs missing JSDoc/docstrings
- README needs update for new features, CLI flags, API endpoints, config options, breaking changes
- TODO/FIXME items not tracked, commented-out code present

## SOLID Principles

- Single Responsibility: classes have one reason to change
- Open/Closed: extensible without modification
- Liskov Substitution: subtypes substitutable, contracts preserved
- Interface Segregation: focused interfaces, no unused methods
- Dependency Inversion: depend on abstractions, use DI

## What to Report

For each issue:
- Location: file path and line number
- Issue: clear description
- Impact: how this affects the code
- Fix: specific suggestion
- Severity: critical / warning / suggestion

Report problems only - no positive observations.
