# OMP Pi Tool Display

OMP-native port of [MasuRii/pi-tool-display](https://github.com/MasuRii/pi-tool-display), pinned to upstream `v0.5.0`.

It provides compact tool output, edit/write diff rendering, thinking labels, a native user-message box, and the `/tool-display` settings command. The port uses OMP's `@oh-my-pi/pi-coding-agent` and `@oh-my-pi/pi-tui` APIs and stores runtime state under the active OMP agent directory.

## Install

From the bundle root, choose one installation source. Do not install this child package and the bundle root at the same time; both can load related extensions.

```bash
# Development link for this checkout
omp plugin link ./omp/pi-tool-display

# Or install the whole bundle from its public GitHub repository
omp plugin install github:izumi0uu/pi-omp-plugin-bundle#main
```

The upstream Pi package is not required and should not be installed alongside this port. Pin a commit or tag for reproducible installs instead of using an unpinned branch in production.

## OMP-specific behavior

The port resolves its configuration directory from the same environment as OMP:

```text
default:       ~/.omp/agent/extensions/pi-tool-display/config.json
PI_CONFIG_DIR: <config-root>/agent/extensions/pi-tool-display/config.json
profile:       <config-root>/profiles/<profile>/agent/extensions/pi-tool-display/config.json
```

The default tool ownership is intentionally conservative:

| Tool | Default | Reason |
|---|---:|---|
| `read` | on | OMP-compatible compact read rendering |
| `grep` | on | Compact search summaries |
| `bash` | on | Collapsed command output |
| `edit` | off | Avoid replacing OMP's current edit implementation |
| `write` | off | Avoid replacing OMP's current write implementation |
| `find` / `ls` | off | OMP uses newer search tools such as `glob` |

Enable additional ownership only after checking the resulting tool schema and behavior. Edit `config.json`, then run `/reload`:

```json
{
  "registerToolOverrides": {
    "edit": true,
    "write": true
  }
}
```

The configuration modal is available through `/tool-display`. The complete upstream option reference is preserved in [`UPSTREAM_README.md`](UPSTREAM_README.md).

## Verification

The source was imported from the `v0.5.0` GitHub archive with SHA-256:

```text
fefb1d52ad07e2e40091edbdbf3874c98fa7a7c4d3e24ac4f4db4e056ab90de9
```

The vendored source is MIT licensed; see [`LICENSE`](LICENSE) and [`UPSTREAM_CHANGELOG.md`](UPSTREAM_CHANGELOG.md).

The port's 311 focused tests pass. An isolated OMP 17.2.4 RPC startup also loaded the extension and registered the `tool-display` command without changing the user's live OMP profile.

## Development

```bash
npm test
npm run pack:check
```

The focused test set covers configuration normalization, OMP directory resolution, ANSI handling, pending previews, capability detection, debug logging, presets, and thinking-label behavior. Full upstream UI tests remain in the upstream project because they require its interactive TUI test harness.
