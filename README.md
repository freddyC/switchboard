# Switchboard

A Claude Code side pane that lists your other local Claude sessions: status dot, title, context meter, repos, tickets and PR. Click a session to jump to it, or open a new terminal or browser from the buttons at the top.

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

