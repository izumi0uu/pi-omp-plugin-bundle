# OMP Provider Retry And Fallback Strategy

记录日期：2026-08-11。当前验证版本：OMP 17.2.12。

## 目标

- 正常请求不设置固定并发上限。
- 真实请求返回限流或可恢复的传输错误时，默认在当前请求内独立重试，不创建共享队列。
- 临时上游 `502/503/504`、`server_is_overloaded`、`stream_read_error`、超时、连接断开和不完整流与限流共享
  当前请求的 50 次预算，避免瞬时服务拥塞或传输波动过早触发 fallback。
- 跨窗口 FIFO 和共享恢复预算保留为 session 级可选模式，默认关闭；需要时才让同一
  endpoint + credential lane 的窗口共享一次恢复活动。
- 允许单个 session 把普通 HTTP `502/503/504` 改为首次失败后立即进入 OMP fallback，
  不改变并发限流、明确服务器过载、断流、鉴权、额度和模型不可用的既有路由。
- 也允许单个 session 在同一 provider 上最多重试普通 `502/503/504` 五分钟，期间可
  Esc 取消；到期后才进入 fallback，给用户保留阻止跨账号切换的反应窗口。
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

`default`、`slow`、`plan` 和 `designer` 都使用 adaptive retry transport。主模型在
输出正文、tool call 或图片前遇到限流、明确的临时服务器过载或可恢复传输错误时，会
执行同一套 50 次分段重试；遇到鉴权、额度、明确的模型不可用或其他非瞬态错误时才立即
进入 fallback。手动选择普通 `aiinput` 或 `kimi-code` 会绕过这套内部重试并采用
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

限流和可恢复传输错误共享当前请求的同一个计数器，不会分别获得两套预算。只有 thinking 的流
仍可重试，后续尝试会抑制重复的 thinking 和 stream envelope；一旦已经输出正文、
tool call 或图片，就不重放。手动取消会立即中断等待；默认隔离模式没有需要保留的 lane 状态。

### Session 级共享恢复开关

```text
/adaptive-share status
/adaptive-share on
/adaptive-share off
/adaptive-share toggle
```

- 新 session、没有共享策略记录的旧 session、`/new` 都默认为 `off`。
- `off` 时，每个请求独立拥有 50 次计数和退避，不读取或写入 ticket、retry-state、
  recovery marker；多个窗口互不等待，也不会触发共享队首断言。
- `on` 时，才启用同一 endpoint + credential lane 的跨进程 FIFO、共享 50 次预算、
  唯一恢复探针和 5 分钟共享 exhaustion 缓存。
- 选择写入当前 session JSONL；`/resume`、branch/tree 恢复和 root/subagent lineage 都会
  恢复该选择。
- 开关在每个请求开始时取值。切换不会迁移或中断已经运行的请求，只影响后续请求。
- `off` 不删除旧窗口仍可能使用的共享状态文件；关闭时忽略它们。若其过期前重新打开，
  新请求可能继续观察到该共享活动或 exhaustion 缓存。
- 状态栏合并显示两个策略，例如 `5xx: retry 50x | shared: off`。
- 本地重试进度不显示队列位置：`TokenKing retry 2/50 [#-----------] transport`。
  共享模式才追加 `q1/2` 等 FIFO 位置。

### Session 级普通 5xx 开关

```text
/adaptive-5xx status
/adaptive-5xx retry
/adaptive-5xx retry-5m
/adaptive-5xx fallback
/adaptive-5xx toggle
```

- 新 session 默认为 `retry`，普通 `502/503/504` 使用当前选择的本地或共享 50 次预算。
- `retry-5m` 从第一次普通 `502/503/504` 开始计算五分钟墙钟窗口，窗口内沿用现有
  分段退避并继续请求当前 provider；任意一次成功就留在当前 provider，五分钟仍失败
  才把最后一个错误交给 OMP fallback。退避跨越 deadline 时只等待剩余时间，不会在
  deadline 后再发一次请求；deadline 到达时仍在途的探测会被中止，并交回此前最后一个
  普通 5xx。正文、tool call 或图片一旦开始就撤销 deadline，正常长回答可继续完成。
  Esc 会取消当前 turn，不触发 fallback；与 deadline 竞态时也以用户取消优先。
