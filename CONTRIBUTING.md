# Contributing to OwnMemory

Thanks for helping. Bug reports, fixes, docs and ideas are all welcome.

## Before you start

- **Bugs and ideas:** open an issue first for anything larger than a small fix, so we can agree on the approach.
- **Security problems:** don't open an issue; see [SECURITY.md](SECURITY.md).

## Development

```sh
cd server
npm install
cp .dev.vars.example .dev.vars   # set OWNER_CODE
npm run dev                      # http://localhost:8788
npm test                         # unit tests
npm run typecheck
npm run eval                     # recall evaluation (uses Workers AI)
```

Ground rules the code depends on:

- **The server never stores or logs plain text, keys or passphrases.** Memories are encrypted before they reach storage; logs record error kinds only.
- **`server/public/keys.js` defines the on-disk format.** It runs unchanged in the browser, the Worker and the decrypt tool; any change needs a new format version.
- **Hard rules stay in code**, not just in instructions to the AI.

## Contributor license agreement

Before we can merge your first pull request, you agree to the [Contributor License Agreement](CLA.md). Add this line to your pull request description:

> I have read the OwnMemory CLA (CLA.md) and I agree to it for this and future contributions.

The CLA lets the project keep options open, such as offering the code under additional licenses later, while you keep the copyright to your work.
