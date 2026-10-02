# Codex and DSH task workflow

Codex owns planning, dependency readiness, scope and acceptance. Each implementation task has a self-contained prompt, explicit allowed-file list, frozen acceptance criteria, and a recorded execution ID. Start serially; batch or parallel work only when tasks are independent and their file responsibilities do not overlap.

## Roles and status

Codex may assign implementation to a Codex subagent or to a DSH subagent through this bridge. These are separate execution channels. A Codex model selection applies to the Codex subagent; bridge `--model` sets DSH `agentOptions.model`. The bridge inherits the configured DSH default model if no override is supplied. Users may select models available in their own environment; no specific model name is portable.

Dependencies must be accepted before a task is ready. The implementation agent follows the task allowlist and reports results; it does not mark work accepted or edit controller acceptance records. Codex independently reviews the actual diff or file changes and runs acceptance checks. Bridge `completed` means execution ended, not that the project accepted the result.

Keep execution states distinct. `failed` is an execution failure, `cancelled` is an explicit cancellation, and `interrupted` indicates infrastructure restart. These are not manual rework. A wait timeout does not cancel a task: inspect it before retrying. After two manual rework rounds, stop recycling the same prompt; replan or split the task and revise dependencies and acceptance criteria. Record every accepted task ID, including each ID returned from a partially rejected batch. No automatic Beads or other tracker integration is assumed; use a tracker only after verifying it is configured in the target project.

## Dispatch

In the target project, create or edit a task file with all background, requirements, allowed files and checks. Then:

```sh
dsh-dispatch doctor
dsh-dispatch submit --prompt-file dsh-task.md --mode async --label task-label
dsh-dispatch wait <task-id>
```

Save the returned ID. If wait times out or the task remains active, run `dsh-dispatch status <task-id>`. For batch submission, use `dsh-dispatch batch --file tasks.json` only for independent tasks. Save every accepted ID and handle rejected indices individually; never resubmit a partially accepted batch wholesale.

The CLI inherits the server's configured model by default. Use `--model` only to select a DSH task model; it does not select a Codex implementation model. For full configuration precedence and limits, see [CONFIGURATION.md](../docs/CONFIGURATION.md). Commands and exit codes are summarized by `dsh-dispatch --help` and [TROUBLESHOOTING.md](../docs/TROUBLESHOOTING.md).

## Independent review

After execution, inspect actual changes against the allowed-file list and baseline, review correctness and maintainability, and run the acceptance commands independently. Record command, working directory, real output, exit status, limitations, and the decision using [ACCEPTANCE_TEMPLATE.md](ACCEPTANCE_TEMPLATE.md). If Git, a worktree, or an issue tracker will be used, verify it in the actual target project first; never infer repository state or claim an integration that was not checked.

