#!/usr/bin/env python3
import os, argparse
import asyncpg
import sys
import asyncio
from typing import Any, Dict
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, HTTPException, status, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

# env: DB_URL, API_KEY(optional)
DB_URL = os.getenv(
    "DB_URL",
    "postgresql://postgres:postgres@10.254.22.26:5432/postgres"
)  # 默认直连内网 PG，可用隧道/VPN 时改为 127.0.0.1:<local_port>
API_KEY = os.getenv("API_KEY", "")  # 若设置则要求 Authorization: Bearer <API_KEY>

# 连接池配置
DB_TIMEOUT = int(os.getenv("DB_TIMEOUT", "10"))  # 连接超时（秒）
DB_MAX_SIZE = int(os.getenv("DB_MAX_SIZE", "10"))  # 最大连接数
DB_MIN_SIZE = int(os.getenv("DB_MIN_SIZE", "2"))  # 最小连接数

TOOL_NAME = "sql_query"

async def run_sql(pool, sql: str):
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(sql)
            return [dict(r) for r in rows]
    except asyncpg.exceptions.PostgresError as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"数据库错误: {str(e)}"
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"查询执行失败: {str(e)}"
        )


def ensure_readonly(sql: str):
    """
    粗粒度只读校验：仅允许以 SELECT/with 开头的查询。
    更强保障仍依赖数据库侧只读角色 + default_transaction_read_only。
    """
    s = sql.strip().lower()
    if not s.startswith("select") and not s.startswith("with"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="只允许查询语句（SELECT / WITH）"
        )

@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动时创建连接池
    print(f"[启动] 正在连接到数据库: {DB_URL.split('@')[1] if '@' in DB_URL else '未知'}")
    print(f"[启动] 连接超时: {DB_TIMEOUT}秒, 连接池大小: {DB_MIN_SIZE}-{DB_MAX_SIZE}")
    
    try:
        app.state.pool = await asyncpg.create_pool(
            DB_URL,
            min_size=DB_MIN_SIZE,
            max_size=DB_MAX_SIZE,
            command_timeout=DB_TIMEOUT,
            timeout=DB_TIMEOUT,
            server_settings={
                'application_name': 'mcp_postgres_server'
            }
        )
        
        # 测试连接
        async with app.state.pool.acquire() as conn:
            version = await conn.fetchval("SELECT version()")
            print(f"[启动] 数据库连接成功！PostgreSQL 版本: {version.split(',')[0] if version else '未知'}")
            
    except asyncio.TimeoutError:
        print(f"[错误] 连接数据库超时（{DB_TIMEOUT}秒）")
        print(f"[提示] 请检查：")
        print(f"  1. 网络连通性: ping 10.254.22.26")
        print(f"  2. 端口是否开放: telnet 10.254.22.26 5432")
        print(f"  3. 是否需要通过 SSH 隧道或 VPN 连接")
        print(f"  4. 数据库地址和端口是否正确")
        print(f"  5. 如果使用隧道，请将 DB_URL 改为: postgresql://user:pass@127.0.0.1:<本地端口>/dbname")
        sys.exit(1)
    except asyncpg.exceptions.InvalidPasswordError:
        print(f"[错误] 数据库密码错误")
        print(f"[提示] 请检查 DB_URL 中的用户名和密码")
        sys.exit(1)
    except asyncpg.exceptions.InvalidCatalogNameError:
        print(f"[错误] 数据库不存在")
        print(f"[提示] 请检查 DB_URL 中的数据库名称")
        sys.exit(1)
    except Exception as e:
        print(f"[错误] 连接数据库失败: {type(e).__name__}: {str(e)}")
        print(f"[提示] 请检查数据库配置和网络连接")
        sys.exit(1)
    
    yield
    
    # 关闭时清理连接池
    print("[关闭] 正在关闭数据库连接池...")
    try:
        await app.state.pool.close()
        print("[关闭] 连接池已关闭")
    except Exception as e:
        print(f"[警告] 关闭连接池时出错: {e}")

app = FastAPI(
    title="MCP Postgres HTTP",
    description="HTTP endpoints for executing SQL on PostgreSQL",
    version="1.0.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"]
)

def check_auth(request: Request):
    if not API_KEY:
        return
    auth = request.headers.get("Authorization", "")
    if not auth:
        token = request.query_params.get("api_key") or request.query_params.get("token") or ""
        if token:
            auth = f"Bearer {token}"
    if not auth.startswith("Bearer ") or auth.split(" ",1)[1].strip() != API_KEY:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")

class SQLBody(BaseModel):
    sql: str

@app.get("/health")
async def health():
    """健康检查，包含数据库连接状态"""
    try:
        if not hasattr(app.state, 'pool') or app.state.pool is None:
            return {"status": "error", "message": "数据库连接池未初始化"}
        
        async with app.state.pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        return {"status": "ok", "database": "connected"}
    except Exception as e:
        return {
            "status": "error",
            "message": "数据库连接失败",
            "error": str(e)
        }

@app.get("/api/tools/list", dependencies=[Depends(check_auth)])
async def tools_list():
    return {
        "tools":[
            {
                "name": TOOL_NAME,
                "description": "Execute a SQL query on PostgreSQL and return rows.",
                "inputSchema": {
                    "type":"object",
                    "properties":{"sql":{"type":"string"}},
                    "required":["sql"]
                }
            }
        ]
    }

@app.post("/api/tools/call", dependencies=[Depends(check_auth)])
async def tools_call(body: Dict[str, Any]):
    name = (body or {}).get("name","")
    args = ((body or {}).get("arguments") or {})
    if name != TOOL_NAME:
        raise HTTPException(status_code=404, detail="Tool not found")
    sql = (args.get("sql") or "").strip()
    if not sql:
        raise HTTPException(status_code=400, detail="Missing 'sql'")
    ensure_readonly(sql)
    rows = await run_sql(app.state.pool, sql)
    return {"rows": rows}

@app.post("/api/sql_query", dependencies=[Depends(check_auth)])
async def sql_query(body: SQLBody):
    sql = body.sql.strip()
    ensure_readonly(sql)
    rows = await run_sql(app.state.pool, sql)
    return {"rows": rows}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="info", reload=False)

if __name__ == "__main__":
    main()