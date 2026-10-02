# DSH ↔ Codex Bridge

[English](README.en.md)

`@dsh-external/dsh-codex-bridge` 是 DeepSeek Harness 插件和 `dsh-dispatch` 命令行客户端：它把自包含任务交给已配置 Harness 中的 subagent，并保存执行状态。它不是独立模型或 Harness 服务。运行环境需要已配置的 DeepSeek Harness，包含 `webServer`、`agents` 和 `subagents` 服务，并且 DSH 已配置默认 agent model。

需要 Node.js 22.19 或更新版本（推荐 Node 22 或 24）。上游项目：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。当前发布版本为 0.2.0。

## 从源码安装

解压源码 ZIP，在其目录运行：

```sh
npm ci
npm run build
npm link
dsh plugin --profile web add .
```

启动或重启已挂载插件的 profile：

```sh
dsh --profile web
```

CLI 可使用全局 `dsh-dispatch`，也可直接运行安装目录中的 `node /path/to/install/codex-dsh-client.mjs`。从源码包安装时必须先构建；不要直接挂载未构建的 GitHub 源码仓库。

## 从 release TGZ 安装

在 release 输出目录中分别安装 CLI 包，并将同一 TGZ 挂载到 Harness：

```sh
npm install --global ./dsh-external-dsh-codex-bridge-0.2.0.tgz
dsh plugin --profile web add ./dsh-external-dsh-codex-bridge-0.2.0.tgz
dsh --profile web
```

这里的 npm 包名仅用于本地 TGZ 安装；项目设置了 `private: true`，阻止 `npm publish`，不影响 GitHub 托管或安装本地 release 包。

## 在业务项目中派发任务

先进入业务项目目录并生成可编辑的本地文件：

```sh
cd /path/to/your/project
dsh-dispatch init
```

`init` 创建 `dsh-bridge.json`、`dsh-task.md`、`AGENTS.dsh.md`，逐个跳过已存在文件，不覆盖内容。编辑 `dsh-task.md`，填写可独立执行的真实需求、允许修改的文件和可判定验收条件。在现有 `AGENTS.md` 中按需加入一条引用：

```md
See AGENTS.dsh.md for DSH task-dispatch conventions.
```

`init` 不会修改现有 `AGENTS.md`。随后检查桥接并异步提交：

```sh
dsh-dispatch doctor
dsh-dispatch submit --prompt-file dsh-task.md --mode async --label example
dsh-dispatch wait <task-id>
```

保存 submit 返回的 task ID。若 `wait` 超时，运行 `dsh-dispatch status <task-id>` 后再决定后续操作；超时不会取消任务。完成后独立检查实际改动、diff 和测试，再决定是否接受。bridge 的 `completed` 只表示执行结束。

CLI 默认继承 Harness 当前默认模型，无须在项目配置中固定模型。CLI `--model` 只设置 DSH `agentOptions.model`；它与 Codex 自身规划或实现所用模型无关。

配置、批量提交和安全限制见[配置参考](docs/CONFIGURATION.md)；常见故障见[排查指南](docs/TROUBLESHOOTING.md)；本地打包见[发布指南](docs/RELEASING.md)。
