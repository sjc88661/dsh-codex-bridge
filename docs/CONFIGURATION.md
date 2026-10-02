# Configuration

## CLI project configuration

The client discovers the nearest `dsh-bridge.json` by walking upward from its working directory. Use `--config FILE` to select a file explicitly; the global option works before or after the command. Only these fields are accepted:

| Field | Meaning |
|---|---|
| `url` | Loopback bridge URL; defaults to `http://127.0.0.1:3080/dsh-codex-bridge` |
| `workspace` | Default task workspace, relative to the config file when relative |
| `provider` | DSH task subagent provider |
| `model` | DSH task model (`agentOptions.model`) |
| `agentProvider` | DSH task agent provider (`agentOptions.provider`) |
| `mode` | Default `sync` or `async` submission mode |
| `maxDepth` | Non-negative task depth |
| `timeoutMs` | Client HTTP timeout in milliseconds |

Example `dsh-bridge.json`:

```json
{
  "url": "http://127.0.0.1:3080/dsh-codex-bridge",
  "workspace": ".",
  "mode": "async"
}
```

No model is specified, so the task inherits the configured DSH default. CLI task flags override file defaults. `DSH_BRIDGE_URL` and `DSH_BRIDGE_TIMEOUT_MS` override file values; `DSH_BRIDGE_TOKEN` is environment-only and is never accepted in JSON. An explicitly empty URL environment variable is invalid. Any supplied URL is validated as loopback, including a file URL that would otherwise be overridden.

Workspace path bases differ by source: config workspace is relative to the config file; explicit CLI `--workspace` is relative to the CLI current directory; per-item `workspace` or `cwd` in a batch is relative to the batch file. If none is supplied, the server uses its configured workspace or DSH process working directory. Relative paths are resolved to absolute paths before dispatch.

Batch mode is selected with `dsh-dispatch batch --file tasks.json`. Its per-item fields override configured defaults. Config `mode` is ignored for batch submissions, which are asynchronous. Config `model` and `agentProvider` fill only missing agent option keys; explicit per-task `agentOptions` values win. Setting just one does not infer or fill the other.

The CLI HTTP request timeout defaults to 660000 ms and can be set with `DSH_BRIDGE_TIMEOUT_MS` or config `timeoutMs`. `wait` has a separate overall timeout, default 600000 ms, set with `--timeout-ms`; a single HTTP request timeout can make `wait` return earlier. Neither timeout cancels the task, so inspect it with `status` before resubmitting.

## DSH plugin configuration

The plugin accepts these server fields (defaults shown):

| Field | Default | Purpose |
|---|---:|---|
| `pathPrefix` | `/dsh-codex-bridge` | HTTP route prefix |
| `apiToken` | empty | Optional Bearer token required on all requests |
| `provider` | `spawn` | Default DSH subagent provider |
| `workspace` | DSH process cwd | Default workspace and journal base |
| `workspaceRoots` | `[]` | Allowed canonical workspace roots; empty means unrestricted |
| `agentPreset` | `standard` | Agent preset controlling available tools |
| `agentProvider` | inherited | Dispatcher provider override |
| `agentModel` | inherited | Dispatcher model override |
| `maxTokens` | `0` | Dispatcher token limit; zero leaves it unset |
| `maxDepth` | `3` | Default task depth |
| `defaultMode` | `async` | Default request mode (`sync` or `async`) |
| `requestTimeoutMs` | `600000` | Synchronous submission wait limit |
| `maxConcurrent` | `3` | Running task limit; zero means unlimited |
| `journalPath` | `<workspace>/.dsh-codex-bridge/tasks.jsonl` | JSONL execution journal |
| `keepTasks` | `500` | Soft target for retained completed task records; zero disables trimming |

For the dispatcher, when both `agentProvider` and `agentModel` are omitted, the bridge uses the Harness `agentDefaultModel` service selection. If only one is set, the other is left unset; the bridge does not fill it from the service. `workspaceRoots` restricts accepted task workspace paths after canonicalization. It is a dispatch target allowlist, not a complete shell or tool sandbox: configure Harness tools and permissions accordingly. `maxConcurrent` defaults to 3; for an initial serial workflow, set it to 1.

The `standard` preset must provide the tools required for the work. Web profiles commonly attach filesystem and shell tools through the preset; an absent or unsuitable preset can leave an agent unable to modify files. The selected task provider must report `acceptsAgentOptions: true` when model/provider task options are used.

An optional Harness bundle patch is provided at [`examples/bridge.patch.yml`](../examples/bridge.patch.yml). Supply its path when starting the profile, for example `dsh --profile web --patch /path/to/bridge.patch.yml`. It sets a serial concurrency limit and restricts accepted workspaces to `.`. Relative workspace roots are resolved from the DSH process working directory, so start the profile from the business project directory to apply this example there. Harness applies the patch's `config` as the plugin configuration; add any desired non-default fields there as well. If `apiToken` is enabled, set `DSH_BRIDGE_TOKEN` in both the Harness server environment and the CLI client environment. The plugin does not read `dsh-bridge.json`.

## Execution records and status

The journal stores at most 4000 prompt characters for a task. List responses show a 200-character preview. `status` shows the full prompt while the task remains in memory; after recovery it may contain only the journal's 4000-character copy. On restart, unfinished tasks become `interrupted`; they are never automatically rerun. Inspect the workspace and task before manually resubmitting.

`keepTasks` is a soft retention target: trimming removes terminal records only, so the in-memory count can temporarily exceed it while an unfinished record is at the head. `/stats` covers only the retained execution window. It reports execution counts and durations, not human acceptance, end-to-end time, tokens, or cost. A task marked `completed` still requires independent project review and acceptance.
