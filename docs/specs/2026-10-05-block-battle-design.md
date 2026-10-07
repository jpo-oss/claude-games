# Block Battle and claude-games: design

Status: draft, updated 2026-10-06 after a security review

## Goal

A set of small multiplayer games people play inside Claude Code while they wait on a long turn. The first one is Block Battle: falling-block puzzle with solo Marathon, 1v1 battles against strangers, and a leaderboard. It must work in the terminal and in the Code tab of Claude Desktop.

Block Battle is a port of an internal game we already run (jpo-tetris, built for the justpressone org). This project makes it public and open source.

## Decisions

| Topic | Decision |
|---|---|
| Distribution | Claude Code plugin marketplace on GitHub |
| Repos | `jpo-oss/claude-games` (games + marketplace), `jpo-oss/claude-games-server` (server) |
| License | MIT for both |
| First game | Block Battle, plugin name `block-battle`, command `/cg-block-battle` |
| Commands | Every game's slash command starts with `cg-` |
| Identity | GitHub device sign-in with no scopes, one OAuth app per server |
| Official server | Run by the maintainers from the public server code. Its hosting details aren't part of this repo |
| Self-hosting | Supported. Players pick a server in plugin settings |
| Transport | HTTP. The server holds sync requests open until there's news. Mods can't open WebSockets |
| Scores | Verified: the server replays every game before it counts |
| Releases | Players get pinned releases, not whatever is on `main` |

The word "Tetris" stays out of names, code, docs and visuals. The Tetris Company enforces its trademark and trade dress, and a takedown would also remove the marketplace.

## Platform constraints

These come from the mods docs and the type definitions shipped with Claude Code 2.1.289.

- Mods run in the Claude Code CLI and the Code tab of Claude Desktop. Not in regular Claude chat, Cowork, or claude.ai.
- The game runs in a `Client` surface module. It gets raw key events (arrows, letters, modifiers) once the player clicks it, has its own frame clock, and draws with `Box` and `Text`. `Client` works in both terminal and desktop. `Raster` is terminal-only and `Svg` is desktop-only, so we use neither.
- The only network access is `$.http.fetch` from the hooks module. No WebSocket, no streaming body. `$.process` is CLI-only, so nothing that needs a local binary (like the `gh` CLI) works on desktop.
- The `Client` talks to the hooks module with `post`, at most one message per frame. The hooks module answers with new props.
- Mods aren't sandboxed. They run with the user's permissions, which is one more reason the code has to be open and reviewed.

## claude-games repo

```
.claude-plugin/marketplace.json
plugins/
  block-battle/
    .claude-plugin/plugin.json
    hooks/hooks.json
    hooks/register.tsx     command, pane, sign-in, server calls, nudge
    hooks/game.tsx         Client module: input, frame loop, drawing
    hooks/engine.ts        pure game rules, seeded, no I/O
    hooks/draw.ts          board and UI drawing helpers
    hooks/net.ts           request building and response parsing
    hooks/log.ts           input log format, mirrors the server's protocol.ts
    types/index.d.ts
    tests/
docs/
  adr/
  specs/
AGENTS.md
CLAUDE.md                  just "@AGENTS.md"
```

A plugin install copies only its own folder, so games can't import from a shared package at runtime. If a second game needs the same code, we decide then whether to copy it or bundle it. Not before.

Players install with:

```
/plugin marketplace add jpo-oss/claude-games
/plugin install block-battle@claude-games
```

Third-party marketplaces don't auto-update by default. Players run `/plugin update block-battle@claude-games` or turn on auto-update for the marketplace. A release bumps `version` in the game's `plugin.json`.

## Block Battle

Everything the internal version has stays:

- Modern rules: 7-bag, hold, SRS kicks, T-spins, back-to-back, combos, lock delay with move reset.
- Marathon (solo), Battle (1v1 with garbage), and a leaderboard (top 5 Marathon scores, top 5 battle wins).
- A nudge when a Claude turn has run for 2 minutes. It waits while Claude is asking the player a question.

What changes:

