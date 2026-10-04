# Contributing

Thanks for helping. Bug fixes, new games and server improvements are all welcome.

## Before you start

For anything bigger than a small fix, open an issue first so we can agree on the approach. New games need a game proposal issue.

## Setup

You need Node (current LTS) and Claude Code.

```sh
git clone https://github.com/jpo-oss/claude-games
cd claude-games
claude --plugin-dir plugins/<game>
```

[AGENTS.md](AGENTS.md) covers layout, commands and the rules the code follows.

## Pull requests

- One change per PR. Keep it small enough to review in one sitting.
- Add or update tests. CI runs `claude plugin validate` and each game's tests, and must pass.
- Bump the game's `version` in `plugin.json` if players should get the change.
- Use Conventional Commit style for the PR title, e.g. `fix(block-battle): hold works after game over`.

## AI-assisted contributions

Using AI tools is fine. We use them too. The rules:

- Say so in the PR description.
- You are the author. You need to understand every line and be able to answer questions about it.
- Run it yourself before opening the PR.
- Large PRs that look unreviewed get closed without detailed feedback.
- Security reports need a working reproduction.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
