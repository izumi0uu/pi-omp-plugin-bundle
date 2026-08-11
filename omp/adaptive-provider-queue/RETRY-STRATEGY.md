# OMP Provider Retry And Fallback Strategy

记录日期：2026-08-11。当前验证版本：OMP 17.2.12。

## 目标

- 正常请求不设置固定并发上限。
- 真实请求返回限流或可恢复的传输错误时才进入 FIFO 队列。
- 临时上游 `502/503/504`、`server_is_overloaded`、`stream_read_error`、超时、连接断开和不完整流与限流共享
  50 次预算；同一 endpoint + credential lane 的所有窗口共享这一份预算，避免瞬时服务
  拥塞或传输波动过早触发 fallback。
- OMP 外层不再为同一个 `5xx` 启动第二套重试循环。
- fallback 失败后保留冷却，避免无限来回切换；同时提供一次有界的原生 transport 尝试。

## 当前角色

```yaml
modelRoles:
  default: aiinput-queued/gpt-5.6-sol:max
  slow: aiinput-queued/gpt-5.6-sol:max
  plan: aiinput-queued/gpt-5.6-sol:max
  designer: kimi-code-queued/k3:max
  research: tokenking-grok-queued/grok-4.5:high
  perplexity: tokenking-grok-queued/grok-4.5:high
```

`default`、`slow`、`plan` 和 `designer` 都使用 adaptive queue transport。主模型在
输出正文、tool call 或图片前遇到限流、明确的临时服务器过载或可恢复传输错误时，会
执行同一套 50 次分段重试；遇到鉴权、额度、明确的模型不可用或其他非瞬态错误时才立即
进入 fallback。手动选择普通 `aiinput` 或 `kimi-code` 会绕过这套内部队列并采用
fail-fast 行为，与 queued selector 不会自动互换。

## 重试归属

OMP 全局重试关闭，插件单独拥有可恢复错误重试：

```yaml
retry:
  maxRetries: 0
  modelFallback: true
  fallbackRevertPolicy: cooldown-expiry
```

| 重试编号 | 插件等待策略 |
|---|---|
| 1-10 | 500 ms 起步的指数退避，单次最高 30 秒 |
| 11-20 | 每次 1 分钟 |
| 21-30 | 每次 2 分钟 |
| 31-40 | 每次 3 分钟 |
| 41-50 | 每次 5 分钟封顶 |

限流和可恢复传输错误共享同一个计数器，不会分别获得两套预算。只有 thinking 的流
仍可重试，后续尝试会抑制重复的 thinking 和 stream envelope；一旦已经输出正文、
tool call 或图片，就不重放。手动取消会立即中断等待，但不会清空正在恢复的 lane 状态。

### 跨窗口恢复状态

- 健康 lane 不限制初始并发；只有真实请求失败后才创建共享恢复状态。
- 每个 endpoint + credential lane 只有一份 50 次恢复预算，FIFO 队首是唯一探针，
  其余窗口只排队等待。
- 探针成功完成，或开始输出正文、tool call、图片时，立即清除共享状态并释放队列。
- 第 50 次重试仍失败，或活动探针在输出内容前遇到不可恢复错误时，lane 会保留 5 分钟
  `exhausted` 状态。等待者和新请求不再访问上游，直接交给 OMP fallback。
- 探针窗口取消或进程退出时，下一位存活的队首沿用原计数和重试时间，不从 0 开始。

## 错误路由

| 错误 | 行为 |
|---|---|
| 输出正文/tool/image 前的 `429`、concurrency、rate limit | 排队并使用共享 50 次预算 |
| 临时上游 `502/503/504`，包括明确的 `server_is_overloaded` 同义响应 | 排队并使用共享 50 次预算 |
| 输出正文/tool/image 前的 `stream_read_error`、timeout、socket/fetch/network failure、不完整流 | 排队并使用共享 50 次预算 |
| `401`、`403`、token revoked | 立即交给 OMP fallback |
| quota、billing、credit、balance exhausted | 立即交给 OMP fallback |
| model unavailable、no capacity、其他非瞬态 `5xx` | 立即交给 OMP fallback |
| 已产生文本、tool call 或图片后的错误 | 不重放，直接结束当前流 |
| queued provider 的第 50 次重试仍失败 | 把最后一次错误交给 OMP fallback，并缓存 lane exhaustion 5 分钟 |
| lane exhaustion 缓存期间的新请求或等待者 | 不访问上游，直接交给 OMP fallback |

## Fallback Chain

每个当前入口使用相同的两级 TokenKing chain：

