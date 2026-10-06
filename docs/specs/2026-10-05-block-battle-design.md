# Block Battle and claude-games: design

Status: draft, 2026-10-05

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
| Identity | GitHub device sign-in with no scopes |
| Official server | One small Hetzner VPS |
| Self-hosting | Supported. Players pick a server in plugin settings |
| Transport | HTTP polling. Mods can't open WebSockets |

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
    hooks/protocol.ts      copy of the server's protocol types
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

- **Sign-in.** GitHub device flow, run entirely through `$.http.fetch`. The pane shows the code and `github.com/login/device`; the hooks module polls for the token. The OAuth app requests no scopes, so the token can only read the public profile. One OAuth app (owned by jpo-oss) serves every server, since servers only use the token to ask GitHub who the player is. Device flow needs only the client ID, no secret ([GitHub docs](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)).
- **Server choice.** `userConfig.serverUrl`, defaulting to the official server. Each server has its own leaderboard.
- **Offline.** Marathon works without a server. Battle and leaderboard show that the server is unreachable.
- **Version check.** Every request sends the protocol version. The server answers 426 if it's too old, and the game tells the player to run `/plugin update`.
- **Removed.** The justpressone org check, the jpoapps.com default, the `gh` CLI dependency, and the nexus/jpo naming.

Battle sync stays at 200 ms for now. On a flat-price box this is a capacity question, so we tune it after a load test.

## claude-games-server repo

Node (current LTS) and TypeScript. One process.

- Matchmaking queue and live rooms are in memory. A restart drops matches in progress, which is acceptable because matches last a few minutes.
- Players, sessions, scores and wins live in one SQLite file.
- The game logic in the internal server (`logic.ts`: score validation, queue, room sync, attack rate caps) is already pure and ports over. The Cloudflare Durable Object wiring gets replaced with plain HTTP handlers.

### Endpoints

All under `/v1`, JSON, `Authorization: Bearer <session>` except sign-in.

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/session` | Exchange a GitHub token for a session key |
| GET | `/v1/leaderboard` | Top 5 scores, top 5 wins |
| POST | `/v1/scores` | Submit a Marathon result |
| POST, DELETE | `/v1/battle/queue` | Join or leave matchmaking |
| POST | `/v1/battle/:room/sync` | Send attacks and board snapshot, get opponent state and incoming garbage |
| GET | `/health` | Uptime checks |

`POST /v1/session` calls `GET https://api.github.com/user` with the token, stores the login and avatar, and returns a random session key. The server never stores the GitHub token.

### Refereeing

Same model as the internal server. The server picks the shared piece seed, relays attacks between players, caps attack rate (burst 15, 2.5 lines/s), and decides the winner on top-out or a 10 s forfeit. Clients send attacks, not raw inputs. This stops lazy cheating, not a determined one, and that's fine for a casual game.

### Abuse limits

- Per-session and per-IP request rate limits.
- Request body size cap, and schema validation on every body.
- A max concurrent player count. Past it, new queue joins get `503` and the game shows "server busy".
- Leaderboard names are GitHub logins, so there's nothing to filter.

### Protocol sharing

The server repo owns `protocol.ts`. The games repo keeps a copy in each game. CI in the games repo fetches the server's file at the pinned version and fails if they differ.

## Hosting

Official server: one Hetzner VPS, behind Cloudflare's free proxy for TLS at the edge and junk traffic.

- Docker image published to GHCR on each server release.
- `docker compose` file with the server and Caddy (automatic HTTPS). Self-hosters use the same file.
- Release workflow deploys to the box over SSH. The key lives in GitHub Actions secrets.
- Daily copy of the SQLite file off the box.
- Logs keep GitHub logins and nothing else personal.

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

## Testing

- Engine: the existing unit tests (rules, scoring, kicks, garbage) port as they are.
- Mod: `claude plugin test` for UI and net handling, looped over `terminal` and `desktop`.
- Server: unit tests for logic, HTTP tests for each endpoint, including auth failures and limits.
- Load test before launch to find the player cap for the chosen box and sync rate.

## Not in v1

Friend rooms by code, sound, more games, desktop `Svg` rendering, signed commits, OpenSSF Scorecard, changelog tooling.

## Owner tasks

- Create both repos in the `jpo-oss` org.
- Rent the Hetzner box and pick a domain, proxied through Cloudflare.
- Register the GitHub OAuth app with device flow enabled.

## Risks

- "claude" in the repo names may conflict with Anthropic's brand guidelines. Not checked.
- Hetzner pricing and box capacity are estimates until the load test.
- Mods are new. API changes in Claude Code could break the game, so CI should run against the latest release.
