# Ask Inbox

[English](README.md) ｜ [한국어](README.ko.md)

`cdragon.ask-inbox` is a herdr plugin that collects every pending `AskUserQuestion` from Claude agents — across all of herdr — into one FIFO popup you can answer right where you are. The chosen answer is delivered only to the agent that asked, and nothing is ever auto-approved.

![Ask Inbox popup answering a Claude question from another workspace](docs/popup-question.png)

Questions stalled across different workspaces all land in a single queue. The `1/2` in the header means you're looking at the first of two pending questions; picking an answer immediately brings up the next one in the same spot. No more hunting through panes to find who's waiting on you.

## How it works

When an agent calls `AskUserQuestion`, a PreToolUse hook enqueues the request and **opens the popup directly.** Picking an answer in the popup returns the exact answer to the original agent through the hook response.

The key idea: **it only waits while the popup is alive.** If the popup fails to open (e.g. the plugin is disabled) or gets closed mid-way, the hook returns no decision within a few seconds and exits, sending the agent back to its **native question UI.** This plugin can never cause a question to hang indefinitely.

## Support scope

| Agent | What it waits on | How it's handled |
| --- | --- | --- |
| Claude | `AskUserQuestion` | The popup shows the original question and options, then returns the exact answer via the hook response |

Claude permission requests (`PermissionRequest`) and Codex are out of scope for this version. Permission approval is left to the native UI to eliminate any risk of misdelivery. Every uncertain case — no popup, popup closed, or an error — falls back to the original agent's UI.

## Installation

Requires Node.js 22+ and herdr 0.7.5+.

```bash
herdr plugin install speardragon/herdr-ask-inbox --yes
```

To develop or modify it locally, clone the repo and install it as a local link.

```bash
git clone https://github.com/speardragon/herdr-ask-inbox.git
herdr plugin link ./herdr-ask-inbox --enabled
```

The build step of install/link checks the Node version and runs the full test suite, then **automatically installs or repairs** the Claude hook. Before touching an existing config file, it writes a timestamped `.ask-inbox.bak` backup in the same directory, and it leaves any hook it doesn't own untouched. Only one hook is installed: `AskUserQuestion`.

Check the install status with:

```bash
herdr plugin action invoke hook-status --plugin cdragon.ask-inbox
```

To open the pending queue manually, run:

```bash
herdr plugin action invoke open --plugin cdragon.ask-inbox
```

## Popup controls

- `↑`/`↓`, number keys, `Space`, `Enter`: select an item and deliver the answer. Supports multiple questions, multi-select, and free-text (Custom) answers.
- `g`: decline to answer. Closes the popup and focuses the original agent's pane so you can continue in its native UI.
- `Esc`: decline to answer and just close the popup. The agent still falls back to its native UI, but focus doesn't move — you stay on whatever you were looking at.

For multi-select questions, toggle items on and off with `Space`, then send them all at once with `Enter`. The description of the currently highlighted option is always shown just below the cursor.

![Popup with two options toggled on via Space in a multi-select question](docs/popup-multi-select.png)

If none of the options fit, pick the last `Custom answer…` entry, press `Enter`, and type your own. Whatever you type becomes the agent's answer verbatim.

![Popup mid-typing a free-text answer in the Custom answer field](docs/popup-custom-answer.png)

Only one popup is ever open across the whole herdr instance, and requests are processed in the order they were created.

## Diagnostics & recovery

The queue lives under the plugin's config directory. Find the actual path with:

```bash
herdr plugin config-dir cdragon.ask-inbox
```

If pending requests or the popup aren't behaving as expected, first check `hook-status` for `installed`/`missing`/`duplicate`/`changed`. `changed` may mean a user-modified owned hook, so don't let it be overwritten automatically — review the backup and the config contents, then re-run `install-hooks`.

```bash
herdr plugin action invoke install-hooks --plugin cdragon.ask-inbox
```

If the plugin is `disabled`, the launcher exits immediately and the hook fails open to the native UI, so questions never hang even while the plugin is off.

## Safe removal

Remove the plugin in this order:

```bash
herdr plugin action invoke uninstall-hooks --plugin cdragon.ask-inbox
herdr plugin action invoke hook-status --plugin cdragon.ask-inbox
herdr plugin unlink cdragon.ask-inbox
```

`uninstall-hooks` only removes plugin-owned hooks that match exactly. Any changed or duplicate marker hook is preserved and reported in the status instead, in which case a human needs to review the config and the `.ask-inbox.bak` file and clean it up manually.
