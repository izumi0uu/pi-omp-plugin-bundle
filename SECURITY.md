# Security

插件代码在 Pi/OMP Agent 进程内执行，不存在浏览器式沙箱。它可以读取工作区、环境变量和凭据，也可以发起网络请求或启动子进程。

## Repository policy

- 不提交 API key、OAuth token、cookie、`.env`、认证数据库或完整请求日志。
- 示例凭据必须为空值或明确的占位符。
- provider queue 的持久状态只保存 PID、时间戳和经过 SHA-256 哈希的 lane 标识，不保存原始 API key。
- 安装第三方依赖前审阅安装脚本和依赖树。
- 发布前使用干净环境运行测试和 package dry-run。

## Adaptive queue state

OMP 版本默认将票据写入 `~/.omp/run/adaptive-provider-queue/`。lane 目录使用 `0700`，ticket 文件使用 `0600`；异常退出留下的票据会按 PID 存活状态和超时时间清理。
