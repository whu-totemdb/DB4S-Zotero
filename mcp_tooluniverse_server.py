#!/usr/bin/env python3
"""
MCP ToolUniverse HTTP Server (SSE + JSON-RPC) for Zotero plugin.

Compatibility:
- Follows the same protocol shape as `mcp_postgres_server_zotero.py` in this repo:
  - GET  /sse  -> emits an `endpoint` SSE event that contains the POST URL
  - POST /mcp  -> JSON-RPC: `tools/list` and `tools/call`

What it does:
- Exposes two MCP tools:
  1) tooluniverse.find_tools: call ToolUniverse's `Tool_Finder_Keyword`
  2) tooluniverse.call_tool: call an arbitrary ToolUniverse tool by name

Important note (for LLM/tool use):
- The model SHOULD translate user's Chinese input into English before sending it as `query_en`.
  This server does NOT include an embedded translator; it enforces this via tool schema and warnings.

Env vars:
- TOOLUNIVERSE_SERVER_URL (optional): default `https://scp.intern-ai.org.cn/api/v1/mcp/36/ToolUniverse`
- SCP_HUB_API_KEY (required): ToolUniverse access key for header `SCP-HUB-API-KEY`
- API_KEY (optional): if set, require `Authorization: Bearer <API_KEY>` (or `?api_key=`) for this server.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from contextlib import asynccontextmanager
from typing import Any, Dict, Optional

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

try:
    from sse_starlette.sse import EventSourceResponse
except Exception:
    EventSourceResponse = None

try:
    from mcp.client.streamable_http import streamablehttp_client
    from mcp import ClientSession
except Exception as e:
    streamablehttp_client = None
    ClientSession = None
    _MCP_IMPORT_ERROR = e


TOOLUNIVERSE_SERVER_URL = os.getenv(
    "TOOLUNIVERSE_SERVER_URL",
    "https://scp.intern-ai.org.cn/api/v1/mcp/36/ToolUniverse",
)
SCP_HUB_API_KEY = os.getenv("SCP_HUB_API_KEY", "").strip()
API_KEY = os.getenv("API_KEY", "").strip()


def check_auth(request: Request):
    if not API_KEY:
        return
    auth = request.headers.get("Authorization", "")
    if not auth:
        token = request.query_params.get("api_key") or request.query_params.get("token") or ""
        if token:
            auth = f"Bearer {token}"
    if not auth.startswith("Bearer ") or auth.split(" ", 1)[1].strip() != API_KEY:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")


def mcp_text_result(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Return MCP tool result in Zotero-expected shape: {content:[{type:'text',text:'...json...'}]}"""
    return {
        "content": [
            {"type": "text", "text": json.dumps(payload, ensure_ascii=False)}
        ]
    }


def normalize_tool_args(raw_args: Any, body: Dict[str, Any] | None = None) -> Dict[str, Any]:
    # Accept dict or JSON-encoded string; fall back to top-level fields.
    args: Dict[str, Any] = {}
    if isinstance(raw_args, dict):
        args = raw_args
    elif isinstance(raw_args, str):
        try:
            parsed = json.loads(raw_args)
            if isinstance(parsed, dict):
                args = parsed
        except Exception:
            args = {}
    if not args and isinstance(body, dict):
        # Common fields we accept for convenience
        for key in (
            "query_en",
            "query_zh",
            "description",
            "limit",
            "tool_name",
            "arguments",
        ):
            if key in body:
                args[key] = body.get(key)
    return args


FIND_TOOL = "tooluniverse.find_tools"
CALL_TOOL = "tooluniverse.call_tool"

MCP_TOOLS = [
    {
        "name": FIND_TOOL,
        "description": (
            "Find the most suitable ToolUniverse tool(s) via hard keyword matching. "
            "IMPORTANT: translate the user's latest Chinese request (this turn ONLY) to concise English FIRST and pass it as query_en. "
            "Do NOT stuff long context, PDF content, paper metadata, or author lists into query_en—just a short summary of the current user question. "
            "Then this tool will call ToolUniverse's `Tool_Finder_Keyword`. "
            "The end user reads Chinese; when you later answer the user using this tool's result, ALWAYS reply in Simplified Chinese."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query_en": {
                    "type": "string",
                    "description": "English query/keywords (translated from Chinese).",
                },
                "query_zh": {
                    "type": "string",
                    "description": "Optional original Chinese text (for traceability only; not sent to ToolUniverse).",
                },
                "limit": {"type": "integer", "description": "Max candidates, default 5."},
            },
            "required": ["query_en"],
        },
    },
    {
        "name": CALL_TOOL,
        "description": (
            "Call a specific ToolUniverse tool by its exact name with JSON arguments. "
            "Use this AFTER `tooluniverse.find_tools`."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "tool_name": {"type": "string", "description": "Exact ToolUniverse tool name."},
                "arguments": {
                    "type": "object",
                    "description": "Arguments object for that ToolUniverse tool.",
                },
            },
            "required": ["tool_name", "arguments"],
        },
    },
]


