# AgentRouter 400 修复插件

`dsh-agentrouter-compat` 是一个独立的 **DeepSeek Harness（DSH）插件**，用于修复 AgentRouter 调用 OpenAI Responses API 时，因历史项绑定不同上游资源而产生的 HTTP 400 错误。

## 用途

在连续对话或工具调用过程中，模型返回的历史项可能带有 `msg_`、`fc_`、`rs_` 等服务端 ID。这些 ID 属于创建它们的上游资源。

当后续请求被分配到另一个上游资源时，携带这些 ID 的历史项可能被拒绝，出现：

```text
400 invalid_request_error
The requested item was created under a different ... OpenAI resource.
Use the same resource that created the item to access it.
```

本插件在请求发出前清理这类资源绑定引用，让完整内联的历史内容不再依赖这些旧资源句柄，从而解决这一原因导致的 400 报错。

## 工作原理

### 1. 识别目标请求

插件在 DSH 的模型请求流程中注册 HTTP 请求处理层，只检查符合条件的出站 JSON 请求。

默认匹配 **HTTPS、POST、`/v1/responses`**，并精确匹配以下主机：

- `agentrouter.org`
- `ps.air-outer.com`
- `relay.agentrouter.internal`

主机和路径可以配置。不符合条件的请求原样发送。

### 2. 清理资源绑定引用

解析字符串形式的请求体后，执行三项处理：

- 删除顶层的 `previous_response_id`。
- 删除 `input` 各项中的字符串 `id`。
- 移除 `input` 中的 `item_reference` 引用项。

处理只针对这些指定位置，不会递归删除正文或工具参数里的同名字段。

### 3. 保留实际内容

以下内容保持不变：

- 对话正文及历史项顺序。
- 工具名称、参数和执行结果。
- 用于配对工具调用与结果的 `call_id`。
- `encrypted_content`、推理摘要及其他内容字段。
- 嵌套的 `id`、`file_id` 和工具参数 schema。

### 4. 发送处理后的请求

只有内容发生变化时才重新序列化 JSON，并移除旧的 `Content-Length`，由传输层重新计算长度。无需修改时保留原始请求。

插件沿用原有的请求地址、认证信息和传输方式，不增加模型调用、不自动重试，也不改写 DSH 的会话记录。停用后停止请求改写。

**使用前提：请求必须包含完整的内联历史。** 插件不会下载或还原 `previous_response_id`、`item_reference` 指向的服务端内容；依赖这些引用保存历史的请求不适用。流式、二进制及压缩请求体不会被读取或改写。此插件针对资源绑定引用导致的 400，不处理其他原因的请求错误。
