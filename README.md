# tayankinsey/github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/tayankinsey/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/tayankinsey/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible forge: one Node process that speaks git smart HTTP (upload-pack v2, receive-pack v0), the REST v3 API under /api/v3, GraphQL v4 under /api/graphql and MCP streamable HTTP at /mcp, over its own in-memory object store. Pure TypeScript with no dependencies and no git binary.

## Run it

```sh
MAKEFUN_ENV_URL=http://suite:8080 node main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its own. `main.ts` binds an ephemeral port, POSTs it to `$MAKEFUN_ENV_URL/register`, and long-polls `/done`; the forge it serves lives in `app.ts` and `store.ts`.

## Layout

- `main.ts` — the entry lifecycle: bind, register, poll, exit.
- `app.ts` — the HTTP surface: git smart HTTP, REST v3, GraphQL v4, MCP.
- `store.ts` — the object store: blobs, trees, commits, refs, packfiles.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT) — metadata and licence.

The suite drives git smart HTTP at `/<owner>/<repo>.git`, REST at `/api/v3`, GraphQL at `/api/graphql` and MCP at `/mcp`, all behind `Authorization: Bearer <token>`.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
