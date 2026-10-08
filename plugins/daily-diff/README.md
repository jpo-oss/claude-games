# Daily Diff

A daily five-letter coding word puzzle you play inside Claude Code. Everyone gets the same word each day and has six guesses. Streaks and a leaderboard keep score. It draws in the terminal and in the Code tab of Claude Desktop.

Run `/cg-daily-diff` and click the pane to start. Type a word and press Enter. Green means the right letter in the right place, yellow means the letter is in the word elsewhere, gray means it isn't there. A new puzzle starts at 00:00 UTC.

## Sign-in

Daily Diff needs a one-time GitHub sign-in, because the server keeps your guesses and streak and puts you on the leaderboard. The game shows a code, you enter it at github.com/login/device, and that's it. The sign-in asks for no permissions, so the server only learns your public username. The game stores a session key, never your GitHub token.

## What it sends over the network

The game contacts two hosts, both over HTTPS: github.com for sign-in, and the official game server at https://games.jpoapps.com for everything else.

- Sign-in: the game asks github.com for a code and polls until you approve it. The GitHub token goes to the game server once, which checks it with GitHub and replies with a session key.
- Playing: each guess you make, and requests for today's puzzle, your stats and the leaderboard.

The game stores one thing on your machine through Claude Code: the session key for the game server. It sends that key only to the game server, never anywhere else, and it never stores your GitHub token.

The server stores your GitHub username, each day's guesses, when you started and finished, and whether you solved it. No word list or answers ship in this plugin. Full details are in the [privacy policy](../../PRIVACY.md).

## What it does in your session

The game adds one command, `/cg-daily-diff`, and runs no other commands, tools or programs. Its hooks only handle that command (opening the pane, or signing out with `signout`), draw the pane, take keys typed into the pane, and forget the in-progress state when the pane closes. It never reads, stores or sends anything you or Claude write in the session. Share copies a grid of squares to your clipboard only when you press s.

## What else is in this folder

`tests/` holds the game's automated tests, run with `claude plugin test`. They never load in a player's session. They stand in for Claude Code's own events (network replies, stored data and commands) so the game can be tested without a network or a real session; the game itself makes no calls beyond the ones listed above.

## License

MIT
