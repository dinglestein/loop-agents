# loop-agents

A Claude Code mod that shows how many workflow agents are running, and what they're doing, in a line above the prompt.

Claude Code's agents chip under the prompt counts only the agents a chat starts itself, so while a workflow runs its own agents (builders, reviewers, verifiers) the chip can read "0 agents" even though work is going on. This mod fills that gap:

```
Loop: 3 agents running (Review) · 47 done · verify: sign export in Safari · manager: team play   [Hide]
```

- **Running**: agents a workflow has started that haven't answered yet, with the phase of the newest one.
- **Done**: agents that have answered, across the workflows still active.
- The newest three agents' labels, cut to fit.
- **Hide** tucks the line away for the rest of the session.
- **A timeline for each running workflow** on the line's right, one row per workflow: a segment per phase, the finished ones filled, the current one filling as it goes, and its name, the phase it's on and the estimated time left (`daily-loop · Build 3/5 · ~1h 10m left`). In the VS Code extension, the desktop app and the mobile apps it's a small drawing; in the terminal it's a row of characters.

### How the time left is estimated

Each run that finishes leaves a record of when every agent in it started. From those records, a phase's usual length is the median of how long it took over that workflow's last 10 runs, across all your projects. A stopped run counts only for the phases it got past. The time left is what remains of the current phase plus the usual length of each phase still to come. It reads `≥` when a phase to come has never finished before, `running long` once the current phase has gone past its usual length, and how long the run has been going (`25m in`) for a workflow that has never finished.

It shows up by itself the moment a workflow starts in the chat (and comes back after Hide when the next one starts), updates every 5 seconds, and shows only while a workflow in the current session is active. An agent whose transcript hasn't changed in 10 minutes counts as gone, so a stopped workflow doesn't linger.

## How it works

Each workflow keeps a journal beside the session's transcript (`<session>/subagents/workflows/wf_*/journal.jsonl`), with one line when an agent starts and one when it answers. The mod reads what each journal gained since the last poll, the folder listing for when each agent last wrote, the first line of each agent's transcript for when it started, and the script the Workflow tool saved for the run, for its name and phases (`<session>/workflows/scripts/`). For the estimates it reads finished runs' records (`<projects>/*/*/workflows/wf_*.json`) when a session starts and every 15 minutes, each one once, and keeps each phase's length in the plugin's store. It writes nothing else to disk and sends nothing over the network.

## Install

At the prompt of a terminal session:

```
/plugin marketplace add dinglestein/loop-agents
/plugin install loop-agents@loop-agents
```

From a shell:

```
claude plugin marketplace add dinglestein/loop-agents
claude plugin install loop-agents@loop-agents
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `dinglestein/loop-agents`, then Add plugin.

Needs a Claude Code version with mods (hooks modules), 2.1.330 or later.

## License

MIT, see [LICENSE](LICENSE).
