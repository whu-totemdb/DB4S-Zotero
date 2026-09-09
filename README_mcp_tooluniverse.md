# MCP ToolUniverse Server（给 Zotero 插件用）

这个仓库的 Zotero 侧 MCP 客户端使用 **SSE + JSON-RPC** 协议（见 `src/modules/mcp.ts`）。
因此本服务也采用同样的形式：

- `GET /sse`：返回 SSE 流，并通过 `endpoint` 事件告知真实的 POST 地址
- `POST /mcp`：JSON-RPC，支持 `tools/list` 与 `tools/call`

服务代码：`mcp_tooluniverse_server.py`（默认端口 **9191**）。

## 1) 安装依赖

```bash
pip install -r requirements_mcp_tooluniverse.txt
```

## 2) 设置环境变量

必须：

- `SCP_HUB_API_KEY`: ToolUniverse 的访问密钥（HTTP Header: `SCP-HUB-API-KEY`）

可选：

- `TOOLUNIVERSE_SERVER_URL`: 默认 `https://scp.intern-ai.org.cn/api/v1/mcp/36/ToolUniverse`
- `API_KEY`: 如果设置了，本服务会要求请求携带 `Authorization: Bearer <API_KEY>`（或 `?api_key=`）

Windows (PowerShell) 示例：

```powershell
$env:SCP_HUB_API_KEY="sk-xxx"
```

## 3) 启动（监听 9191）

```bash
python mcp_tooluniverse_server.py --host 0.0.0.0 --port 9191
```

健康检查：

```bash
curl http://127.0.0.1:9191/health
```

## 4) Zotero AI 设置里配置 MCP Servers

在 Zotero 的 AI 设置 → MCP Servers（具体 UI 以你插件为准），添加：

- **Name**: ToolUniverse
- **URL**: `http://127.0.0.1:9191/sse`
- **API Key**: （可选）填你为本服务设置的 `API_KEY`，不是 ToolUniverse 的 key

> ToolUniverse 的 `SCP_HUB_API_KEY` 是给服务端用的，请在服务端环境变量里配置。

## 5) 工具与“中文→英文”约束

本服务提供两个 MCP tools：

- `tooluniverse.find_tools`：内部调用 ToolUniverse 的 `Tool_Finder_Keyword`
  - **要求模型先把用户中文翻译为英文**，放入参数 `query_en`
- `tooluniverse.call_tool`：调用具体 ToolUniverse tool（由模型在前一步挑选后再调用）

服务端不会内置翻译器；翻译与最终中文总结由大模型负责（这也更符合 Zotero 侧 agent 的工作流）。

