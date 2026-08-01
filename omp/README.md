# OMP plugins

此目录下的每个子目录都是可独立安装的 OMP package，manifest 使用 `package.json` 的 `omp.extensions`。

| Plugin | Purpose |
|---|---|
| [`adaptive-provider-queue`](adaptive-provider-queue/) | 遇到瞬时并发限流后启用跨进程 FIFO 排队；其他不可用错误继续交给 OMP fallback |
