# Daily Diff

A daily five-letter coding word puzzle you play inside Claude Code. Everyone gets the same word each day and has six guesses. Streaks and a leaderboard keep score. It draws in the terminal and in the Code tab of Claude Desktop.

Run `/cg-daily-diff` and click the pane to start. Type a word and press Enter. Green means the right letter in the right place, yellow means the letter is in the word elsewhere, gray means it isn't there. A new puzzle starts at 00:00 UTC.

## Sign-in

Daily Diff needs a one-time GitHub sign-in, because the server keeps your guesses and streak and puts you on the leaderboard. The game shows a code, you enter it at github.com/login/device, and that's it. The sign-in asks for no permissions, so the server only learns your public username. The game stores a session key, never your GitHub token.

## What it sends over the network

Everything goes to one game server, the official one at https://games.jpoapps.com. The game only uses HTTPS.

- Sign-in: the game asks github.com for a code and polls until you approve it. The GitHub token goes to the game server once, which checks it with GitHub and replies with a session key.
- Playing: each guess you make, and requests for today's puzzle, your stats and the leaderboard.

The server stores your GitHub username, each day's guesses, when you started and finished, and whether you solved it. No word list or answers ship in this plugin. Full details are in the [privacy policy](../../PRIVACY.md).

## License

MIT
