# OMP extensions and roles

插件子目录是可独立安装的 OMP package，manifest 使用 `package.json` 的 `omp.extensions`。非插件的启动配置也按功能分目录保存。

| Plugin | Purpose |
|---|---|
| [`adaptive-provider-queue`](adaptive-provider-queue/) | 全 provider 透明 Retry；AI Input 按延迟+抖动选 URL；可选跨进程 FIFO 恢复 |
| [`pi-tool-display`](pi-tool-display/) | OMP-native compact tool output, diff rendering, thinking labels, and the `/tool-display` settings command |
| [`omp-task-provider-handoff`](omp-task-provider-handoff/) | 中途替换 provider-bound task agent：交接、停止旧 child、用新 profile 继续 |
| [`omp-copy-turn`](omp-copy-turn/) | 回答结束后用 `Ctrl+X`、`F6` 或 `/copy-turn` 复制最近一轮问题和最终回答 |
| [`perplexity-role`](perplexity-role/) | 使用 Perplexity-first `web_search` 的独立主 Agent 窗口，无 task agent 委派 |

`omp-task-provider-handoff` 采用替换式切换。OMP 18 没有公开的 running child
`set_provider` API，因此它不会修改共享 `model` 或 `model.api`。命令或模型工具会
排队一条编排消息，由主 Agent 按公开的 `hub` 与 `task` 工具完成：请求 handoff、
等待回复、取消旧 child、用目标 agent profile 创建新 child，并把 `history://<id>`
和交接内容传入新任务。

```text
/task-handoff <source-agent-id> [target-agent-profile] [reason]
/task-replace <source-agent-id> <target-agent-profile> [reason]
```

模型可调用 `task_provider_handoff`，参数中的 `targetAgent` 是 OMP task agent/profile
名称（例如 `tokenking-terra-max-executor`），不是裸 provider 名称。工具返回
`orchestrationQueued: true` 只表示编排消息已排队；只有后续 `hub`/`task` 的真实结果
才代表替换成功。
