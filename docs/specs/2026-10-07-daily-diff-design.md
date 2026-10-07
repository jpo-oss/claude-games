# Daily Diff: design

## Goal

A daily word puzzle. Everyone gets the same five-letter coding word each day and has six guesses to find it. Results go on a leaderboard. There is no multiplayer and no practice mode: one puzzle a day, played once.

Daily Diff is its own plugin, `plugins/daily-diff/`, started with `/cg-daily-diff`. It uses the Block Battle server at games.jpoapps.com.

## Rules

- The answer is a five-letter coding word. Any real five-letter English word is a valid guess.
- A guess that isn't in the word list is rejected and doesn't use up a guess.
- Each letter of a guess is marked green (right letter, right spot), yellow (in the word, wrong spot) or gray (not in the word), with the same colors as the original game.
- Repeated letters: greens are marked first, then yellows from left to right, but only as many yellows as that letter has left in the answer. A guess of `aabbb` against `xaxax` marks the first `a` yellow and the second green.
- A new puzzle starts at 00:00 UTC for everyone. A game not finished by then counts as failed. This stops anyone from opening a puzzle, waiting for the answer to spread, and finishing it later.
- One try per player per day, enforced by the server.
- Playing needs GitHub sign-in, the same device flow with no scopes that Block Battle uses.

## What the player sees

1. `/cg-daily-diff` opens a pane. Not signed in: the sign-in screen. Signed in: today's puzzle.
2. A 6 by 5 grid of tiles, an on-screen keyboard below it whose keys take the color of the best mark that letter has had, and a puzzle number and countdown to the next puzzle in the header.
3. Letters type into the current row, Backspace deletes, Enter sends. While the server answers, the row shows as pending. A rejected word flashes the row with "Not in word list".
4. When the game ends: the answer, your stats, the Share button, the top 20 for today with tabs for this week, this month and all time, and the countdown.
5. Closing and reopening the pane mid-game brings back the guesses so far. The timer keeps running from the first open.

Drawn with `Box` and `Text` inside a `Client`, tested on terminal and desktop.

### Share

Share copies this to the clipboard with `$.ui.copy`:

```
Daily Diff #112  4/6

□▒□□□
▒■□■□
□■■■▒
■■■■■

/plugin install daily-diff@claude-games
```

`■` is green, `▒` yellow, `□` gray. A failed game shows `X/6`. These are plain Unicode squares, not emoji. Copy works on terminal and desktop but not from a remote session, so the button says "Copy failed" if `copy` reports it didn't take.

### Stats

Games played, win percentage, current streak, best streak, and a bar for each guess count from 1 to 6 showing how many wins took that many. The current streak is the number of days in a row solved, ending today or yesterday. A fail or a missed day resets it.

## Scoring and leaderboard

A solved game scores 7 minus the number of guesses: 6 points for one guess down to 1 for six. A fail scores 0. Time is from the first open to the last guess, measured by the server.

| Board | Covers | Ranked by |
|---|---|---|
| Today | Today's puzzle | Fewest guesses, then shortest time |
| This week | Monday to Sunday, UTC | Most points, then lowest total time |
| This month | The calendar month, UTC | Most points, then lowest total time |
| All time | Every game | Most points, then lowest total time |

Each board shows the top 20: rank, GitHub login, points (guesses on Today), games played. If you aren't in the top 20, one more line shows your own rank. Only finished games count. GitHub accounts younger than 30 days play normally and keep stats but don't appear on the boards, the same rule as Block Battle.

## Keeping the answers secret

Both repos are public, so no word list is committed anywhere, not even as test fixtures.

- The server reads two files from the directory in `DAILY_DIFF_WORDS_DIR`: `answers.txt` (the coding words) and `guesses.txt` (every allowed guess). One lowercase five-letter word per line. Every answer also counts as a valid guess.
- On the live server these files exist only on the box. The owner keeps a copy outside git. Self-hosters bring their own.
- If the files are missing, the Daily Diff routes answer 503 and Block Battle carries on.
- The first request on a new UTC day picks a random answer that hasn't been used before and stores it in the database as that day's puzzle. After that the database is the source of truth, so editing `answers.txt` later never changes a past or current day. When every answer has been used, the server reuses the least recently used one.
- The answer is only sent to a player after their game for that day is finished.
- Tests build tiny word files on the fly from made-up strings.

## Server

Routes, all needing a signed-in session:

| Route | Does |
|---|---|
| `GET /v1/daily-diff/today` | Starts today's game if needed and returns `{ number, day, endsAt, guesses: [{ word, marks }], state, answer? }`. `state` is `playing`, `won` or `lost`. `marks` is five characters from `g`, `y`, `x`. |
| `POST /v1/daily-diff/guess` | Body `{ number, word }`. Returns the marks and the new state, plus the answer once the game ends. 422 for a word not in the list, 409 if `number` isn't today's puzzle or the game is over. |
| `GET /v1/daily-diff/leaderboard?period=today\|week\|month\|all` | `{ rows: [{ rank, login, points, played, ms }], you? }`. For `today`, `points` is replaced by `guesses`. |
| `GET /v1/daily-diff/stats` | `{ played, won, streak, bestStreak, distribution: [n1..n6] }` |

The guess route has its own rate limit so the word list can't be scraped by sending every word.

### Protocol version per game

Today the server checks one `x-protocol-version` for every route, so each Block Battle protocol bump would lock out Daily Diff players for no reason. Each route will name its game, and the check compares against that game's version: Block Battle stays on 3, Daily Diff starts at 1. Block Battle clients see no change. `GET /v1/config` reports both versions.

### Database

Two new tables, created at startup like the rest. Existing tables don't change.

`daily_diff_puzzles`

| Column | Type | Null | Notes |
|---|---|---|---|
| `day` | TEXT | no | Primary key, UTC date `YYYY-MM-DD` |
| `number` | INTEGER | no | Unique, the puzzle number in shares, from 1 |
| `word` | TEXT | no | The answer |

`daily_diff_games`

| Column | Type | Null | Notes |
|---|---|---|---|
| `login` | TEXT | no | References `players(login)`, cascades like the other tables |
| `day` | TEXT | no | References `daily_diff_puzzles(day)` |
| `guesses` | TEXT | no | JSON array of guessed words, `[]` at first |
| `started_at` | INTEGER | no | Milliseconds, first open |
| `finished_at` | INTEGER | yes | Null while playing |
| `solved` | INTEGER | yes | 1 or 0, null while playing |

Primary key `(login, day)`, which is what enforces one game per player per day. An index on `(day, finished_at)` serves the boards. A game still open when its day ends is closed as failed the next time anything reads it.

## Releases

1. Server first: the routes, the per-game protocol check and the tables, as a new minor version. Deploy with the word files in place.
2. Game `daily-diff` 0.1.0: tag `daily-diff-v0.1.0`, then a release PR adding it to `.claude-plugin/marketplace.json` pinned to that tag and commit.
3. Submission to the Anthropic plugin directory as its own step.

## Testing

- Marking: the repeated-letter cases, all green, all gray.
- Server: one game per day, the 00:00 UTC cutoff, rejected words not using a guess, the answer withheld until the game ends, answer picking without repeats, the 503 with no word files, the per-game protocol check, each board's ordering and ties, the 30-day rule, stats and streaks across missed days.
- UI on both surfaces: sign-in, typing and deleting, a rejected word, win and loss screens, reopening mid-game, the board tabs, Share.
- One live game on the real server after deploy.

## Not in this version

Hard mode, past puzzles, practice games and a colorblind palette.
