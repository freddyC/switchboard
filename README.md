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
