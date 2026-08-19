# OMP Provider Retry And Fallback Strategy

记录日期：2026-08-19。当前验证版本：OMP 17.3.5。

## 当前架构

插件不再注册 `aiinput-queued`、`tokenking-queued`、`kimi-code-queued` 等平行
provider。它在 OMP model registry 内透明替换每个模型的内部 transport，再通过模型
原来的 API 发出请求。因此用户继续选择原始模型：

```yaml
modelRoles:
  default: aiinput/gpt-5.6-sol:max
  slow: aiinput/gpt-5.6-sol:max
  plan: aiinput/gpt-5.6-sol:max
  designer: kimi-code/k3:max
  research: tokenking-grok/grok-4.6:high
  perplexity: tokenking-grok/grok-4.6:high
```

```text
normal model selector
  -> adaptive universal transport
  -> original API transport
  -> original credential
  -> AI Input only: Router chooses the attempt base URL
```

这解决了 queued alias 与源 provider 重复、角色配置必须选特殊名称、fallback chain
同时包含两份相同故障域的问题。插件不会修改 API key、OAuth 凭据或模型元数据；只有
`aiinput` request 的模型副本会在 attempt 开始前替换为 Router 选出的白名单 endpoint。

边界：只覆盖 OMP 经 `streamSimple` 调度的模型请求。`web_search`、图片生成专用 HTTP、
MCP、登录、token refresh 和其他独立鉴权请求不经过此 wrapper。

## AI Input Endpoint Router

活动配置只保留一个 `aiinput` provider。每个 request attempt 由 Router 从三个白名单
地址中选择一个：

```text
https://ai.input.im/v1
https://eo.input.codes/v1
https://input.codes/v1
```

Router 的状态只有测量值，不包含错误语义：

```text
latency = 最近最多 8 个有效样本的 EWMA
jitter  = 相邻有效样本延迟差的 EWMA
score   = latency + 1.5 * jitter
```

- 每 30 秒并行请求三个 `/v1/models`，单地址超时 2.5 秒。
- 任何完成且非重定向的 HTTP 响应都是有效延迟样本；Router 不判断其状态码。探针不跟随
  重定向，避免把 API key 转发给其他主机。
- 网络失败、超时或被拒绝的重定向本轮没有 score，等价于无穷大，但不产生 failure、
  cooldown 或熔断。
- auto 模式首次没有缓存时 request 会等待探测；当前 session 的 pin 模式直接使用固定地址。
  之后的 attempt 只读缓存，过期刷新在后台进行。
- 候选地址必须连续两轮比当前首选低至少 20% 才切换，避免 VPN 抖动来回翻转。
- 探针复用 OMP 的 provider proxy 解析，遵循 `PI_PROXY_AIINPUT`、`PI_PROXY`、协议代理和
  `NO_PROXY`；测量路径与模型请求路径一致。
- 并发 request 可以共享同一轮探针，但每个 request 的 Esc 取消互相独立；`/reload`
  会终止旧实例仍在运行的后台探针。
- 路由状态目录不可创建、锁暂时不可用或状态文件不可写时 fail-open 到缓存/配置 URL，
  不会因为遥测故障触发模型 fallback。

错误全部由 Universal Retry 判断。transport failure 或普通 `502/503/504` 会把本次
attempt 使用的地址加入 request-local 排除集合；下一次 attempt 再让 Router 从剩余地址
按 score 选择。`429`、鉴权、额度和模型错误不排除地址。三个地址都被排除后，Retry
清空集合并开始下一轮。Router 不等待退避、不重试请求、不触发 fallback。

多个 OMP 进程共享 `~/.omp/run/adaptive-provider-queue/aiinput-route.json`。文件只保存
URL、样本、score 和自动模式当前首选，不保存 key。pin 保存在当前 session 的 branch
entry 中，不影响其他顶层 OMP session。命令：

```text
/aiinput-route status
/aiinput-route refresh
/aiinput-route auto
/aiinput-route pin <ai|eo|input>
/aiinput-route pin <ai|eo|input> <30m|2h>
```

