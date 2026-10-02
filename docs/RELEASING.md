# Local release artifacts

This workflow creates artifacts locally. It does not publish to npm or upload to GitHub. From a clean source checkout, run these commands separately:

```sh
npm ci
npm run check
npm run release
```

The release script creates a uniquely named directory under `release/` containing:

- a versioned source folder and source ZIP;
- a compiled installable npm TGZ;
- `SHA256SUMS` and `release-manifest.json`.

`release-files.json` is the explicit source export allowlist. It includes the implementation, tests, build/CI files, public docs, examples and reusable Codex workflow templates. It excludes local `AGENTS.md` instructions, `codex/PROJECT_STATUS.md`, task and review history, `docs/superpowers`, local config/secrets/journals, `node_modules`, caches, and existing release output. The release script validates paths and rejects symlinked inputs.

The source ZIP omits compiled `lib/`; build it with `npm ci` and `npm run build` before mounting. The TGZ already contains compiled plugin JavaScript and does not need TypeScript at runtime. To use the TGZ, install it globally for the CLI and separately mount it as a plugin; see the README.

Verify a checksum from the release directory with either:

```powershell
Get-FileHash .\dsh-codex-bridge-0.2.0.zip -Algorithm SHA256
```

```sh
sha256sum -c SHA256SUMS
```

After maintainer review, publish the clean source folder as the chosen GitHub repository and attach the TGZ, ZIP, and checksum file to a GitHub Release. Select the repository and release target explicitly; this project does not assume an owner or repository URL. `private: true` deliberately prevents npm publication while allowing local TGZ installation and GitHub distribution.