- 固定墙钟窗口是 request-local 策略。选择 `retry-5m` 会把当前 session 的
  `/adaptive-share` 设为 `off`；该模式下不能重新打开 shared，必须先选择 `retry` 或
  `fallback`。这样其他窗口和旧共享 campaign 不会延长这五分钟。
- `fallback` 模式下，普通 `502/503/504` 的首次失败直接交给 OMP fallback。
- 选择写入当前 session JSONL；`/resume` 会恢复。fork 的活动分支包含该记录时会继承。
- `/new` 没有旧记录，因此回到默认 `retry`。
- root session 创建的 subagent 沿用 root 当前模式。
- detached 或嵌套 subagent 会按稳定的 artifacts lineage 绑定原 root；即使 UI 后来
  switch 到另一个 session，也不会改用新 session 的策略。
- 三种模式都与共享开关一起持续显示在状态栏。
- 实际进入恢复后，同一个可覆盖的状态槽会显示 provider、`attempt/50` 进度条和错误类型；
  共享模式还显示队列位置。成功、取消或最终失败后清除，
  不会为每次重试叠加通知。只有携带当前交互 session ID 的请求能写入该槽位；
  detached/nested subagent 与缺失 session ID 的后台请求都不抢占 root 窗口的进度。
- `retry-5m` 改用时间进度条，例如
  `AI Input retry 4 [#####-------] 5xx fallback in 3m12s`，长退避和在途探测期间每秒原位刷新。
- `/tree` 跳转到其他历史节点时，会按新活动分支重新恢复策略。
- 开关不影响明确的 concurrency/rate limit、`server_is_overloaded`、
  `stream_read_error`、无 HTTP 状态的 timeout/socket/network failure；即使明确限流或
  server overload 同时带有 `502/503/504`，这些仍使用独立的 50 次预算重试，不会继承
  普通 5xx 的 deadline，普通 5xx 尝试也不会提前消耗这份 50 次预算。
- 开关也不影响鉴权、额度、billing、明确 model unavailable；这些仍立即交给 fallback。
- OMP 切到下一个 fallback provider 后会创建新的 provider 请求；如果它也返回普通
  `502/503/504`，会从自己的第一次普通 5xx 开始计算新的五分钟窗口。

以下协调行为只在 `/adaptive-share on` 时存在。如果同一 endpoint + credential lane 的其他窗口正在执行普通 5xx 恢复活动，
`fallback` session 不加入这份活动，也不会把它标记为 `exhausted`。它独立请求一次，
若仍得到普通 5xx，就只让当前 session 进入 OMP fallback。
如果这次独立请求成功，它会清除自己开始请求时观察到的恢复活动；若其他窗口已把
活动推进到更新状态，则保留更新状态，避免误删并发恢复进度。
所有 retry-state 读写与这次 compare-and-clear 共用跨进程 FIFO 状态锁，因此清理时
不会短暂暴露“无状态”并把并发窗口的 attempt 计数重置为 1。
队列 ticket 与状态锁文件在分配可排序名称和落盘时还会经过原子发布门锁；锁内会根据
当前 lane 的最大存活序号分配下一个序号，不使用各进程基准不同的 `hrtime` 排序。因此
较晚启动的 OMP 进程不会生成更小名称并插到现有 owner 前面。ticket 到达队首后还会在
同一发布锁内稳定为最小队首序号，因而滚动 `/reload` 期间仍运行的旧进程不能挤走活动
owner；旧格式 ticket 可以安全共存。所有旧窗口完成 `/reload` 后，waiter 之间才恢复
严格 FIFO；混跑期间旧 producer 仍可能越过尚未到队首的新版 waiter，但不会再触发
共享状态断言或提前 fallback。
有效元数据中的 PID 仍存活时，不会仅因 heartbeat 时间戳过旧而回收协调文件；这能
避免系统睡眠或 event loop 长暂停后出现两个并行 probe。只有 PID 已退出，或缺损
元数据超过 stale 阈值，才会回收文件。
成功恢复还会保留一个带共享 generation、同时兼容旧 reader 的短期 recovery marker；
这样并发窗口的旧失败即使在成功 owner 已经清理 retry-state 并退出队列后才排到队首，
也不会重新从 attempt 1 开始计数。generation 不依赖跨进程不可比较的 monotonic clock。

