# Switchboard

A Claude Code side pane that lists your other local Claude sessions: status dot, title, context meter, repos, tickets and PR. Click a session to jump to it, or open a new terminal or browser from the buttons at the top.

## Install

```
/plugin marketplace add freddyC/switchboard
/plugin install switchboard@switchboard
```

Run `/switchboard` to reopen the pane if you close it.

## Configure

Ticket IDs found in a session (like `ABC-123`) show under it. To make them links, set the ticket URL prefix in `/config` (Switchboard → Ticket URL prefix), e.g. `https://yourcompany.atlassian.net/browse/`. Left empty, they show as plain text.
