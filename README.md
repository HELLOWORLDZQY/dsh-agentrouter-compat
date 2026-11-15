# dsh-agentrouter-compat

独立的 **DeepSeek Harness (DSH) Host 插件**，提取 AgentRouter Responses 的跨资源 HTTP 400 修复。不 fork 整套路由插件，也不再通过脚本改写 `node_modules`。

**修复目标**：工具循环的后续请求携带另一个上游资源创建的 Responses item ID，出现：

```text
400 invalid_request_error
The requested item was created under a different ... OpenAI resource.
Use the same resource that created the item to access it.
```

> 这不是“所有 400 的通用修复”。必须使用完整内联历史的 Responses 请求。原 AgentRouter 路由和它使用的凭据仍然需要配置。

## 安装

在 DSH 的 **插件（Plugins）→ 添加插件（Add plugin）** 中填入：

```text
github:HELLOWORLDZQY/dsh-agentrouter-compat
```

安装并启用 **AgentRouter Responses 兼容补丁**。不需要额外 API Key，不会自动安装或替换 `dsh-llm-agentrouter`，也不会修改模型列表。版本更换后，若插件管理器提示需要重启，请按提示重启 DSH，然后用新会话验证。

也可克隆仓库，在同一入口安装本地目录：

```sh
git clone https://github.com/HELLOWORLDZQY/dsh-agentrouter-compat.git
```

项目为直接运行的 JavaScript，无构建步骤、安装脚本或遥测。尚未发布到 npm，请使用上面的 GitHub 来源，而不是裸 npm 包名。

### 从旧的手工补丁迁移

1. 安装本插件并验证新的工具循环。
2. **独立插件不会删除已有手工补丁，也不会改写你的重启脚本。** 两个修复同时存在时，清理操作幂等，但关闭本插件不代表旧补丁也被关闭。
3. 需要彻底迁移时，先备份，再由你停用旧的自动注入脚本，并通过 DSH 插件管理器重新安装干净的原 AgentRouter 插件；不要删除模型配置和凭据。
4. **重启 DSH**，用新会话再验证。仅重新加载本插件不能证明进程中的原路由代码已经换新。

## 实际改动

只对命中目标的、字符串 `init.body` 中的 JSON 生效：

| 移除 | 保持原样 |
| --- | --- |
| 顶层 `previous_response_id` | `call_id`：工具调用与输出的配对键 |
| `input` 各项的字符串 `id`（如 `msg_` / `fc_` / `rs_` / `ctc_`） | 正文、工具名称、参数和输出、顺序 |
| `input` 中的 `item_reference` 项 | `encrypted_content`、reasoning summary、phase/status/annotations |
| 已失效的请求头 `Content-Length`（由传输层重新计算） | 嵌套的 `id`、`file_id`、工具 schema、模型选项及其他头 |

不添加模型调用或重试，不吞掉错误，不接管 URL、User-Agent、代理或原路由插件的直连传输，也不修改 DSH 会话事件。

### 重要限制

- **只有完整内联的历史才能安全去掉引用。** `previous_response_id` 或 `item_reference` 指向的服务端内容不会被下载或还原；若请求依赖这些引用来保存历史，本插件会使它缺失，请勿启用。ID-only、文件 ID、conversation ID 等服务端依赖也不在修复范围内。
- `encrypted_content` 保留不动；若上游不能跨资源解密，本插件不会自动删掉密文或用重试隐藏该错误。
- 仅检查字符串 `init.body`。裸 `Request`、ReadableStream、Blob、FormData、二进制或压缩请求体原样委托，不读取或缓冲。`Request` 搭配**需要清理的字符串覆盖体**会转换为 URL + 有效 RequestInit，保留其方法、头和取消信号，避免原路由插件覆盖该 body。
- 未命中主机、路径或 POST 方法，以及 Chat Completions 请求，保持原样。默认不改写 HTTP 或带 URL 用户信息的请求。使用正文签名的自定义请求不受支持。
- 在当前 DSH 的 `llm/stream` 入口恢复兼容层的外层位置，以覆盖原路由插件的 direct 分支。它适用于当前每次调用创建客户端的 SDK；不能保证任意第三方缓存的 transport 或请求中途重载的路由。
- 本插件停用后，自己的所有 wrapper 都停止清理，即使仍被其他插件引用。**原路由插件自身的旧 wrapper 生命周期不由本插件修复**；更改原路由插件的启停或包版本后，请重启 DSH，避免旧路由仍被调用。只允许一个本插件实例。
- 默认 sentinel 信任现有 AgentRouter 路由的目的地配置。本插件的 host 白名单只决定改写范围，不是网络安全策略。

