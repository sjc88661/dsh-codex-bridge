# DSH ↔ Codex Bridge

[简体中文](README.md)

Version 0.2.0 is a DeepSeek Harness plugin plus the `dsh-dispatch` CLI. It sends self-contained tasks to subagents in an already configured Harness and records execution status. It is not a standalone model or server. You need a Harness profile with `webServer`, `agents`, and `subagents`, plus a configured default agent model.

Requires Node.js 22.19 or newer; Node 22 or 24 is recommended. See the [DeepSeek Harness project](https://github.com/deepseek-ai/deepseek-harness).

## Install from source

Unpack the source ZIP, then run in its directory:

```sh
npm ci
npm run build
npm link
dsh plugin --profile web add .
dsh --profile web
```

Restart the profile after mounting the plugin. Run the client as `dsh-dispatch`, or use `node /path/to/install/codex-dsh-client.mjs`. Source installs require a build; do not mount an unbuilt repository checkout.

## Install a release TGZ

From the release directory, install the CLI and mount the plugin as separate steps:

```sh
npm install --global ./dsh-external-dsh-codex-bridge-0.2.0.tgz
dsh plugin --profile web add ./dsh-external-dsh-codex-bridge-0.2.0.tgz
dsh --profile web
```

## Dispatch a project task

In your project directory:

```sh
dsh-dispatch init
dsh-dispatch doctor
dsh-dispatch submit --prompt-file dsh-task.md --mode async --label example
dsh-dispatch wait <task-id>
```

Edit `dsh-task.md` first with complete requirements, an allowed-file list, and checkable acceptance criteria. `init` creates `dsh-bridge.json`, `dsh-task.md`, and `AGENTS.dsh.md`, skipping existing files; it never edits your existing `AGENTS.md`. Add a reference to `AGENTS.dsh.md` there if useful. Save the returned task ID. If `wait` times out, inspect `dsh-dispatch status <task-id>`; a timeout does not cancel the task. Review the actual changes and checks independently. Harness completion is not project acceptance.

The client inherits the configured DSH default model. `--model` configures the DSH task's agent model, independently of the model used by Codex itself.

See [configuration](docs/CONFIGURATION.md), [troubleshooting](docs/TROUBLESHOOTING.md), and [release instructions](docs/RELEASING.md). `private: true` prevents npm publishing; it does not prevent local TGZ installation or GitHub releases.