```yaml
retry:
  fallbackChains:
    aiinput-queued/*:
      - tokenking-queued/gpt-5.6-sol:max
      - tokenking/gpt-5.6-sol:max
    aiinput/*:
      - tokenking-queued/gpt-5.6-sol:max
      - tokenking/gpt-5.6-sol:max
    aiinput-overseas-queued/*:
      - tokenking-queued/gpt-5.6-sol:max
      - tokenking/gpt-5.6-sol:max
    aiinput-overseas/*:
      - tokenking-queued/gpt-5.6-sol:max
      - tokenking/gpt-5.6-sol:max
    kimi-code-queued/*:
      - tokenking-queued/gpt-5.6-sol:max
      - tokenking/gpt-5.6-sol:max
    kimi-code/*:
      - tokenking-queued/gpt-5.6-sol:max
      - tokenking/gpt-5.6-sol:max
    tokenking-grok-queued/*:
      - tokenking-queued/gpt-5.6-sol:max
      - tokenking/gpt-5.6-sol:max
    tokenking-grok/*:
      - tokenking-queued/gpt-5.6-sol:max
      - tokenking/gpt-5.6-sol:max
```

`kimi-code-queued/*` 复用 OMP 内置 `kimi-code` 登录保存的凭据，但请求经过 adaptive
queue transport，并参与同一 endpoint + credential lane 的共享恢复活动。内置
`kimi-code/*` selector 绕过插件队列，仍使用 OMP 的直接 transport；两者指向同一
Kimi Code 服务，不是相互独立的供应商或账号。

两个 TokenKing selector 使用相同的 `TOKENKING_API_KEY` 和
`https://api.tokenskingdom.com/v1`：

1. `tokenking-queued` 先使用 adaptive queue transport。
2. 它失败并进入 selector 冷却后，普通 `tokenking` 仍可执行一次 OMP 原生
   Responses transport 请求。

这不是独立供应商、独立账号或独立线路冗余。TokenKing 服务、账号、Key 或网络路径
整体故障时，两个 selector 都可能失败。第二候选只提供 transport 差异和一次有界尝试，
不会绕过真实的上游故障。

## 冷却与恢复

插件自身的 lane exhaustion 会缓存 5 分钟，用于让同一故障域的所有窗口停止探测并快速
进入 fallback。它与下面的 OMP selector 冷却是两套独立状态：前者属于插件、按
endpoint + credential lane 共享；后者属于 OMP、按 model selector 管理。

OMP 会抑制刚失败的 model selector。错误没有明确 `Retry-After` 且分类未知时，
抑制窗口通常约为 5 分钟。`fallbackRevertPolicy: cooldown-expiry` 会在主 selector
的抑制窗口结束后恢复主模型。

恢复只发生在请求边界，不会把已经由 fallback 生成到一半的响应切回主模型。下一条
消息会再次从当前恢复后的主模型开始。

`tokenking-queued` 和 `tokenking` 是不同 selector，因此前者处于冷却时后者仍可作为
chain 的下一项；但它们共享实际故障域，不能当作真正的高可用副本。

## Status Probe 边界

Personal xbar 的 `https://status.input.im/api/status` 探针只作为人工可观测信号，
不参与 OMP 自动重试或 fallback 决策，也不需要 quota 检测。原因：

- 公共探针约 60 秒采样一次，可能滞后。
- 它不代表当前 API key、账号并发或本机请求线路。
- `healthy` 不能保证当前请求成功，`degraded` 也不能证明当前账号不可用。

实际 provider 响应始终是自动路由的唯一控制信号。

## 诊断

```bash
omp config get retry.maxRetries
omp config get retry.modelFallback
omp config get retry.fallbackRevertPolicy
omp config get retry.fallbackChains --json
omp models aiinput-queued --json
omp models tokenking-queued --json
omp models kimi-code-queued --json
```

预期结果：

- `retry.maxRetries` 为 `0`。
- `retry.modelFallback` 为 `true`。
- `retry.fallbackRevertPolicy` 为 `cooldown-expiry`。
- queued provider 仍在各自扩展内保持 `maxRetries: 50`。
- `kimi-code-queued` 列出 7 个模型，并复用内置 `kimi-code` 登录凭据。

`Retry failed after 0 attempts` 表示 OMP 外层没有追加重试，通常意味着当前 fallback
chain 已耗尽、候选处于冷却或候选不可用；它不表示 queued provider 的内部 50 次预算
被执行完。

修改配置或 extension 后，应重新启动已有 OMP CLI 进程。
