# Vs Bot: design

## Goal

A solo mode where you play a 1v1 battle against a bot that runs on your own machine. It needs no network to play. Three levels, each with its own ranking of fastest wins, checked by the server the same way Marathon scores are.

## What the player sees

The menu is Marathon, Vs Bot, Battle, Leaderboard. Vs Bot opens a level picker:

| Shown name | Level id |
|---|---|
| Merge Conflict (easy) | `easy` |
| Hotfix in Prod (medium) | `medium` |
| Deploy on Friday (hard) | `hard` |

Picking one starts the match at once. Your board is on the left and the bot's on the right, drawn like the opponent board in Battle. Line clears send garbage both ways with the battle rules the engine already has. The first board to top out loses. If both top out on the same step, the player loses.

On a win the overlay shows the win time. If you were signed in when the match started, the match is ranked. Otherwise it plays unranked and says "unranked" at the end, as Marathon does. q leaves the match. A ranked match you leave counts as a loss and is still sent, so open games don't pile up.

The Leaderboard screen gets a second page, switched with left and right: the top 5 fastest wins for each level, one column per level on wide panes and stacked on narrow ones.

## How the bot plays

The bot lives in `plugins/block-battle/hooks/bot.ts`, imported by the Client. It never touches the network.

Each time the bot gets a new piece it scores every reachable final placement (each rotation and column, dropped straight down) by the board it leaves: aggregate height, holes, bumpiness and lines cleared, with fixed weights. It then plays the moves for the best one at its own pace.

| | Pace | Considers | Mistakes | Top speed |
|---|---|---|---|---|
| easy | one input every 12 steps | current piece | 30% of pieces take a random placement from the top 5 | level 5 |
| medium | one input every 5 steps | current piece and hold | 5% of pieces take the second best | level 8 |
| hard | one input every 3 steps | current and next piece | none | level 10 |

The bot's board stops speeding up at its top speed. Without it the bot's own line clears pushed it to level 15, where pieces fall faster than it can steer them, and every level topped out by itself within a few minutes. The cap is applied in `match.ts` after each step, so the server's replay does the same. The player's board is never capped.

The bot also spreads its search over steps, 64 placements a step.

A step is the engine's fixed 16 ms step, so easy places roughly one piece every 1.5 s and hard about 2.5 a second. These are the tuned values, kept as constants in `bot.ts`.

### Determinism

The server must reproduce every bot move, so the bot is a pure function of its inputs:

- Its random choices (mistakes) come from its own seeded generator, seeded from the match seed. No `Math.random`, no clock.
- It decides in game steps, never wall time. Its search is split into fixed chunks per step (a fixed number of placements scored per step), so heavy thinking on hard spreads over several steps and never stalls a tick.
- It reads only its own game state.

Both boards run in one step loop. For step `i`: apply the player's logged inputs and step the player's game; ask the bot for its inputs and step the bot's game; then hand each side's attack lines to the other with the engine's `receiveGarbage`. The player's log records only the player's inputs. Garbage the player receives is not logged, because the server recomputes it.

## Rankings and the server

The flow matches ranked Marathon.

1. Starting a ranked match: `POST /v1/bot` with `{ level }` returns `{ gameId, seed }`. It shares Marathon's limit of 5 open games per 2 hours. On any failure the match plays unranked.
2. At the end the game sends `POST /v1/bot/scores` with `{ gameId, log }`. `log` is the player's inputs in the existing compact form.
3. The server replays the whole match with the same step loop: the player's board from the log, the bot from its own copy of `bot.ts`. It records the winner and the step count. It applies Marathon's checks: not faster than real time (5 s slack), at most 450,000 steps, nothing logged after the match ended, one submission per game.
4. A win ranks by fewest steps. Each player's best win per level counts, top 5 per level, with the same 30-day account age rule as the other boards.

`GET /v1/leaderboard` and the score replies gain a `bot` field: `{ easy: Row[], medium: Row[], hard: Row[] }`, where a row is `{ login, ms, at }` and `ms` is steps times 16. Older games ignore the field. Game 0.3.0 capped the bot's speed, which changes replays, so it moved to protocol 3 and 0.2.0 games are told to update.

The server keeps a byte-identical copy of `bot.ts` next to its engine copy. `npm run check-engine` checks both against the game release in `ENGINE_REF`.

## Releases

Game 0.2.0 and server 1.1.0. The server ships first. A 0.2.0 game against a 1.0.0 server gets 404 from the new routes and falls back to unranked, which is safe but loses the rankings.

## Testing

- Bot unit tests: it never makes an illegal move, the same seed and level always produce the same moves, harder levels clear more lines and survive longer against the same garbage, and the per-step cost on hard stays under a few milliseconds.
- Replay test: a match recorded by the Client replays on the server code to the same winner and step count.
- UI tests on both surfaces: menu order, the level picker, two boards side by side, the win overlay, unranked and ranked flows, and the new leaderboard page.
- Server tests for the routes, the checks and the leaderboard field.
- An end-to-end run against a local server, and one ranked match on the live server.

## Not in this version

Unlockable levels, custom bot speeds, and bots inside online battles.
