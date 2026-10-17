# Security policy

OwnMemory holds people's private memories, so security reports get priority.

## Reporting a problem

Please report vulnerabilities privately, not in a public issue:

- GitHub: **Security → Report a vulnerability** on this repository, or
- Email: **security@ownmemory.app**

Include what you found, how to reproduce it, and what an attacker could do with it. We'll acknowledge within a few days and keep you updated until it's fixed. Please give us a reasonable time to release a fix before disclosing publicly.

## What matters most

- Anything that lets someone read memories, the memory key, a passphrase or a Google token
- Bypassing the owner code, the email allowlist or the OAuth flow
- Anything that makes the server store or log memory contents

## Updates

Deployed copies don't update themselves. Security fixes are announced in this repository's releases; update your copy by syncing it with this repository and redeploying.