`ai`、`eo`、`input` 分别对应 `ai.input.im`、`eo.input.codes`、`input.codes`。pin 只接受
白名单别名，防止携带 AI Input key 的探针被改造成任意 URL 请求。可选时长支持
`s/m/h/d`，最长 365 天；不带时长则保持到本 session 执行 `auto`。同一 session tree 的
subagent 继承 pin，其他窗口不受影响。恢复同一个 session 会恢复 pin；使用复制的 branch
entries 创建新 session 或 fork 时，因为 session ID 不同，不会继承 pin。
路由策略属于整个 session，而不是某一条 history branch；在 session tree 中导航不会清除
它。`/fresh`、`/clear`、Advisor、`/btw` 和 `/tan` 生成的 provider 请求 ID 会映射回所属
session，不会因为内部 ID 轮换而静默退回 auto。

pin 有效时，探针仍更新共享样本和 auto 候选，但 Router 忽略 Retry 的 request-local URL
排除，所有 attempt 继续使用固定地址。Retry 仍负责等待、重试预算、stop 和 provider
fallback。到期或执行 `auto` 后立即恢复缓存中的自动首选，不同步等待新探测。

## 默认策略

新 session 和没有保存策略的旧 session 默认：

```text
5xx: retry 50x -> stop | shared: off
```

- 健康状态不设置固定并发上限。
- 请求遇到插件管理的错误后，使用 request-local 的 50 次重试预算。
- 预算指最多 50 次重试，加上初始请求，最坏为 51 次 provider 请求。
- 预算耗尽后结束当前 turn，不进入 OMP fallback。
- 默认不创建跨窗口 queue、ticket 或共享恢复状态。
- Esc 会中断等待和当前请求。

OMP 外层重试必须关闭，避免同一个失败再叠加第二套预算：

```yaml
retry:
  maxRetries: 0
  modelFallback: true
  fallbackRevertPolicy: cooldown-expiry
```

插件内部每次调用原 transport 时也传入 `maxRetries: 0`，因此每个 model request 的
重试归插件单独所有。

## 重试节奏

| 重试编号 | 等待策略 |
|---|---|
| 1-10 | 500 ms 起步的指数退避，单次最高 30 秒 |
| 11-20 | 每次 1 分钟 |
| 21-30 | 每次 2 分钟 |
| 31-40 | 每次 3 分钟 |
| 41-50 | 每次 5 分钟封顶 |

每次延迟带小幅正向 jitter，但不超过五分钟。限流、overload、transport、鉴权、额度
和明确模型不可用等错误共用当前 provider request 的计数器，不会分别获得 50 次。

只有 thinking 的流可以重新尝试，后续 attempt 会抑制重复 thinking 和 stream envelope。
一旦已经产生正文、tool call 或图片，就不重放部分输出。

## 错误路由

| 输出正文/tool/image 前的错误 | 默认行为 |
|---|---|
| `429`、concurrency、rate limit | 本地 50 次预算 |
| 明确 `server_is_overloaded` 或服务器 overloaded 文案，包括 HTTP 500 | 本地 50 次预算 |
| 普通 `502/503/504` | 本地 50 次预算 |
| `stream_read_error`、timeout、socket/fetch/network failure、`Unable to connect`、不完整流 | 本地 50 次预算 |
| `401/402/403`、token revoked/invalid、权限或付款错误 | 本地 50 次预算 |
| quota、billing、credit、balance exhausted | 本地 50 次预算 |
| 明确 model/capacity/route unavailable | 本地 50 次预算 |
| 未分类的普通请求错误，例如一般 `400` 参数错误 | 直接返回 OMP，由 OMP 决定是否 fallback |
| 已经产生正文/tool/image 后的错误 | 不重放，直接结束当前流 |

默认 `retry-stop` 下，表中受管理错误耗尽预算后返回明确的 aborted 终态，OMP 不会
遍历 fallback chain。它不会把永久鉴权或额度错误误判为一定能够自行恢复；这是当前
策略为了避免敏感切换账号而作出的明确取舍，用户仍可 Esc 停止。

## Session 命令

```text
/adaptive-5xx status
/adaptive-5xx list
/adaptive-5xx retry
/adaptive-5xx retry-stop
/adaptive-5xx retry-5m
/adaptive-5xx fallback
/adaptive-5xx toggle
```