## 配置

默认处理 **HTTPS + POST + `/v1/responses`**，host 精确匹配，不使用域名后缀或通配符：

```text
relay.agentrouter.internal
agentrouter.org
ps.air-outer.com
```

更换自建中转地址时，可在 DSH 的配置编辑器中修改本插件 entry；不要替换 `llm-pi-ai` 配置。以下是自己的 profile patch 覆盖示例：

```yaml
- id: agentrouter-responses-compat
  config:
    hosts:
      - relay.agentrouter.internal
      - agentrouter.org
      - ps.air-outer.com
      - my-relay.example:8443
    paths:
      - /v1/responses
    allowHttp: false
    announce: true
```

`hosts` 是主机名（可含端口），不能填整段 URL；`paths` 是精确 URL pathname，不含查询串。非默认端口需明确列出。`allowHttp` 仅用于可信本地测试，生产环境应保持 `false`。`announce` 只控制启用日志，不记录请求正文、头或密钥。此插件没有自定义 Settings 页面。

## 兼容性与验证

- 目标/验证环境：**DSH 0.2.2-rc.3、Cordis 4.1.0、Node.js 24.20.0**；声明最低 Node.js 24.9.0。
- 对照的原路由插件：`dsh-llm-agentrouter` **2.6.1**。本插件不导入其私有函数，也不依赖旧脚本注入的导出。
- 离线回归覆盖内容保真、精确范围、幂等、Request 覆盖、取消信号、直连绕过、加载顺序和停用清理；真实 AgentRouter 上游可用性、余额及解密兼容性不属于离线测试保证。
- 没有浏览器自动化验证；插件图标与中英文元数据随包提供，实际界面渲染需在 DSH 中确认。

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run pack:check
```

测试使用构造的请求，不需要模型密钥，不发送真实对话。CI 同样不需要 secrets。

在 DSH 提供的 shell 中还可运行以下可选检查，使用当前安装的 OpenAI SDK 与完全内存化的假上游，验证 **原请求 400 → 启用后 200 → 停用后 400**，同时检查没有额外重试：

```sh
npm run verify:installed
```

它不连接真实 AgentRouter，也不读取真实密钥。此检查已在上面列出的 DSH 环境通过；不等同于真实上游端到端验证。

## 设计

[纯补丁函数](./lib/compat.js)只改出站副本；[fetch 适配器](./lib/fetch.js)限制改写范围并保留原传输；[生命周期](./lib/lifecycle.js)管理 wrapper；[Host 入口](./index.js)用 `ctx.effect` 和 `llm/stream` 注册/卸载，不改只读消息。

DSH 0.2.2-rc.3 的 LLM 请求由会话日志重建，`llm/stream` 的 `next()` 不能替换它。底层 pi-ai 虽然有 `onPayload`，当前 DSH 适配器并未公开该接口，因此在序列化后的 fetch 边界进行兼容处理。

本插件源自本地 Responses item-ID 修复，受 [dsh-llm-agentrouter](https://github.com/aqiu817/dsh-llm-agentrouter) 的传输边界启发；不是原插件的官方版本，也没有复制其模型路由、凭据处理、User-Agent 或代理实现。

## English summary

A standalone DSH Host bundle for AgentRouter's **Responses cross-resource replay HTTP 400**. It removes resource-bound input item IDs, `previous_response_id`, and `item_reference` entries from matching serialized requests, while retaining tool `call_id` pairing, inline content and encrypted reasoning. It does not patch installed files, replace routes, add retries, or require another API key.

Install `github:HELLOWORLDZQY/dsh-agentrouter-compat` in **Plugins → Add plugin**, alongside your existing AgentRouter route. Requires **full inline history**; stored-reference-only conversations cannot be reconstructed. Existing manual patches must be migrated separately. Restart DSH after changing the original routing plugin's activation state. Streamed/non-string request bodies are not rewritten. Tested against DSH 0.2.2-rc.3; live upstream and rendered UI checks are not guaranteed by offline tests.

## License

[MIT](./LICENSE). The icon is original artwork distributed under the same license.