- **Sign-in.** GitHub device flow, run entirely through `$.http.fetch`. The pane shows the code and `github.com/login/device`; the hooks module polls for the token. The OAuth app requests no scopes, so the token can only read the public profile. Device flow needs only the client ID, no secret ([GitHub docs](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)).
- **One OAuth app per server.** The game asks the chosen server for its client ID (`GET /v1/config`) and signs in against that app. If every server shared one app, a rogue server could replay a player's token at another server and sign in as them. With one app each, a server only accepts tokens issued to its own app (see Sign-in below). The official server uses the jpo-oss app; self-hosters register their own.
- **Server choice.** Picking Battle asks where to play: the official server, an address the player types, or the last address they typed. The leaderboard shows the server last played on and names it. Any server but the official one is labeled a community server, with a warning before first sign-in that it will learn the player's GitHub username. Each server has its own leaderboard. Only `https://` is accepted, plus `http://localhost` for development.
- **Distrust the server.** Everything a server sends is validated before use: attacks are whole numbers from 1 to 40; logins match GitHub's format (`^[A-Za-z0-9-]{1,39}$`); board snapshots are at most 400 characters from the piece alphabet; error text has control characters stripped and is capped at 120 characters and shown as the server's words, never as instructions. A request that takes longer than 30 s is abandoned. Room IDs are URL-encoded. A result the game doesn't recognise counts as no result, never as a win.
- **Sign out.** `/cg-block-battle signout` deletes the stored session and asks the server to revoke it.
- **Offline.** Marathon works without a server. Battle and leaderboard show that the server is unreachable.
- **Version check.** Every request sends the protocol version. The server answers 426 if it's too old, and the game tells the player to run `/plugin update`.
- **Removed.** The justpressone org check, the tetris.jpoapps.com server, the `gh` CLI dependency, and the nexus/jpo naming. The new default is `games.jpoapps.com`. JustPressOne must keep that domain registered: whoever owns it receives every default player's sign-in.

Battle sync uses held requests. The game sends its state and the server answers as soon as there's news for it (incoming garbage, the opponent's board changed, a result) or after 2 s of quiet. The game sends the next request straight away. That gives close to live-connection latency with far fewer requests than polling every 200 ms.

## claude-games-server repo

Node (current LTS) and TypeScript. One process.

- Matchmaking queue and live rooms are in memory. A restart drops matches in progress, which is acceptable because matches last a few minutes.
- Players, sessions, scores and wins live in one SQLite file.
- The game logic in the internal server (`logic.ts`: score validation, queue, room sync, attack rate caps) is already pure and ports over. Its platform-specific wiring gets replaced with plain HTTP handlers.

### Endpoints

All under `/v1`, JSON, `Authorization: Bearer <session>` except sign-in.

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/config` | This server's GitHub OAuth client ID and supported protocol versions |
| POST | `/v1/session` | Exchange a GitHub token for a session key |
| DELETE | `/v1/session` | Sign out: revoke the session key |
| POST | `/v1/marathon` | Start a Marathon game: returns a game ID and the piece seed |
| GET | `/v1/leaderboard` | Top 5 scores, top 5 wins, top 5 fastest wins per bot level |
| POST | `/v1/scores` | Submit a Marathon game's input log for replay |
| POST | `/v1/bot` | Start a ranked Vs Bot match: returns a game ID and the seed |
| POST | `/v1/bot/scores` | Submit a Vs Bot match's input log for replay |
| POST, DELETE | `/v1/battle/queue` | Join or leave matchmaking |
| POST | `/v1/battle/:room/sync` | Send attacks and board snapshot, get opponent state and incoming garbage |
| GET | `/health` | Uptime checks |

### Sign-in

`POST /v1/session` first checks the token with `POST https://api.github.com/applications/{client_id}/token`, authenticated with this server's client ID and secret. GitHub answers 404 for a token issued to any other app, so a token captured by another server is useless here. Then it reads the login with `GET /user`, stores the login and the GitHub account's age, and returns a session key.

- Session keys are 32 random bytes, stored hashed, expire after 30 days without use, and can be revoked.
- The server never stores or logs the GitHub token, and never logs request bodies on `/v1/session`.
- Every route except `/health`, `/v1/config` and `POST /v1/session` requires a valid session.

### Refereeing

The server picks the shared piece seed, relays attacks between players, caps attack rate (burst 15, 2.5 lines/s), and decides the winner on top-out or a 10 s forfeit.

### Verified scores

The engine is deterministic: the same seed and the same inputs at the same times always give the same game. The server uses that to check every result before it counts.