class ToolUniverseClient:
    """A minimal MCP client to call the remote ToolUniverse MCP server."""

    def __init__(self, server_url: str, api_key: str):
        self.server_url = server_url
        self.api_key = api_key
        self.transport = None
        self.session_ctx = None
        self.session = None
        self._session_id = None

    async def connect(self):
        if streamablehttp_client is None or ClientSession is None:
            raise RuntimeError(
                f"Missing dependency `mcp` or its http transport. Import error: {_MCP_IMPORT_ERROR}"
            )
        if not self.api_key:
            raise RuntimeError("Missing env var SCP_HUB_API_KEY (ToolUniverse access key).")

        self.transport = streamablehttp_client(
            url=self.server_url,
            headers={"SCP-HUB-API-KEY": self.api_key},
        )
        read, write, get_session_id = await self.transport.__aenter__()
        self._session_id = get_session_id()
        self.session_ctx = ClientSession(read, write)
        self.session = await self.session_ctx.__aenter__()
        await self.session.initialize()

    async def close(self):
        try:
            if self.session_ctx is not None:
                await self.session_ctx.__aexit__(None, None, None)
        finally:
            self.session_ctx = None
            self.session = None
        try:
            if self.transport is not None:
                await self.transport.__aexit__(None, None, None)
        finally:
            self.transport = None

    async def call(self, tool_name: str, arguments: Dict[str, Any]) -> Any:
        if self.session is None:
            await self.connect()
        assert self.session is not None
        return await self.session.call_tool(tool_name, arguments=arguments)


def parse_mcp_tool_result_text(result: Any) -> Any:
    """
    ToolUniverse returns MCP-style result objects; we normalize to JSON if possible.
    """
    try:
        if hasattr(result, "content") and result.content:
            content0 = result.content[0]
            text = getattr(content0, "text", None)
            if isinstance(text, str):
                try:
                    return json.loads(text)
                except Exception:
                    return text
        return result
    except Exception:
        return str(result)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Keep a single client instance; reconnect if needed.
    app.state.tu_client = ToolUniverseClient(TOOLUNIVERSE_SERVER_URL, SCP_HUB_API_KEY)
    yield
    try:
        await app.state.tu_client.close()
    except Exception:
        pass


