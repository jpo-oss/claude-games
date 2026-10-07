# claude-games

Games to play inside [Claude Code](https://code.claude.com) while it works on something long. Real-time, online, against other people.

They run as Claude Code mods, in the terminal and in the Code tab of Claude Desktop.

## Install

You need Claude Code 2.1.291 or later. Games work in the terminal and in the Code tab of Claude Desktop, in local sessions (not cloud ones).

In a Claude Code session:

```
/plugin install block-battle --marketplace jpo-oss/claude-games
```

Claude Code shows what the game adds and asks where to install it. Pick "Install for you" to have it in every project.

If you'd rather add the marketplace once and pick games from it:

```
/plugin marketplace add jpo-oss/claude-games
/plugin install block-battle@claude-games
```

In the desktop app you can also click **+** next to the prompt box, then **Plugins**, then **Add plugin**, once the marketplace is added.

### Updates

Auto-update is off by default for this marketplace. Turn it on with `/plugin`, **Marketplaces**, claude-games, **Enable auto-update**. Or update by hand:

```
claude plugin update block-battle@claude-games
```

If a game says it's out of date, the server has moved on and you need the update to keep playing online.

### Uninstalling

```
claude plugin uninstall block-battle@claude-games
```

## Games

### Block Battle

A falling-block puzzle. Play solo Marathon, battle other players 1v1, and climb the leaderboard.

Run `/cg-block-battle` and click the pane to start. Left and right move, down drops faster, space drops all the way. Up or x rotates, z rotates the other way, a flips, c holds. p pauses Marathon, q goes back to the menu, Esc leaves the pane.

Marathon works offline. Battles and the leaderboard need a one-time GitHub sign-in: the game shows a code, you enter it at github.com/login/device, and that's it. The sign-in asks for no permissions, so the server only learns your public username. The game keeps a key for that server and never stores your GitHub token.

To sign out of the server you're on:

```
/cg-block-battle signout
```

## Choosing a server

When you pick Battle, the game asks where to play: the official server, or a server address you type in. It remembers the last address you typed. Servers other than the official one are run by someone else, and the game says so before you sign in to one.

Each server has its own players and leaderboard. Signing in to one server doesn't sign you in to another, and your sign-in for one is never sent to another.

Want to run your own? See [claude-games-server](https://github.com/jpo-oss/claude-games-server).

## A note on trust

Mods aren't sandboxed. They run with your permissions, like any plugin. Read the code before you install, which is part of why this is open source.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues go through [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