### 跨窗口恢复状态

- 仅在当前 session 为 `/adaptive-share on` 时启用。
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
| 输出正文/tool/image 前的 `429`、concurrency、rate limit | 使用当前选择的本地/共享 50 次预算 |
| 普通上游 `502/503/504`，session 为默认 `retry` | 使用当前选择的本地/共享 50 次预算 |
| 普通上游 `502/503/504`，session 为 `retry-5m` | 在当前 provider 本地重试最多五分钟；成功则继续，到期才 fallback |
| 普通上游 `502/503/504`，session 为 `fallback` | 首次失败直接交给 OMP fallback |
| 明确的 `server_is_overloaded` 同义响应 | 三种 5xx 模式都使用当前选择的本地/共享 50 次预算 |
| 输出正文/tool/image 前的 `stream_read_error`、timeout、socket/fetch/network failure、不完整流 | 使用当前选择的本地/共享 50 次预算 |
| `401`、`403`、token revoked | 立即交给 OMP fallback |
| quota、billing、credit、balance exhausted | 立即交给 OMP fallback |
| model unavailable、no capacity、其他非瞬态 `5xx` | 立即交给 OMP fallback |
| 已产生文本、tool call 或图片后的错误 | 不重放，直接结束当前流 |
| 隔离模式第 50 次重试仍失败 | 把最后一次原始错误交给 OMP fallback，不保留共享状态 |
| 共享模式第 50 次重试仍失败 | 把最后一次错误交给 OMP fallback，并缓存 lane exhaustion 5 分钟 |
| 共享 lane exhaustion 缓存期间的新请求或等待者 | 不访问上游，直接交给 OMP fallback |

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
    aiinput2-overseas-queued/*:
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
retry transport；只有 session 执行 `/adaptive-share on` 后才参与同一 endpoint +
credential lane 的共享恢复活动。内置
`kimi-code/*` selector 绕过插件队列，仍使用 OMP 的直接 transport；两者指向同一
Kimi Code 服务，不是相互独立的供应商或账号。

两个 TokenKing selector 使用相同的 `TOKENKING_API_KEY` 和
`https://api.tokenskingdom.com/v1`：

1. `tokenking-queued` 先使用 adaptive retry transport；默认同样是本地 50 次预算。
2. 它失败并进入 selector 冷却后，普通 `tokenking` 仍可执行一次 OMP 原生
   Responses transport 请求。

这不是独立供应商、独立账号或独立线路冗余。TokenKing 服务、账号、Key 或网络路径
整体故障时，两个 selector 都可能失败。第二候选只提供 transport 差异和一次有界尝试，
不会绕过真实的上游故障。

## 冷却与恢复

只有共享模式的 lane exhaustion 会缓存 5 分钟，用于让同一故障域的所有共享窗口停止
探测并快速进入 fallback。默认隔离模式预算耗尽后不写 exhaustion 状态。共享缓存与下面
的 OMP selector 冷却是两套独立状态：前者属于插件、按 endpoint + credential lane
共享；后者属于 OMP、按 model selector 管理。

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

在 OMP session 内检查当前普通 5xx 策略：

```text
/adaptive-5xx status
/adaptive-share status
```

预期结果：

- `retry.maxRetries` 为 `0`。
- `retry.modelFallback` 为 `true`。
- `retry.fallbackRevertPolicy` 为 `cooldown-expiry`。
- queued provider 仍在各自扩展内保持 `maxRetries: 50`。
- `shared` 默认为 `off`；状态栏预期包含 `shared: off`。
- `kimi-code-queued` 列出 7 个模型，并复用内置 `kimi-code` 登录凭据。

`Retry failed after 0 attempts` 表示 OMP 外层没有追加重试，通常意味着当前 fallback
chain 已耗尽、候选处于冷却或候选不可用；它不表示 queued provider 的内部 50 次预算
被执行完。

修改配置或 extension 后，每个已经打开的 OMP 窗口都要执行 `/reload`。不需要关闭
Terminal；磁盘文件更新不会替换窗口里已经加载的旧 JavaScript 模块。
