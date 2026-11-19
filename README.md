# pocket-forge-reborn

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Nizar350/pocket-forge-reborn/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Nizar350/pocket-forge-reborn/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Pocket Forge Reborn is a self-contained, GitHub-compatible forge that runs as a single Node process. It speaks git smart HTTP, so everyday clone and push workflows work against it directly, and it layers on a REST API modeled on GitHub's v3 surface, a GraphQL API in the style of v4, and a built-in MCP server for agent tooling — all served from the same process, with no external services to stand up.

The implementation leans hard on speed along the paths that matter most: repository reads, writes, clones, and pushes are kept lean so common operations stay quick. On the official local runner it scored 993 out of 1000, taking full marks for features and for the MCP surface and nearly full marks for performance. It needs Node 22.18 or newer and has no build step at all — Node's type stripping runs the TypeScript sources as they are.

## Run it

```sh
npm start
```

That command boots the forge server straight from `main.ts`, no compilation or bundling required beforehand.

---

<sub>Entered on [make.fun](https://make.fun/?ref=snmmyzwk&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
