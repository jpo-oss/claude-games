# claude-games

Games to play inside [Claude Code](https://code.claude.com) while it works on something long. Real-time, online, against other people.

They run as Claude Code mods, in the terminal and in the Code tab of Claude Desktop.

## Install

```
/plugin marketplace add jpo-os/claude-games
/plugin install <game>@claude-games
```

Updates aren't automatic for community marketplaces. Run `/plugin update <game>@claude-games`, or turn on auto-update for this marketplace under `/plugin` > Marketplaces.

## Games

Coming soon: Block Battle, a falling-block puzzle with solo Marathon and 1v1 battles.

## Servers

Online play goes through [claude-games-server](https://github.com/jpo-os/claude-games-server). Each game defaults to the official server, and you can point it at your own in the plugin's settings. Every server keeps its own leaderboard, so a team can run one for itself.

## A note on trust

Mods aren't sandboxed. They run with your permissions, like any plugin. Read the code before you install, which is part of why this is open source.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues go through [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
