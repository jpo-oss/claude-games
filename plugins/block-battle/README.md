# Block Battle

A falling-block puzzle you play inside Claude Code while it works on something long. Play solo Marathon, battle other players 1v1 online, and climb the leaderboard. It draws in the terminal and in the Code tab of Claude Desktop.

Run `/cg-block-battle` and click the pane to start. Left and right move, down drops faster, space drops all the way. Up or x rotates, z rotates the other way, a flips, c holds. p pauses Marathon, q goes back to the menu, Esc leaves the pane.

## What it sends over the network

Marathon works offline, and when you are not signed in it sends nothing. Everything else talks to one game server: the official one at https://games.jpoapps.com, or an address you type when you pick Battle. The game only uses HTTPS (plain HTTP only for a server on your own machine, for testing).

- Sign-in uses GitHub's device flow. The game asks the server for its GitHub app ID, then asks github.com for a code and polls github.com until you approve it. The approval requests no permissions. The resulting GitHub token goes to the game server once, which checks it with GitHub and replies with a session key and your public username. The game stores that session key, never the GitHub token.
- Signed in, the game sends the server: a request to start a ranked Marathon, your recorded moves at its end (so the server can replay them and check the score), matchmaking and battle updates (attacks and a snapshot of your board), the moves of a finished battle, and leaderboard requests.
- Signing out tells the server to delete the session.

The game stores, on your machine through Claude Code: the session key for each server you signed in to, and the last server address you typed. It sends a session key only to the server it came from.

The server code is open source at https://github.com/jpo-oss/claude-games-server. It stores your GitHub login, numeric ID and account creation date, scores and battle results, and never logs tokens, request bodies or IP addresses.

## What it watches in your session

The game adds one command, `/cg-block-battle`, and runs no other commands, tools or programs. It listens to three session events only to time one reminder: when you send a prompt and when Claude's turn ends, it can show a single toast after two minutes ("Long task. /cg-block-battle while you wait?"), and while Claude is asking you a question with AskUserQuestion it waits so the toast never covers the question. It passes each of these events on unchanged and never reads, stores or sends what you or Claude wrote.

## What else is in this folder

`tests/` holds the game's automated tests, run with `claude plugin test`. They never load in a player's session. They stand in for Claude Code's own events (network replies, stored data, tool calls and commands) so the game can be tested without a network or a real session; the game itself makes none of those calls beyond the ones listed above.

## License

MIT
