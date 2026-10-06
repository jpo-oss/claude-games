# claude-games

Games to play inside [Claude Code](https://code.claude.com) while it works on something long. Real-time, online, against other people.

They run as Claude Code mods, in the terminal and in the Code tab of Claude Desktop.

## Install

```
/plugin marketplace add jpo-oss/claude-games
/plugin install <game>@claude-games
```

Updates aren't automatic for community marketplaces. Run `/plugin update <game>@claude-games`, or turn on auto-update for this marketplace under `/plugin` > Marketplaces.

## Games

### Block Battle

A falling-block puzzle. Play solo Marathon, battle other players 1v1, and climb the leaderboard.

```
/plugin install block-battle@claude-games
```

Run `/cg-block-battle` and click the pane to start. Left and right move, down drops faster, space drops all the way. Up or x rotates, z rotates the other way, a flips, c holds. p pauses Marathon, q goes back to the menu.

Battles and the leaderboard need a one-time GitHub sign-in. It asks for no permissions, so the server only learns your public username.

## Servers

Online play goes through [claude-games-server](https://github.com/jpo-oss/claude-games-server). Each game defaults to the official server, and you can point it at your own in the plugin's settings. Every server keeps its own leaderboard, so a team can run one for itself.

## A note on trust

Mods aren't sandboxed. They run with your permissions, like any plugin. Read the code before you install, which is part of why this is open source.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues go through [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
