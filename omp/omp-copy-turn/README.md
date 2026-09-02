# OMP Copy Turn

在一轮 OMP 回答完整结束后，在编辑器上方显示：

```text
[复制本轮问答] Ctrl+X · F6 · /copy-turn
```

按 `Ctrl+X`、`F6` 或执行 `/copy-turn`，会把最近一轮内容以 Markdown 复制到系统剪贴板。Mac 键盘若把功能键用于媒体控制，请按 `Fn+F6`：

```markdown
## Question

用户问题

## Answer

最终回答
```

插件只复制人类用户输入和最终 assistant 文本，不包含 thinking、tool call、tool result、系统消息或 Agent 自动续跑提示。自动 retry/continuation 尚未结束时不会提前更新可复制内容。

执行 `/resume`、切换 session、fork 或重启后，插件会从当前 session branch 恢复最近一轮问答，无需等待模型再回答一次。

OMP 当前的公开 Extension API 没有 assistant 消息尾部鼠标 action 插槽，因此该操作条通过公开的 widget 和 shortcut API 实现：位置紧邻回答尾部，但需要键盘快捷键或 slash command 触发，不是鼠标点击热区。

## 安装

安装整个 bundle 时会自动加载本插件。开发时也可以单独安装：

```bash
omp plugin link /path/to/pi-omp-plugin-bundle/omp/omp-copy-turn
```

安装后重启 OMP；已打开的窗口可执行 `/reload`。