- `retry-stop`：默认。所有受管理错误本地重试最多 50 次，耗尽后停止当前 turn。
- `retry`：受管理错误重试最多 50 次，耗尽后把最终原始错误交给 OMP fallback。
- `retry-5m`：普通 `502/503/504` 在当前 provider 上最多重试五分钟，到期后 fallback；
  其他受管理错误仍执行 50 次策略。
- `fallback`：普通 `502/503/504` 首次失败即交给 OMP fallback；其他受管理错误仍执行
  50 次策略。
- `toggle` 顺序为 `retry -> retry-stop -> retry-5m -> fallback -> retry`。

命令名为兼容已有 session history 而保留。模式会写入 session JSONL，由 `/resume`、
branch/tree 和 root/subagent lineage 恢复。`retry-stop` 与 `retry-5m` 强制 shared
为 `off`，避免其他窗口改变本请求的预算或 deadline。

## 可选共享恢复

```text
/adaptive-share status
/adaptive-share on
/adaptive-share off
/adaptive-share toggle
```

默认 `off`：每个请求独立计数，不读写共享状态，多个 OMP 窗口互不等待。

`on`：同一 provider account lane 的多个 OMP 进程使用 FIFO，共享一次 50 次恢复
campaign，只有队首请求探测上游。AI Input 的三个 URL 在同一个 credential 下共用一条
lane，其他 provider 仍按 endpoint + credential 建 lane。成功、开始实质输出或正常完成
会清除共享状态；预算耗尽会缓存 lane exhaustion 五分钟，让等待者直接进入 fallback。
队首取消或进程退出时，下一位存活队首继承已有计数，不从 0 开始。

共享状态只保存 hashed lane identity、attempt、时间、owner 和失败分类，不保存 raw
credential。运行时目录为 `~/.omp/run/adaptive-provider-queue/`，目录权限 `0700`，
状态文件权限 `0600`。共享关闭时不会读取或更新这些文件。

## Fallback chain

fallback 只需要真实的独立候选，不再串联同一 provider 的 queued 和非 queued selector：

```yaml
retry:
  fallbackChains:
    aiinput/*:
      - tokenking/gpt-5.6-sol:max
    kimi-code/*:
      - aiinput/gpt-5.6-sol:max
    tokenking-grok/*:
      - aiinput/gpt-5.6-sol:max
```

fallback provider 也会经过 universal retry wrapper，并从自己的 policy budget 开始。
默认 `retry-stop` 通常会在主 provider 上结束 turn；只有未分类错误、显式切到会 fallback
的模式，或其他 OMP fallback 条件才会进入 chain。

OMP 的 `fallbackRevertPolicy: cooldown-expiry` 会在主 selector 冷却结束后，于后续请求
边界恢复主模型。不会把 fallback 已输出到一半的回答切回主模型。

## Status probe 边界

Personal xbar 的 `https://status.input.im/api/status` 只作为人工可观测信号，不参与 Router、
Retry 或 fallback。地址选择只看本机 `/v1/models` 探测得到的 latency + jitter；错误后的
等待、换地址和停止只看当前模型请求的实际失败。

## 诊断

```bash
omp config get retry.maxRetries
omp config get retry.modelFallback
omp config get retry.fallbackRevertPolicy
omp config get retry.fallbackChains --json
omp models --json
```

预期：

- `retry.maxRetries` 为 `0`。
- `retry.modelFallback` 为 `true`。
- roles 和 fallback chains 只包含原始 provider selector。
- `omp models --json` 不包含名称以 `-queued` 结尾的 provider。
- 活动 registry 只有 `aiinput`，没有 `aiinput-overseas`。
- 新 session 的 `/adaptive-5xx status` 为 `retry-stop`，`/adaptive-share status` 为 `off`。

修改 extension 后，每个已打开的 OMP 窗口必须执行 `/reload` 或完全重启。磁盘文件更新
不会替换窗口内已经加载的 JavaScript 模块。若旧 session 当前仍固定在已删除的 queued
selector，reload 后手动选择对应的原始 provider。
