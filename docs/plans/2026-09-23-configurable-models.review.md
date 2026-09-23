# Plan review: Configurable Models, Effort and TypeSafe Key Implementation Plan

## Verdict

NEEDS CHANGES — Token validation still permits a trailing newline, and SDK logging bypasses the planned secret redaction.

## Findings (confidence 7+)

[P1] (confidence: 9/10) Task 1 Step 4 and Task 3 Step 6 — Round-1 token-validation finding remains partially unresolved: JavaScript's `$` anchor permits a match before a final line terminator, so `MODEL_TOKEN.test("gpt-test\n")` accepts the value; the config CLI consequently emits `gpt-test\n\ndefault\n`, and the launcher's second-line extraction produces an empty reasoning value instead of `default` — Explicitly reject line terminators or require the match to consume the entire string; extend the existing all-sources table with trailing LF, CR and CRLF values and assert exit 1, empty stdout, a field-only error, and no reviewer launch.

[P1] (confidence: 9/10) Task 4 Steps 1 and 4; vendor-node/@typesafe-ai/sdk/dist/index.mjs:618 — Secret redaction covers only the caught exception: `new TypeSafeClient({ apiKey })` still honors `TYPESAFE_LOG_LEVEL=debug`, and the SDK logs the unredacted HTTP error body through `console.debug` before throwing; the planned 400 response containing the dummy key therefore leaks it to stdout despite the later redacted stderr line, while successful debug/info logging also contaminates JSON stdout — Disable SDK logging explicitly or supply a logger that redacts every argument and writes only to stderr; run the new HTTP error test with debug enabled and assert neither stream contains the key, then run a successful request with debug/info enabled and assert stdout remains exactly one parseable JSON result.

## Appendix (confidence below 7)

None

## Section notes

### 1. Architecture

The configuration-to-launcher and SDK-to-output boundaries retain the two failures above. Resolved from round 1: array-contained secrets are traversed; dangling-agent-link replacement is now an explicit user decision with separate existing-target collision checks; report completion uses a marker; interrupted code reviews recover the same scope-based session despite report suffix changes. Missing/malformed config, damaged agent definitions, SDK failures and already-closed terminals have defined handling. Agent generation, installation, release/update guidance and manual host acceptance are specified; no additional integration artifact is missing.

### 2. Code quality

Resolved from round 1: triage application no longer depends on A/B labels, and README text and its diagram are updated for configurable tiers and local keys. The generator comment now limits its no-write guarantee to validation errors. Remaining validation and logging fixes should be centralized at their respective boundaries so all consumers receive the same guarantees.

### 3. Tests

Static review only; no tests or builds run. Resolved from round 1: copied-script dependencies, invalid SDK mock shape, inherited HOME/obsolete guard assertions, weak local-key testing, and the enumerated missing failure cases. The `node:test`/`node:assert/strict` plan now exercises config loading/shape/precedence/CLI, generation/rendering/drift, launcher flags/no-Node fallback/completion/session cleanup, real SDK HTTP requests/errors, installer collisions/link/repoint/unlink, dispatch wording, ledger matching and triage application. The trailing-terminator and SDK-log-level cases above remain absent. Runtime agent discovery/model selection stays in manual acceptance.

### 4. Performance

No issues found. The revisions introduce bounded startup reads, three-agent generation, bounded marker polling and local HTTP test fixtures; no material new fan-out, unbounded growth or hot-path blocking is apparent.
