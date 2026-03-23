# Security Review

Review code for security vulnerabilities and unsafe patterns.

## Authentication & Sessions

- Passwords hashed with bcrypt/argon2 (not MD5/SHA1)
- Sessions expire, tokens cryptographically random, invalidated on logout
- JWTs have appropriate expiration, refresh token rotation implemented
- Secure and HttpOnly cookie flags set
- No passwords in logs or error messages

## Authorization

- All endpoints require authentication (unless explicitly public)
- Deny by default, role-based access properly implemented
- Users can only access their own data, no IDOR vulnerabilities
- Admin functions restricted, tenant isolation enforced

## Input Validation

- All user input validated, length and type limits enforced
- Whitelist validation preferred over blacklist
- File uploads: type validated (not just extension), size limited, stored outside web root

## Injection & XSS

- Parameterized queries used (no string concatenation with user input)
- ORM used properly, no raw SQL with user input
- All output HTML-encoded, Content-Security-Policy header set
- User content sanitized before display

## Secrets Management

- No hardcoded secrets, API keys, or credentials in code
- Environment variables or secret vault for configuration
- .gitignore includes sensitive files, no secrets in commit history

## API Security

- Rate limiting implemented, request size limits set
- CORS properly configured
- Error messages don't leak internal info, no stack traces in production
- Security headers set: X-Content-Type-Options, X-Frame-Options, Referrer-Policy

## Logging

- Authentication and authorization events logged
- Logs don't contain sensitive data (passwords, tokens, PII)
- Alerting configured for suspicious activity

## Critical Patterns to Flag

```
Pattern: hardcoded credentials
Example: const password = "admin123"
Action: Remove immediately, rotate credential

Pattern: SQL injection
Example: `SELECT * FROM users WHERE id = ${userId}`
Action: Use parameterized query

Pattern: XSS vulnerability
Example: innerHTML = userInput
Action: Use textContent or sanitize

Pattern: Missing authentication
Example: Public endpoint exposing sensitive data
Action: Add authentication middleware
```

## What to Report

For each issue:
- Location: file path and line number
- Issue: clear description
- Impact: how this affects security
- Fix: specific suggestion
- Severity: critical / warning / suggestion

Report problems only - no positive observations.
