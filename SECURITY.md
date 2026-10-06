# Security policy

UNIORA is an authorization engine, so security reports are taken seriously.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately through GitHub: [Security advisories → Report a vulnerability](https://github.com/CodexSploitx/uniora/security/advisories/new).

Include what you found, how to reproduce it (a failing test or a short script is ideal), the affected package and version, and what an attacker could do with it. You will get an acknowledgement, and we will keep you updated until a fix is released and credit you if you wish.

## Supported versions

UNIORA is `0.x`: only the latest minor version receives security fixes.

## What is in scope

Authorization bypasses (`can`, `access.check`, the Express and Next guards), privilege escalation (Owner protection, invitations, role assignment), cross-organization access, audit-log tampering that the chain should detect, token or secret handling (invitation tokens, Studio's launch token), and the supply chain of the published packages.

## Hardening your deployment

Some controls live outside the code: see [`guides/hardening.md`](guides/hardening.md).
