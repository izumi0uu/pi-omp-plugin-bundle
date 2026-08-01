# Pi / OMP Plugin Bundle

个人维护的 Pi 与 Oh My Pi 插件仓库。两个运行时的插件分别存放，避免依赖兼容层或把运行时专用 API 混在同一个发布包中。

```text
pi-omp-plugin-bundle/
├── pi/                         # Pi 原生插件
└── omp/                        # OMP 原生插件
    └── adaptive-provider-queue/
```

## 当前插件

| Runtime | Plugin | Status |
|---|---|---|
| OMP 17.2.2 | `adaptive-provider-queue` | Locally verified; newer versions unverified |
| Pi | - | Reserved for native Pi ports |

## 开发与验证

```bash
npm run check
```

选择一个安装目标：bundle 根目录，或单独的 `./omp/adaptive-provider-queue` 子包。不要同时安装两者；它们是不同的插件身份，但会加载同一个入口并重复注册 provider。

开发时可以链接整个 bundle；OMP 会读取根 manifest 中列出的所有 OMP 扩展：

```bash
omp plugin link .
```

也可以使用本地 `install` 别名：

```bash
omp plugin install .
```

在 OMP 17.2.2 中，这两条本地路径命令都会创建 symlink；移动或删除 checkout 会使插件失效。只开发当前插件时，也可以把 `./omp/adaptive-provider-queue` 作为安装目标，但切换前应先卸载原来的 bundle 或子包。

```bash
# 切换到子包安装前
omp plugin uninstall pi-omp-plugin-bundle

# 切回 bundle 根安装前
omp plugin uninstall omp-adaptive-provider-queue
```

如需只预览操作，使用 `omp plugin install PATH --dry-run`。OMP 17.2.2 的 `omp plugin link PATH --dry-run` 仍会实际创建链接。

发布到 GitHub 后使用仓库根安装，因为 OMP 的 GitHub source 不支持选择仓库子目录：

```bash
omp plugin install github:izumi0uu/pi-omp-plugin-bundle#COMMIT_OR_TAG
```

同一个插件也不要同时从手工 Extension 目录和 Plugin Manager 加载，否则会重复注册 provider。具体配置见 [`omp/adaptive-provider-queue/README.md`](omp/adaptive-provider-queue/README.md)。

## 发布边界

仓库和子包当前均标记为 `private` / `UNLICENSED`，用于个人 Git 仓库和本地/Git 安装，并阻止误发布到 npm。公开分发前需要明确许可证、移除 `private`，再补充稳定的仓库 URL 和版本发布流程。

## Security

Pi/OMP 插件与 Agent 进程拥有相同的文件、环境变量和网络权限。只安装已审阅的源码，不提交 API key、OAuth token、`.env` 或真实请求日志。更多说明见 [`SECURITY.md`](SECURITY.md)。
