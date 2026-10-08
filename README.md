# claude-kodar

The kodar mod for [Claude Code](https://code.claude.com/docs/en/plugins/mods/overview). It reports what each Claude Code session is doing to a kodar hub, so one dashboard shows every session across machines and accounts: which are working, which have finished a turn and wait for a prompt, and which are blocked on you. It also adds `/kodar`, which lists them from inside Claude Code.

It needs a kodar hub to report to. The hub isn't part of this repository.

## Install

The mod needs Claude Code 2.1.287 or later.

```bash
claude plugin marketplace add kodar-se/claude-kodar
claude plugin install kodar@kodar
```

The install asks for the settings below; change them later with `/plugin configure kodar@kodar`. A hub's bootstrap link does all of this for you, and turns on auto-update.

| Setting | |
| --- | --- |
| Hub URL | where your hub runs. Empty keeps the machine from reporting |
| Ingest token | a token your hub takes, kept out of settings.json: in the OS keychain, or on Linux in `.credentials.json` in the config folder |
| Device name | how this machine is labelled; empty uses the hostname. A `KODAR_DEVICE_NAME` environment variable wins over it |
| Account label | e.g. `personal`, `work`; empty uses the `CLAUDE_CONFIG_DIR` folder name, or `default` |
| Accounts | labels for your Claude logins, e.g. `you@home.example=personal, you@work.example=work`. A session then reports its login's label, and follows a `/login` to another account |
| Detail | `summary` (default), `full` or `minimal`; see below |

Run `/kodar` in a new session to check: its last line says where the session reports and whether the last send got through.

## Updates

Claude Code keeps a machine on the installed version until a new one is published here. To fetch it by itself, turn on auto-update once in `/plugin`: Marketplaces, kodar, Enable auto-update. To update by hand:

```bash
claude plugin marketplace update kodar && claude plugin update kodar@kodar
```

## What leaves the machine

Only what goes to the hub you configure, and only once both the Hub URL and the token are set.

Every report carries the session's id, the device and account labels, its working directory, the repository (`host/owner/name`, never the remote's credentials), branch, model, Claude Code version, the mod's version and whether it auto-updates, state, context use and cost. On top of that, by **Detail**:

- `summary`: the first 160 characters of each prompt, final answer, question and permission request, and tool targets (file paths, command descriptions, search patterns)
- `full`: the same, up to 2000 characters
- `minimal`: none of it, only tool names

With **Accounts** set, the mod also asks Anthropic which account the session is logged in to. Claude Code makes that request with the session's own login, which the mod never sees. The mod compares the email with the list on the machine and sends only the label.

A headless session (`claude -p`) isn't reported until it gets a prompt.

The mod only observes: it never blocks or changes a tool call, a prompt or a permission decision, and no hook waits on the network.

## Source

This repository is published from a private one, one commit per release, so changes made here directly are overwritten by the next release.

## License

[MIT](LICENSE)
