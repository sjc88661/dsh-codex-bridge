# Implementation task

Copy this template into the target project's task records and complete every relevant field before dispatch. The implementation agent cannot see the planning conversation, so include all needed context here.

## Identity and execution

- **Task ID/title:** `<stable task identifier>` / `<short title>`
- **Dependencies:** `<all required tasks must be accepted before this is ready>`
- **Execution channel:** `Codex subagent` / `DSH bridge`
- **Execution model:** `<optional; choose from models available in that channel>`
- **Bridge task ID:** `<record every accepted ID after dispatch>`
- **Workspace:** `<existing absolute target-project directory>`
- **Baseline:** `<verified Git commit and status, or SHA-256 manifest>`
- **Allowed files:** `<explicit file list or narrow directory scope>`

## Background and requested outcome

**Context and current behavior:**
<Provide the details required to work without the conversation.>

**Trigger/input and expected result:**
<Describe observable behavior and relevant edge cases.>

**Interfaces and compatibility constraints:**
<List signatures, formats, error behavior, and compatibility needs; otherwise state none.>

**In scope:**
- <specific change>

**Out of scope:**
- <clear boundaries, including deployment or live configuration if relevant>

## Acceptance criteria

Each criterion must be independently checkable. Give the exact command, working directory, expected result, and permitted skips.

1. **Criterion:** <observable requirement>
   **Check:** Run `<exact command>` in `<directory>`.
   **Pass condition:** `<expected output/assertion/exit status>`
2. **Criterion:** <observable requirement>
   **Check:** Run `<exact command>` in `<directory>`.
   **Pass condition:** `<expected output/assertion/exit status>`

**Permitted skips and reason:** `<items and reporting requirements, or none>`

## Required delivery

- List changed files and decisions.
- Report every acceptance command, its actual output and exit status; identify skipped and failed checks.
- Provide the actual diff or before/after file evidence against the baseline.
- Include relevant input/output, unresolved issues and any disagreement with the acceptance criteria.
- Do not mark the task accepted, edit controller acceptance records, or change live service configuration unless explicitly included in scope.