app = FastAPI(
    title="MCP ToolUniverse HTTP",
    description="MCP HTTP endpoints that proxy to ToolUniverse tools",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    # Does not validate ToolUniverse key to avoid leaking info; checks runtime deps.
    return {
        "status": "ok",
        "tooluniverse_server_url": TOOLUNIVERSE_SERVER_URL,
        "has_scp_hub_api_key": bool(SCP_HUB_API_KEY),
        "has_mcp_dependency": streamablehttp_client is not None,
    }


@app.get("/api/tools/list", dependencies=[Depends(check_auth)])
async def tools_list():
    return {"tools": MCP_TOOLS}


@app.post("/api/tools/call", dependencies=[Depends(check_auth)])
async def tools_call(body: Dict[str, Any]):
    name = (body or {}).get("name", "")
    args = normalize_tool_args((body or {}).get("arguments") or {}, body)
    # Reuse the same handler logic as JSON-RPC
    result = await _handle_tools_call(name, args)
    # For REST, return raw JSON
    if isinstance(result, dict) and "content" in result:
        # unwrap for convenience
        try:
            text = result["content"][0]["text"]
            return json.loads(text)
        except Exception:
            return result
    return result


@app.get("/sse", dependencies=[Depends(check_auth)])
async def handle_sse(request: Request):
    if EventSourceResponse is None:
        raise HTTPException(
            status_code=500,
            detail="Missing dependency: sse-starlette. Please install: pip install sse-starlette",
        )

    async def event_generator():
        yield {"event": "open", "data": "Connected"}
        base_url = str(request.base_url).rstrip("/")
        post_endpoint = f"{base_url}/mcp"
        yield {"event": "endpoint", "data": post_endpoint}

        while True:
            if await request.is_disconnected():
                break
            await asyncio.sleep(15)

    return EventSourceResponse(event_generator())


async def _handle_tools_call(tool_name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    if tool_name == FIND_TOOL:
        query_en = (args.get("query_en") or "").strip()
        query_zh = (args.get("query_zh") or "").strip()
        limit_raw = args.get("limit", 5)
        try:
            limit = int(limit_raw)
        except Exception:
            limit = 5
        limit = max(1, min(20, limit))
        if not query_en:
            raise HTTPException(status_code=400, detail="Missing 'query_en' (English). Please translate Chinese to English first.")

        tu_args = {"description": query_en, "limit": limit}
        try:
            res = await app.state.tu_client.call("Tool_Finder_Keyword", tu_args)
            parsed = parse_mcp_tool_result_text(res)
            return mcp_text_result(
                {
                    "step": "find_tools",
                    "query_en": query_en,
                    "query_zh": query_zh,
                    "limit": limit,
                    "tooluniverse_call": {"tool": "Tool_Finder_Keyword", "arguments": tu_args},
                    "result": parsed,
                    "note_for_model": "Pick the best candidate tool, then call tooluniverse.call_tool with that tool_name and proper arguments.",
                }
            )
        except Exception as e:
            return mcp_text_result(
                {
                    "step": "find_tools",
                    "query_en": query_en,
                    "query_zh": query_zh,
                    "error": f"{type(e).__name__}: {str(e)}",
                }
            )

    if tool_name == CALL_TOOL:
        target = (args.get("tool_name") or "").strip()
        call_args = args.get("arguments") or {}
        if not target:
            raise HTTPException(status_code=400, detail="Missing 'tool_name'")
        if not isinstance(call_args, dict):
            raise HTTPException(status_code=400, detail="'arguments' must be an object/dict")
        try:
            res = await app.state.tu_client.call(target, call_args)
            parsed = parse_mcp_tool_result_text(res)
            return mcp_text_result(
                {
                    "step": "call_tool",
                    "tool_name": target,
                    "arguments": call_args,
                    "result": parsed,
                    "note_for_model": (
                        "The raw result above may be in English or mixed language. "
                        "You MUST analyze and summarize it for the user in Simplified Chinese only. "
                        "If the data is large, highlight key fields, statistics and examples, rather than dumping everything."
                    ),
                }
            )
        except Exception as e:
            return mcp_text_result(
                {
                    "step": "call_tool",
                    "tool_name": target,
                    "arguments": call_args,
                    "error": f"{type(e).__name__}: {str(e)}",
                }
            )

    raise HTTPException(status_code=404, detail=f"Tool {tool_name} not found")


@app.post("/mcp", dependencies=[Depends(check_auth)])
async def handle_mcp(request: Request):
    data = await request.json()
    method = (data or {}).get("method")
    params = (data or {}).get("params", {})
    msg_id = (data or {}).get("id")

    try:
        if method == "tools/list":
            result = {"tools": MCP_TOOLS}
            return {"jsonrpc": "2.0", "id": msg_id, "result": result}

        if method == "tools/call":
            tool_name = (params or {}).get("name")
            args = normalize_tool_args((params or {}).get("arguments", {}) or {}, params)
            tool_result = await _handle_tools_call(tool_name, args)
            return {"jsonrpc": "2.0", "id": msg_id, "result": tool_result}

        raise Exception("Method not supported")
    except HTTPException as he:
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "error": {"code": -32602, "message": he.detail},
        }
    except Exception as e:
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "error": {"code": -32603, "message": str(e)},
        }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=9191)
    args = ap.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="info", reload=False)


if __name__ == "__main__":
    # Make missing deps fail fast with a readable message
    if streamablehttp_client is None or ClientSession is None:
        print("[错误] 缺少 Python 依赖：mcp（以及其 streamable_http 传输）。")
        print(f"       ImportError: {_MCP_IMPORT_ERROR}")
        print("       请先安装依赖：pip install mcp fastapi uvicorn sse-starlette")
        sys.exit(1)
    main()

