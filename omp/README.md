# OMP extensions and roles

插件子目录是可独立安装的 OMP package，manifest 使用 `package.json` 的 `omp.extensions`。非插件的启动配置也按功能分目录保存。

| Plugin | Purpose |
|---|---|
| [`adaptive-provider-queue`](adaptive-provider-queue/) | 跨进程 FIFO 恢复、共享重试预算与单槽位进度条；其他不可用错误交给 OMP fallback |
| [`pi-tool-display`](pi-tool-display/) | OMP-native compact tool output, diff rendering, thinking labels, and the `/tool-display` settings command |
| [`perplexity-role`](perplexity-role/) | 使用 Perplexity-first `web_search` 的独立主 Agent 窗口，无 task agent 委派 |
