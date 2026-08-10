# Pi / OMP Plugin Bundle

个人维护的 Pi 与 Oh My Pi 插件仓库。两个运行时的插件分别存放，避免依赖兼容层或把运行时专用 API 混在同一个发布包中。

```text
pi-omp-plugin-bundle/
├── pi/                         # Pi 原生插件
└── omp/                        # OMP 原生插件
    ├── adaptive-provider-queue/
    ├── pi-tool-display/
    └── perplexity-role/
```

## 当前插件

| Runtime | Plugin | Status |
|---|---|---|
| OMP 17.2.2 | `adaptive-provider-queue` | Locally verified; newer versions unverified |
| OMP 17.2.x | `omp-pi-tool-display` | Ported from upstream `v0.5.0`; pure tests and isolated OMP 17.2.4 load verified |
| OMP Role | `perplexity` | Dedicated main-agent window using Perplexity-first `web_search` |
| Pi | - | Reserved for native Pi ports |

## 开发与验证

```bash
npm run check
```

选择一个安装目标：bundle 根目录，或单独的某个 OMP 子包。根目录会加载全部 OMP 插件；不要把根目录和任一子包同时安装，否则会重复注册对应入口。

开发时可以链接整个 bundle；OMP 会读取根 manifest 中列出的所有 OMP 扩展：

```bash
omp plugin link .
```

也可以使用本地 `install` 别名：

```bash
omp plugin install .
```

在 OMP 17.2.2 中，这两条本地路径命令都会创建 symlink；移动或删除 checkout 会使插件失效。只开发当前插件时，也可以把某一个子目录作为安装目标，但切换前应先卸载原来的 bundle 或子包。

```bash
# 切换到子包安装前
omp plugin uninstall pi-omp-plugin-bundle

# 切换 adaptive-provider-queue 子包前
omp plugin uninstall omp-adaptive-provider-queue

# 切换 omp-pi-tool-display 子包前
omp plugin uninstall omp-pi-tool-display
```

如需只预览操作，使用 `omp plugin install PATH --dry-run`。OMP 17.2.2 的 `omp plugin link PATH --dry-run` 仍会实际创建链接。

发布到 GitHub 后使用仓库根安装，因为 OMP 的 GitHub source 不支持选择仓库子目录：

```bash
omp plugin install github:izumi0uu/pi-omp-plugin-bundle#COMMIT_OR_TAG
```

同一个插件也不要同时从手工 Extension 目录和 Plugin Manager 加载，否则会重复注册 provider 或工具。具体配置见 [`omp/adaptive-provider-queue/README.md`](omp/adaptive-provider-queue/README.md)、[`omp/adaptive-provider-queue/RETRY-STRATEGY.md`](omp/adaptive-provider-queue/RETRY-STRATEGY.md) 和 [`omp/pi-tool-display/README.md`](omp/pi-tool-display/README.md)。

`perplexity` 是窗口专用的 model role，不是插件或 task agent。安装配置和启动器后直接打开搜索窗口：

```bash
install -d ~/.omp/agent/perplexity-role ~/.local/bin
install -m 0644 omp/perplexity-role/config.yml omp/perplexity-role/system-prompt.md ~/.omp/agent/perplexity-role/
install -m 0755 omp/perplexity-role/omp-perplexity ~/.local/bin/omp-perplexity
omp-perplexity
```

该窗口的主 Agent 直接调用 Perplexity-first 搜索，只开放 `web_search` 工具，并把会话保存到独立的 session 目录。OMP 17.2.4 要求同名 role 同时登记在全局 `modelRoles` 中才会显示于 `/model`；只有启动 overlay 时仍能解析模型，但 UI 不展示。实际 provider 和 OAuth 状态需在展开的 `web_search` 工具卡片中查看。详见 [`omp/perplexity-role/README.md`](omp/perplexity-role/README.md)。

## 发布边界

bundle 根包和 `adaptive-provider-queue` 当前标记为 `private` / `UNLICENSED`，用于个人 Git 仓库和本地/Git 安装，并阻止误发布到 npm；`omp-pi-tool-display` 保留上游 MIT 许可证。公开分发其他插件前仍需明确许可证、移除对应的 `private`，再补充稳定的版本发布流程。

## Security

Pi/OMP 插件与 Agent 进程拥有相同的文件、环境变量和网络权限。只安装已审阅的源码，不提交 API key、OAuth token、`.env` 或真实请求日志。更多说明见 [`SECURITY.md`](SECURITY.md)。
