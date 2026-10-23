# dsh-plugin-mcp-switch

按需开关 MCP 服务器的 DSH 插件：**默认全部断开**，不加载工具、不占用上下文；需要时再打开。

## 七个 agent 工具

| 工具 | 作用 |
|---|---|
| `mcp_switch_list` | 列出服务器、状态、**上下文成本**（工具数 / 约多少 tokens）、启动策略、分组 |
| `mcp_switch_on` | 打开（连接）；`name: "all"` 全开；重服务器需 `confirm: true` |
| `mcp_switch_off` | 断开；`name: "all"` 全断 |
| `mcp_switch_add` | 新增（stdio / streamable-http），env 与 headers 支持 `${VAR}`，token 不落盘 |
| `mcp_switch_remove` | 删除（先断开再移出配置） |
| `mcp_switch_policy` | 读/写 `mode` 与 `reclaimOnSessionEnd` |
| `mcp_switch_group` | 分组预设：list / save / apply / delete |

## 设置页

左下角齿轮 → **MCP 开关**（`settings.section`，order 55，列表末尾）：
启动策略下拉 + 「会话结束自动回收」勾选 + 分组按钮 + 每行（状态 / 成本 / 连接·断开）。

## 启动策略

| `startupMode` | 重启后 | 切换时 |
|---|---|---|
| `always-off`（默认） | 一律断开 | 立即断开全部 |
| `remember` | 恢复上次状态 | 不动当前运行时 |
| `auto-start` | 只连 `autoStart: true` 的 | 连上自启的、断开其余 |

## 上下文成本

连接成功后统计 `mcp__<名称>__*` 的模型可见 schema 体积，估算 tokens 并写回状态文件，断开后仍可显示。
实测（本机）：`rea` 约 86 万 tokens、`windows-mcp` 6.5k、`open-design` 6.0k、`cad` 0.3k。

**重服务器保护**：已知成本 ≥ 10 万 tokens 的服务器（如 `rea`），`mcp_switch_on` / 分组 apply / 设置页「连接」都会先拒绝，要求 `confirm: true`（设置页会提示改用 agent 工具确认）。

## 会话结束自动回收

每个被打开的服务器记住是哪个会话打开的（`openedBy`）。该会话的 agent 被 dispose 时（`agent/disposed` 事件），自动断开并落盘。子代理开的 MCP 随子代理结束回收。可用 `mcp_switch_policy { reclaimOnSessionEnd: false }` 关闭。

## 分组预设

```
mcp_switch_group { action: "save", name: "逆向", servers: ["rea"] }
mcp_switch_group { action: "apply", name: "逆向" }        // 组内连上、组外断开
mcp_switch_group { action: "list" }
```

## 状态文件

`~/.dsh/mcp-switch.json`，**原子写**（写 `.tmp` → rename），每次保存前把上一版复制到 `.bak`。

```json
{
  "startupMode": "always-off",
  "reclaimOnSessionEnd": true,
  "groups": { "逆向": ["rea"] },
  "servers": [
    { "id": "…", "name": "rea", "transport": "stdio", "enabled": false, "autoStart": false,
      "cost": { "tools": 207, "bytes": 3087942, "tokens": 857762 },
      "config": { "command": "…", "args": [], "env": {}, "cwd": "" } }
  ]
}
```

首次启动若该文件不存在，会从 `~/.dsh/mcp-console.json` 迁移（全部置为断开）。

## 实现要点

- `@deepseek-ai/dsh-mcp-client` 在 dsh 安装目录的 `app.asar` 内，profile 安装的插件**不能**用裸包名静态 import（开机加载会 `failed to import`）。这里用 `process.resourcesPath` + `pathToFileURL` 按绝对路径动态导入。
- 每个 MCP 通过 `ctx.plugin(mcpClient, config)` 动态挂载，断开时 `fiber.dispose()`；同一服务器的启停串行化，避免 `serverName already in use`。
- `env` / `headers` 的 `${VAR}` 在启动时从进程环境解析，密钥不写进状态文件。
- `/mcp-switch/api/*` 挂在宿主 webServer 上但不受宿主鉴权保护，因此自带同源 + `sec-fetch-site` + 回环 + Host 校验（防跨站开关 MCP、防 DNS rebinding），请求体上限 64KB。

## 安装

```js
plugin_manager install_bundle  target: <这个目录的绝对路径>
```
