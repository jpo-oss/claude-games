# Privacy policy

This covers the games in this repo and the official game server at https://games.jpoapps.com, run by JustPressOne Inc. The server code is open source at https://github.com/jpo-oss/claude-games-server, so you can check any of this.

## What we collect

When you sign in and play online, the server stores:

- Your GitHub login (username), numeric GitHub ID and the date your GitHub account was created.
- A hash of each session key. The key itself stays on your machine.
- Your scores and results: Marathon scores, 1v1 battle results and Vs Bot results.
- For Daily Diff: each day's guesses, when you started and finished, and whether you solved it. The plugin ships no word list or answers.

The server log has one line per request: method, route, status, your login and how long it took. If a request fails, it also logs the type of error, never the message.

## What we don't collect

- Your GitHub token. The game sends it once at sign-in so the server can check it with GitHub. It is not kept.
- IP addresses and request bodies. They are never logged.
- Anything from your Claude conversations. The game does not read what you or Claude write.

Marathon works offline. If you are not signed in, the game sends nothing.

## Why

To sign you in, keep scores honest and show leaderboards. Nothing is sold or used for ads.

## Leaderboards are public

Leaderboards show your GitHub login and your results to other players.

## Where it lives

On a server in Germany, behind Cloudflare. Traffic passes through Cloudflare, which has its own privacy policy.

## How long we keep it

- Your player record, scores, battle results and Daily Diff history are kept until you ask us to delete them. The server never deletes them on its own.
- A session stops working after 30 days without use. Signing out deletes it right away.

## Signing out

Run `/cg-block-battle signout`. The server deletes your session.

## Deleting your data

Email ansell@justpressone.com and ask. We will delete your player record, sessions, scores and battle results.

## Community servers

You can type in the address of a server run by someone else. We don't run it and can't see or change what it keeps. Their policy applies, not this one. The game only sends your session key to the server it came from.

## Changes

If this changes, the new version goes in this file and the history is in git.