- **Marathon.** The game asks `POST /v1/marathon` for a game ID and seed, so a player can't hunt for a lucky seed. One step is 16 ms. The game records every input as a step delta and a code (the compact delta form), and sends nothing while it plays. When the game ends or the player quits, it hands the finished log to the hooks module in chunks, each sent after the previous one is acknowledged, and the hooks module posts it to `POST /v1/scores`. The server replays the log with the engine and records the score the replay produces, not the score the client claims. A game is at most 2 hours (450,000 steps), a log body is capped at 1.5 MB, and a log longer than the time since the game started is rejected. If the server can't start a game, the game plays unranked. Examples: the player is signed out, already has 5 open games in 2 hours, or the server doesn't answer within 3 s. Quitting a ranked game submits it as played so far.
- **Battle.** Each client records its inputs and the step at which it applied each garbage batch, by the server's batch ID. After the result both players send their logs, and the winner's log decides. A win counts when the winner's log replays cleanly and matches what the server sent, and the loser either topped out or forfeited. The loser's log is checked only when it was sent after a top-out. Garbage must be applied within 2 s of delivery, and the log length must match the match length within 5 s, each timed from the winner's own matched reply. The attacks the winner's replay produces must cover what the server relayed.
- **Win farming.** Matches under 60 s don't count. Repeat wins over the same opponent on one UTC day don't count. GitHub accounts younger than 30 days can play but don't appear on the leaderboard.
- **Engine sharing.** The server needs the exact engine the game runs. The games repo owns `engine.ts`; the server repo keeps a copy and its CI fails if the copy differs from the game's released version. A game release that changes the rules needs a protocol version bump, so old clients get 426 instead of failed replays.

This stops fabricated scores and fake wins. It doesn't stop a bot that plays well; nothing short of watching the player does.

### Abuse limits

- Per-session and per-IP request rate limits.
- Request body size cap, and schema validation on every body.
- A max concurrent player count. Past it, new queue joins get `503` and the game shows "server busy".
- One held request per session, a global cap on held requests, and a 25 s hard limit on any hold, well under the 100 s many proxies allow.
- One queue entry per login.
- Request bodies capped at 4 KB, except score and battle logs (capped at 1.5 MB).
- Leaderboard names are GitHub logins, so there's nothing to filter.

### Protocol sharing

The server repo owns `protocol.ts`. The game mirrors only the log format and the input order in `hooks/log.ts`, and a test pins the order. The server's CI checks its copy of the engine.

## Hosting

The server repo ships everything needed to run a server: a container image published on each release and a `docker compose` file with the server and Caddy (automatic HTTPS). The official server and every self-hosted one use the same files. How the maintainers host the official server isn't documented here.

Any host running it should:

- Put a proxy or firewall in front if it can, and use encrypted connections end to end.
- Deploy only from tagged releases.
- Keep a daily encrypted copy of the SQLite file off the machine, and test restores.
- Log GitHub logins and nothing else personal.

## Open source setup

Both repos:

- `LICENSE` (MIT), `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant), `SECURITY.md` pointing to GitHub private vulnerability reporting.
- Issue templates (bug, game proposal) and a PR template.
- `AGENTS.md` with how to run, test and add a game, plus the naming rule. `CLAUDE.md` imports it.
- Committed: `docs/adr/`, `docs/specs/`, `.claude/settings.json`. Ignored: `.claude/settings.local.json`, `.planning/`, scratch notes.
- AI policy in CONTRIBUTING: AI help is fine, say so in the PR, you must understand what you submit, unreviewed bulk PRs get closed.
- GitHub Actions on every PR: lint, typecheck, tests. Games repo also runs `claude plugin validate` and `claude plugin test`. Server repo also builds the image.
- Dependabot weekly. Secret scanning with push protection.
- Branch protection on `main`: PR required, checks must pass, no force push.
- Required review: one approval from a code owner on any change. Repo admins can bypass while there is a single maintainer; the bypass is removed when a second maintainer joins.
- Pinned releases. The marketplace entry points at a git tag and commit, not at `main`. Merging to `main` ships nothing; a release is a separate PR that moves the pin. A mod runs with each player's full permissions, so this is the gate that matters most.
- Actions pinned by commit SHA (Dependabot keeps them current). Default workflow token is read-only.
- The jpo-oss org requires 2FA and has at most two owners.

## Testing

- Engine: the existing unit tests (rules, scoring, kicks, garbage) port as they are.
- Mod: `claude plugin test` for UI and net handling, looped over `terminal` and `desktop`.
- Server: unit tests for logic, HTTP tests for each endpoint, including auth failures and limits.
- Load test before launch to find the player cap for the chosen box and sync rate.

## Not in v1

Friend rooms by code, sound, more games, desktop `Svg` rendering, signed commits, OpenSSF Scorecard, changelog tooling.

## Owner tasks

- Create both repos in the `jpo-oss` org.
- Register the GitHub OAuth app with device flow enabled. The server needs its client secret too.
- Keep jpoapps.com registered.

## Risks

- "claude" in the repo names may conflict with Anthropic's brand guidelines. Not checked.
- Server capacity is an estimate until the load test.
- Mods are new. API changes in Claude Code could break the game, so CI should run against the latest release.
