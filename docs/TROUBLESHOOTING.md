# Troubleshooting

| Symptom | Check |
|---|---|
| `doctor` cannot connect | Start the intended Harness profile, confirm the plugin is mounted there, and check that the URL and port match. The default is loopback port 3080. |
| Default model is missing | Configure a default agent model in Harness. The bridge inherits it unless a DSH `--model` override is supplied. |
| Provider rejects `agentOptions` | Run `dsh-dispatch providers`; use a task provider whose capabilities include `agentOptions`, or omit model/provider overrides and select a compatible provider. |
| Agent cannot edit files or run commands | Check the configured `agentPreset` and its tools. For a web profile, ensure the preset provides the required filesystem/shell tools. |
| HTTP 401 | Ensure `DSH_BRIDGE_TOKEN` in the client environment matches the plugin's `apiToken` in the Harness server environment. The client JSON file does not configure or read the token. |
| Browser request is rejected or POST returns 415 | This API is for the native CLI. It rejects browser `Origin` requests and POSTs without `application/json`. |
| Workspace rejected or missing | Check the selected path exists and is a directory, then inspect server `workspaceRoots`. Roots and target are canonicalized; symlinks/junctions that resolve outside an allowed root are rejected. |
| `wait` times out | Timeout does not cancel the task. Inspect `dsh-dispatch status <task-id>` before taking action or submitting a replacement. |
| Batch exits 1 but includes IDs | Some items may have been accepted. Save and follow every returned ID, then address only rejected items; do not resend the whole batch. |
| Config error or unknown field | Use only the eight fields in [configuration](CONFIGURATION.md). Keep tokens in `DSH_BRIDGE_TOKEN`; an empty `DSH_BRIDGE_URL` is invalid. |
| Build or install fails | Use Node.js 22.19+ and run `npm ci` before `npm run build`. If `npm link` lacks global write permission, use `node /path/to/install/codex-dsh-client.mjs` instead. |

For command syntax, run `dsh-dispatch --help`. Exit codes are 0 for command success (an async task may still be queued/running), 1 for runtime/terminal failure, timeout, or partial batch, and 2 for usage errors. `sync` submit and `wait` return 0 only when the task is `completed`. That execution state does not itself mean project acceptance.
