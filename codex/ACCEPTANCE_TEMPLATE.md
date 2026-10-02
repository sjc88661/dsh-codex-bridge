# Independent acceptance record

The controller maintains this record and decides project acceptance. Bridge execution completion is not acceptance.

## Task and attempt

- **Project/task ID:** `<project>` / `<task>`
- **Dependencies and readiness:** `<required dependencies and accepted state>`
- **Execution channel/model:** `<Codex subagent or DSH provider/model; do not infer backend version>`
- **Accepted bridge task ID(s):** `<IDs, if applicable>`
- **Attempt:** `initial` / `manual rework 1` / `manual rework 2` / `infrastructure retry` / `cancelled`
- **Workspace and baseline:** `<verified absolute workspace>` / `<commit and initial status, or SHA-256 evidence>`
- **Reviewer/date:** `<name>` / `<date>`
- **Decision:** `accepted` / `rework` / `blocked`

## Specification and quality review

- **Scope and criteria reviewed:** `<brief description>`
- **Allowed-file compliance:** `yes/no`; changed files: `<list>`
- **Actual input and observed output:** `<evidence or reason not applicable>`
- **Specification criteria met:** `yes/no`; exceptions: `<details>`
- **Diff or before/after evidence reviewed:** `<reference>`
- **Quality findings and risks:** `<specific findings, or none>`

## Independent checks

| Criterion | Exact command/observation and directory | Actual result/output | Exit status | Pass/skip/fail |
|---|---|---|---:|---|
| <criterion> | <command and directory> | <actual evidence> | <n> | <result> |

**Limitations:** `<environment issue, permitted skip, or none; state uncollected data as not collected>`

## Decision basis and follow-up

For **accepted**, explain how scope, quality and independent checks satisfy the criteria.

For **rework**, provide a self-contained repair assignment with the original relevant context, expected behavior, workspace, baseline, allowed files, failed criterion, exact command/output/exit status, reproduction input/output, required correction and new pass condition. Record whether this is manual rework 1 or 2. After two manual rework rounds, replan or split the task instead of resending the same prompt. Infrastructure interruption, cancellation and manual rework are separate events; before infrastructure retry, inspect for partial changes and preserve the existing execution ID.

For **blocked**, record the external blocker, evidence, required action/owner, and condition for returning the task to ready. Do not use blocked to represent manual rework.

