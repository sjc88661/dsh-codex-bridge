# Codex and DSH task workflow

Codex plans each task, defines dependencies and acceptance criteria, freezes the allowed file list, and owns independent review and acceptance. Keep work serial unless the controller explicitly authorizes independent parallel tasks.

The implementation agent receives a self-contained task prompt and follows only its allowed file list. It reports changed files, decisions, validation results, limitations, and incomplete work. It does not mark work accepted or edit controller task, review, or acceptance records.

The controller checks the actual changes against the baseline and allowlist, reviews the implementation, runs the acceptance checks independently, and records the decision. Harness completion means execution ended; it does not mean project acceptance. Preserve every accepted task identifier, including when a batch response partially rejects tasks.

For DSH execution, run `dsh-dispatch doctor` first and confirm readiness. Submit the self-contained task with `dsh-dispatch submit --prompt-file <absolute-path-to-dsh-task.md> --workspace <absolute-workspace> --mode async`; retain the returned task ID even if the command also reports partial failure. Follow it with `dsh-dispatch wait <task-id>` and use `dsh-dispatch status <task-id>` if it is still running or wait times out. For a partially rejected batch, record every accepted ID and handle rejected indices individually; never resubmit the whole batch. The bridge `--model` option sets the DSH agent model and does not select the Codex implementation model.

Include the absolute workspace, baseline, frozen interfaces, acceptance commands, and delivery fields in each task. Do not assume a Git HEAD, worktree, task database, provider, model, or credentials unless verified for the target project. Credentials belong in environment variables, never in task or config files.
