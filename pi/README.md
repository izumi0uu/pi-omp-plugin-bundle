# Pi plugins

此目录只放 Pi 原生包，manifest 使用 `package.json` 的 `pi.extensions`，源码导入 `@earendil-works/pi-*` API。

当前 `adaptive-provider-queue` 已针对 OMP 17.2.2 的 provider stream 与 Responses 兼容层完成验证，因此先保留在 `omp/`。移植到 Pi 时应创建独立的 `pi/adaptive-provider-queue/` 包，替换运行时 import，并重新验证流事件、Responses compat、取消信号和跨进程 FIFO；不直接复制后宣称兼容。
