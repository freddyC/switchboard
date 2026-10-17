# Switchboard

A Claude Code side pane that lists your other local Claude sessions: status dot, title, context meter, repos, tickets and PR. Click a session to jump to it, or open a new terminal or browser from the buttons at the top.

A 🔔 beside a session means it finished (went from busy to idle) and you haven't been back since. Jumping to it from the pane clears the bell, and so does the session going busy again because you typed in it.

## Requirements

- macOS: jumping to a session and **＋ New terminal** drive Terminal.app through AppleScript, so they only work for sessions running in Terminal.app; the first press asks for permission to control Terminal.
- **＋ New browser** opens the page in [Ghostty](https://ghostty.org) with `terminal-browser` when both are installed, and in your default browser otherwise.
- Windows: **＋ New terminal** opens a [Windows Terminal](https://aka.ms/terminal) tab running `claude`, and **＋ New browser** and links use your default browser. The chime plays through .NET's `SoundPlayer`. Jumping to a session finds its tab by title through UI Automation (Windows Terminal titles each tab after the session) and brings that window forward.
- The session list, status, context meter, chime and settings work in any terminal.

## Install

```
/plugin marketplace add freddyC/switchboard
/plugin install switchboard@switchboard
```

Run `/switchboard` to reopen the pane if you close it.

## Configure

Press **🔔** (or `m`) to mute or unmute the chime. Press **⚙ Configure** (or `c`) at the top of the pane to change settings in place; press it again to go back. The same settings are in `/config` under Switchboard.

| Setting | Default |
| --- | --- |
| Chime when a session finishes (busy → idle) | on |
| Sound: chime, bell, marimba or pop (pick one to hear it) | chime |
| Context meter, repos, tickets, pull request | all on |
| Name sessions after their `workroom-*` folder | on |
| Ticket URL prefix, e.g. `https://yourcompany.atlassian.net/browse/` | empty: ticket IDs show without links |
| Browser home page | `https://github.com/pulls/review-requested` |
| Name length | 48 |
| Refresh every (seconds) | 5 |

## Example config

[`examples/settings.json`](examples/settings.json) sets every option. Copy its `pluginConfigs` block into `~/.claude/settings.json` and change what you want. The pane reloads with the new values the next time a session starts or you run `/reload-plugins`. Leave out any option to keep its default.

The pane's buttons and keys:

| Do this | To |
| --- | --- |
| Click a session, or press its number (1–9) | Jump to that session's Terminal tab |
| **＋ New terminal** or `n` | Open a new Terminal tab |
| **＋ New browser** or `b` | Open the browser home page |
| **🔔** or `m` | Mute or unmute the chime |
| **⚙ Configure** or `c` | Change settings in the pane; press again to go back |
| A PR chip, or a ticket chip when Ticket URL prefix is set | Open it in your browser |

## License

MIT. See [LICENSE](LICENSE).
