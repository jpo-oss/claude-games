# claude-games

Multiplayer games that run inside Claude Code as mods. This repo is also the plugin marketplace: `.claude-plugin/marketplace.json` lists every game, and each game lives in `plugins/<name>/`.

The game server is a separate repo, `jpo-oss/claude-games-server`.

## Layout

- `plugins/<game>/`: one installable plugin per game. A plugin install copies only its own folder, so a game can't import code from outside it.
- `docs/specs/`: designs. Read the relevant one before changing a game.
- `docs/adr/`: short records of decisions that aren't obvious from the code.

## Working on a game

```sh
claude --plugin-dir plugins/<game>    # load it for one session, reloads on save
claude plugin validate .              # marketplace and every plugin
claude plugin test plugins/<game>     # the game's tests
```

The mods API types ship with Claude Code. Once a plugin has loaded, they're in `plugins/<game>/.claude-plugin/types/` (gitignored). Grep them instead of guessing.

Things that bite:

- Mods have no WebSocket. Network goes through `$.http.fetch` in the hooks module.
- `$.process` only works in the CLI. Anything that needs a local binary breaks on desktop.
- Draw games inside a `Client` with `Box` and `Text`. `Raster` is terminal-only and `Svg` is desktop-only.
- Test UI on both surfaces: loop over `['terminal', 'desktop']`.

## Adding a game

1. Create `plugins/<game>/` with `.claude-plugin/plugin.json`, `hooks/hooks.json` and the hooks module.
2. Add it to `.claude-plugin/marketplace.json`. The `name` there must match `plugin.json`.
3. Name its slash command `cg-<game>` (Block Battle is `/cg-block-battle`) so it can't clash with other plugins' commands.
4. Bump `version` in `plugin.json` on every release, or players won't get the update.

## Releasing

Players install from a pinned release, not from `main`. Merging to `main` ships nothing.

1. Bump `version` in the game's `plugin.json` in a normal PR and merge it.
2. Tag the merge commit `<game>-v<version>` (for example `block-battle-v0.2.0`) and push the tag.
3. Open a release PR that points the game's entry in `.claude-plugin/marketplace.json` at that tag and commit:

```json
{
  "name": "block-battle",
  "source": { "source": "git-subdir", "url": "jpo-oss/claude-games", "path": "plugins/block-battle", "ref": "block-battle-v0.2.0", "sha": "<full 40-character commit>" },
  "description": "..."
}
```

Until the first release, the entry is a relative path. The first release makes the switch.

## Rules

- No trademarked game names, logos or look-alike branding. Our Tetris-like game is Block Battle and the word "Tetris" doesn't appear anywhere.
- Never send a player's credentials anywhere except where they came from. Sign-in uses GitHub device flow with no scopes.
- Treat anything a `Client` posts as untrusted input and validate it in the hooks module.
- Writing: plain and short. No em dashes, no emojis. Comments only where the code can't explain itself.
- Commits follow Conventional Commits (`feat:`, `fix:`, `chore:`, ...).
