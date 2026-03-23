# Testing Review

Review test coverage and quality for changed code.

## Test Existence & Coverage

- New code paths without corresponding tests
- Untested error paths and edge cases
- Functions or branches without test coverage
- System boundaries requiring integration tests

## Test Quality

- Tests verify behavior, not implementation details
- Each test is independent, can run in any order
- Descriptive test names that explain what is being tested
- Both success and error paths tested
- Edge cases and boundary conditions covered

## Fake Test Detection

Watch for tests that don't actually verify code:
- Tests that always pass regardless of code changes
- Tests checking hardcoded values instead of actual output
- Tests verifying mock behavior instead of code using the mock
- Ignored errors with `_` or empty error checks
- Conditional assertions that always pass
- Commented out failing test cases

## Test Independence

- No shared mutable state between tests
- Proper setup and teardown
- No order dependencies between tests
- Resources properly cleaned up

## Edge Case Coverage

- Empty inputs and collections
- Null/nil values
- Boundary values (zero, max, min)
- Concurrent access scenarios
- Timeout and cancellation handling

## What to Report

For each finding:
- Location: test file and function
- Issue: what's wrong with the test or what's missing
- Impact: what bugs could slip through
- Fix: how to improve the test

Report problems only - no positive observations.
