#!/usr/bin/env python3
import os, argparse
import re
import asyncpg
import sys
import asyncio
import json
from typing import Any, Dict
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, HTTPException, status, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

try:
    from sse_starlette.sse import EventSourceResponse
except Exception:
    EventSourceResponse = None

# env: DB_URL, API_KEY(optional)
DB_URL = os.getenv(
    "DB_URL",
    "postgresql://postgres:postgres@10.254.22.26:5432/SciSciNetV2"
)  # 默认直连内网 PG，可用隧道/VPN 时改为 127.0.0.1:<local_port>
API_KEY = os.getenv("API_KEY", "")  # 若设置则要求 Authorization: Bearer <API_KEY>

# 连接池配置
DB_TIMEOUT = int(os.getenv("DB_TIMEOUT", "10"))  # 连接超时（秒）
_DB_COMMAND_TIMEOUT_RAW = os.getenv("DB_COMMAND_TIMEOUT", "").strip()
if _DB_COMMAND_TIMEOUT_RAW:
    try:
        DB_COMMAND_TIMEOUT = int(_DB_COMMAND_TIMEOUT_RAW)
        if DB_COMMAND_TIMEOUT <= 0:
            DB_COMMAND_TIMEOUT = None
    except ValueError:
        DB_COMMAND_TIMEOUT = None
else:
    DB_COMMAND_TIMEOUT = None
DB_MAX_SIZE = int(os.getenv("DB_MAX_SIZE", "10"))  # 最大连接数
DB_MIN_SIZE = int(os.getenv("DB_MIN_SIZE", "2"))  # 最小连接数
AUTHOR_TITLE_TIMEOUT_MS = int(os.getenv("AUTHOR_TITLE_TIMEOUT_MS", "0"))
_AUTHOR_TITLE_COMMAND_TIMEOUT_RAW = os.getenv("AUTHOR_TITLE_COMMAND_TIMEOUT", "").strip()
if _AUTHOR_TITLE_COMMAND_TIMEOUT_RAW == "":
    _author_timeout = 10
else:
    try:
        _author_timeout = int(_AUTHOR_TITLE_COMMAND_TIMEOUT_RAW)
    except ValueError:
        _author_timeout = 0
AUTHOR_TITLE_COMMAND_TIMEOUT = _author_timeout if _author_timeout > 0 else None
AUTHOR_TITLE_DISABLE_TIMEOUTS = os.getenv("AUTHOR_TITLE_DISABLE_TIMEOUTS", "1").strip() in ("1", "true", "True", "yes", "YES")
ENABLE_FUZZY_TITLE_SEARCH = os.getenv("ENABLE_FUZZY_TITLE_SEARCH", "0").strip() in ("1", "true", "True", "yes", "YES")
FORCE_FUZZY_TITLE_SEARCH = os.getenv("FORCE_FUZZY_TITLE_SEARCH", "0").strip() in ("1", "true", "True", "yes", "YES")
FORCE_KEYWORD_TITLE_SEARCH = os.getenv("FORCE_KEYWORD_TITLE_SEARCH", "0").strip() in ("1", "true", "True", "yes", "YES")

TOOL_NAME = "sql.query"
MCP_TOOLS = [
    {
        "name": TOOL_NAME,
        "description": "Execute a SQL query, or resolve author IDs/papers by title, keyword, author name, or paperid (SciSciNetV2).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "sql": {"type": "string"},
                "title": {"type": "string"},
                "mode": {"type": "string", "description": "Use 'authors_by_title' to resolve author IDs for a title. Use 'authors_by_title_keyword' to resolve author IDs by keyword search from the title. Use 'authors_by_name_and_title' to resolve author IDs by author name plus title keywords. Use 'papers_by_title' to return matching paper candidates. Use 'papers_by_title_exact' for exact title match only. Use 'papers_by_keyword' to search papers by a single keyword. Use 'authors_by_paperid' to resolve author IDs from a paperid list."},
                "paperid": {"type": "string"},
                "paperids": {"type": "array", "items": {"type": "string"}},
                "author_name": {"type": "string"},
                "keyword": {"type": "string"}
            }
        }
    }
]

def format_error(prefix: str, err: Exception) -> str:
    msg = str(err).strip()
    if not msg:
        msg = repr(err)
    return f"{prefix}: {type(err).__name__}: {msg}"

async def run_sql(pool, sql: str):
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(sql)
            return [dict(r) for r in rows]
    except asyncpg.exceptions.PostgresError as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=format_error("数据库错误", e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=format_error("查询执行失败", e)
        )

async def run_sql_params(pool, sql: str, *args):
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(sql, *args)
            return [dict(r) for r in rows]
    except asyncpg.exceptions.PostgresError as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=format_error("数据库错误", e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=format_error("查询执行失败", e)
        )

async def run_sql_params_with_timeout(pool, timeout_ms: int, sql: str, *args):
    try:
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(f"SET LOCAL statement_timeout = '{int(timeout_ms)}ms'")
                rows = await conn.fetch(sql, *args)
                return [dict(r) for r in rows]
    except asyncpg.exceptions.PostgresError as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=format_error("数据库错误", e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=format_error("查询执行失败", e)
        )

async def run_sql_params_with_command_timeout(pool, timeout_s: int | None, sql: str, *args):
    try:
        async with pool.acquire() as conn:
            if timeout_s is None:
                rows = await conn.fetch(sql, *args)
            else:
                rows = await conn.fetch(sql, *args, timeout=max(1, int(timeout_s)))
            return [dict(r) for r in rows]
    except asyncio.TimeoutError as e:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail=format_error("查询超时", e)
        )
    except asyncpg.exceptions.PostgresError as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=format_error("数据库错误", e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=format_error("查询执行失败", e)
        )

def normalize_title_input(title: str) -> str:
    return " ".join(title.split()).strip()

def build_title_variants(title: str) -> list[str]:
    raw = title.strip()
    normalized = normalize_title_input(title)
    variants = []
    if raw:
        variants.append(raw)
    if normalized and normalized not in variants:
        variants.append(normalized)
    return variants

def build_title_patterns(title: str) -> tuple[str, str, str]:
    normalized = normalize_title_input(title)
    tokens = [t for t in normalized.lower().split() if t]
    prefix_pattern = (tokens[0] + "%") if tokens and len(tokens[0]) >= 3 else ""
    fuzzy_pattern = "%" + "%".join(tokens) + "%" if tokens else "%" + normalized.lower() + "%"
    return normalized, prefix_pattern, fuzzy_pattern

def extract_keywords(title: str, max_terms: int = 6) -> list[str]:
    tokens = re.findall(r"[a-zA-Z0-9]+", title.lower())
    keywords: list[str] = []
    seen = set()
    for tok in tokens:
        if len(tok) < 3 or tok in seen:
            continue
        seen.add(tok)
        keywords.append(tok)
        if len(keywords) >= max_terms:
            break
    return keywords

def normalize_name_tokens(name: str) -> list[str]:
    return [t for t in re.findall(r"[a-z0-9]+", (name or "").lower()) if t]

def match_author_name(candidate: str, query: str) -> bool:
    cand_tokens = normalize_name_tokens(candidate)
    query_tokens = normalize_name_tokens(query)
    if not cand_tokens or not query_tokens:
        return False
    # Strict match for full names (e.g., "Sheng Wang"), avoids matching "Fusheng Wang"
    if len(query_tokens) >= 2:
        return cand_tokens == query_tokens
    # Single-token query falls back to token containment
    return query_tokens[0] in cand_tokens

async def run_title_query(pool, sql: str, *args):
    if AUTHOR_TITLE_DISABLE_TIMEOUTS:
        return await run_sql_params(pool, sql, *args)
    if AUTHOR_TITLE_TIMEOUT_MS > 0:
        return await run_sql_params_with_timeout(pool, AUTHOR_TITLE_TIMEOUT_MS, sql, *args)
    if AUTHOR_TITLE_COMMAND_TIMEOUT is None:
        return await run_sql_params(pool, sql, *args)
    return await run_sql_params_with_command_timeout(pool, AUTHOR_TITLE_COMMAND_TIMEOUT, sql, *args)

async def resolve_papers_by_title(pool, title: str) -> list[dict]:
    title_variants = build_title_variants(title)
    if not title_variants:
        return []
    if not FORCE_FUZZY_TITLE_SEARCH:
        sql_exact = """
SELECT paperid, title, display_name
FROM sciscinet_paperdetails
WHERE title = ANY($1::text[]) OR display_name = ANY($1::text[])
UNION ALL
SELECT paperid, title, NULL::text AS display_name
FROM sciscinet_papertitleabstract
WHERE title = ANY($1::text[])
LIMIT 100;
        """.strip()
        rows = await run_title_query(pool, sql_exact, title_variants)
        if rows or not ENABLE_FUZZY_TITLE_SEARCH:
            return rows

    # Fallback: fuzzy match (can be slow on large tables)
    raw_title = normalize_title_input(title)
    _, prefix_pattern, fuzzy_pattern = build_title_patterns(raw_title)
    sql_fuzzy = """
WITH input_title AS (
  SELECT $1::text AS raw_title,
         lower($1) AS lower_title,
         regexp_replace(lower($1), '\\s+', '', 'g') AS nospace_title,
         left(regexp_replace(lower($1), '\\s+', '', 'g'), 24) AS nospace_prefix,
         $2::text AS prefix_pattern,
         $3::text AS fuzzy_pattern
),
candidate_papers AS (
  (SELECT paperid, title, display_name,
          CASE
            WHEN lower(title) = it.lower_title THEN 100
            WHEN lower(display_name) = it.lower_title THEN 95
            WHEN regexp_replace(lower(title), '\\s+', '', 'g') = it.nospace_title THEN 90
            WHEN regexp_replace(lower(display_name), '\\s+', '', 'g') = it.nospace_title THEN 88
            WHEN lower(title) LIKE it.fuzzy_pattern THEN 60
            WHEN lower(display_name) LIKE it.fuzzy_pattern THEN 55
            ELSE 10
          END AS score
   FROM sciscinet_paperdetails, input_title it
   WHERE (it.prefix_pattern <> '' AND (lower(title) LIKE it.prefix_pattern OR lower(display_name) LIKE it.prefix_pattern))
      OR lower(title) = it.lower_title
      OR lower(display_name) = it.lower_title
      OR regexp_replace(lower(title), '\\s+', '', 'g') = it.nospace_title
      OR regexp_replace(lower(display_name), '\\s+', '', 'g') = it.nospace_title
      OR (it.nospace_prefix <> '' AND regexp_replace(lower(title), '\\s+', '', 'g') LIKE it.nospace_prefix || '%')
      OR (it.nospace_prefix <> '' AND regexp_replace(lower(display_name), '\\s+', '', 'g') LIKE it.nospace_prefix || '%')
   LIMIT 2000)
  UNION ALL
  (SELECT paperid, title, NULL::text AS display_name,
          CASE
            WHEN lower(title) = it.lower_title THEN 100
            WHEN regexp_replace(lower(title), '\\s+', '', 'g') = it.nospace_title THEN 90
            WHEN lower(title) LIKE it.fuzzy_pattern THEN 60
            ELSE 10
          END AS score
   FROM sciscinet_papertitleabstract, input_title it
   WHERE (it.prefix_pattern <> '' AND lower(title) LIKE it.prefix_pattern)
      OR lower(title) = it.lower_title
      OR regexp_replace(lower(title), '\\s+', '', 'g') = it.nospace_title
      OR (it.nospace_prefix <> '' AND regexp_replace(lower(title), '\\s+', '', 'g') LIKE it.nospace_prefix || '%')
   LIMIT 2000)
)
SELECT paperid, title, display_name
FROM candidate_papers cp, input_title it
WHERE lower(cp.title) = it.lower_title
   OR lower(cp.display_name) = it.lower_title
   OR regexp_replace(lower(cp.title), '\\s+', '', 'g') = it.nospace_title
   OR regexp_replace(lower(cp.display_name), '\\s+', '', 'g') = it.nospace_title
   OR lower(cp.title) LIKE it.fuzzy_pattern
   OR lower(cp.display_name) LIKE it.fuzzy_pattern
ORDER BY cp.score DESC, length(cp.title) ASC
LIMIT 50;
    """.strip()
    return await run_title_query(pool, sql_fuzzy, raw_title, prefix_pattern, fuzzy_pattern)

async def resolve_papers_by_keyword(pool, keyword: str) -> list[dict]:
    kw = (keyword or "").strip().lower()
    if len(kw) < 3:
        raise HTTPException(status_code=400, detail="Keyword too short (min 3 chars)")
    kw_pattern = f"%{kw}%"
    sql_kw = """
WITH kw AS (SELECT $1::text AS pattern)
SELECT paperid, title, display_name
FROM (
  (SELECT paperid, title, display_name
   FROM sciscinet_paperdetails, kw
   WHERE lower(title) LIKE kw.pattern OR lower(display_name) LIKE kw.pattern
   LIMIT 50)
  UNION ALL
  (SELECT paperid, title, NULL::text AS display_name
   FROM sciscinet_papertitleabstract, kw
   WHERE lower(title) LIKE kw.pattern
   LIMIT 50)
) AS merged
LIMIT 50;
    """.strip()
    return await run_title_query(pool, sql_kw, kw_pattern)

async def resolve_papers_by_title_keywords(pool, title: str) -> list[dict]:
    keywords = extract_keywords(title)
    if not keywords:
        return []
    patterns = [f"%{k}%" for k in keywords]
    detail_score = " + ".join(
        [f"(CASE WHEN lower(title) LIKE ${i} OR lower(display_name) LIKE ${i} THEN 1 ELSE 0 END)" for i in range(1, len(patterns) + 1)]
    )
    abs_score = " + ".join(
        [f"(CASE WHEN lower(title) LIKE ${i} THEN 1 ELSE 0 END)" for i in range(1, len(patterns) + 1)]
    )
    detail_where = " OR ".join([f"lower(title) LIKE ${i} OR lower(display_name) LIKE ${i}" for i in range(1, len(patterns) + 1)])
    abs_where = " OR ".join([f"lower(title) LIKE ${i}" for i in range(1, len(patterns) + 1)])
    sql_kw = f"""
SELECT paperid, title, display_name
FROM (
  SELECT paperid, title, display_name, ({detail_score}) AS score
  FROM sciscinet_paperdetails
  WHERE {detail_where}
  UNION ALL
  SELECT paperid, title, NULL::text AS display_name, ({abs_score}) AS score
  FROM sciscinet_papertitleabstract
  WHERE {abs_where}
) ranked
ORDER BY score DESC, length(title) ASC
LIMIT 50;
    """.strip()
    return await run_title_query(pool, sql_kw, *patterns)

async def resolve_authors_by_title(pool, title: str) -> list[dict]:
    if FORCE_KEYWORD_TITLE_SEARCH:
        papers = await resolve_papers_by_title_keywords(pool, title)
    else:
        papers = await resolve_papers_by_title(pool, title)
    if not papers:
        return []
    top_paper = papers[0]
    paper_id = top_paper.get("paperid")
    if not paper_id:
        return []
    return await resolve_authors_by_paperids(pool, [paper_id])

async def resolve_authors_by_title_keywords(pool, title: str) -> list[dict]:
    papers = await resolve_papers_by_title_keywords(pool, title)
    if not papers:
        return []
    paper_id = (papers[0] or {}).get("paperid")
    if not paper_id:
        return []
    return await resolve_authors_by_paperids(pool, [paper_id])

async def resolve_authors_by_name_and_title(pool, author_name: str, title: str) -> list[dict]:
    name = (author_name or "").strip().lower()
    if not name:
        raise HTTPException(status_code=400, detail="Missing 'author_name'")
    title = (title or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="Missing or invalid 'title'")

    exact_papers = await resolve_papers_by_title_exact(pool, title)
    if exact_papers:
        paper_ids = [p.get("paperid") for p in exact_papers if p.get("paperid")]
        if paper_ids:
            authors = await resolve_authors_by_paperids(pool, paper_ids)
            matched = [a for a in authors if match_author_name(a.get("author_name"), name)]
            if matched:
                return matched[:1]

    keywords = extract_keywords(title)
    if not keywords:
        raise HTTPException(status_code=400, detail="Missing or invalid 'title'")
    patterns = [f"%{k}%" for k in keywords]
    detail_score = " + ".join(
        [f"(CASE WHEN lower(pd.title) LIKE ${i+2} OR lower(pd.display_name) LIKE ${i+2} THEN 1 ELSE 0 END)" for i in range(len(patterns))]
    )
    abs_score = " + ".join(
        [f"(CASE WHEN lower(pa.title) LIKE ${i+2} THEN 1 ELSE 0 END)" for i in range(len(patterns))]
    )
    detail_where = " OR ".join([f"lower(pd.title) LIKE ${i+2} OR lower(pd.display_name) LIKE ${i+2}" for i in range(len(patterns))])
    abs_where = " OR ".join([f"lower(pa.title) LIKE ${i+2}" for i in range(len(patterns))])
    sql = f"""
WITH target_authors AS (
  SELECT a.authorid, a.author_name
  FROM sciscinet_authors a
  WHERE lower(a.author_name) LIKE $1
),
ranked_hits AS (
  SELECT ta.authorid, ta.author_name, ({detail_score}) AS score
  FROM target_authors ta
  JOIN sciscinet_paper_author_affiliation paa ON paa.authorid = ta.authorid
  JOIN sciscinet_paperdetails pd ON pd.paperid = paa.paperid
  WHERE {detail_where}
  UNION ALL
  SELECT ta.authorid, ta.author_name, ({abs_score}) AS score
  FROM target_authors ta
  JOIN sciscinet_paper_author_affiliation paa ON paa.authorid = ta.authorid
  JOIN sciscinet_papertitleabstract pa ON pa.paperid = paa.paperid
  WHERE {abs_where}
)
SELECT authorid, author_name
FROM ranked_hits
GROUP BY authorid, author_name
ORDER BY MAX(score) DESC, author_name
LIMIT 50;
    """.strip()
    rows = await run_title_query(pool, sql, f"%{name}%", *patterns)
    matched = [a for a in rows if match_author_name(a.get("author_name"), name)]
    return matched[:1] if matched else []

async def resolve_authors_by_name(pool, author_name: str) -> list[dict]:
    name = (author_name or "").strip().lower()
    if not name:
        raise HTTPException(status_code=400, detail="Missing 'author_name'")
    sql = """
SELECT authorid, author_name
FROM sciscinet_authors
WHERE lower(author_name) LIKE $1
ORDER BY author_name
LIMIT 50;
    """.strip()
    return await run_title_query(pool, sql, f"%{name}%")

async def resolve_authors_by_paperids(pool, paper_ids: list[str]) -> list[dict]:
    if not paper_ids:
        return []
    sql_authors = """
SELECT a.authorid, a.author_name
FROM sciscinet_paper_author_affiliation paa
JOIN sciscinet_authors a ON a.authorid = paa.authorid
WHERE paa.paperid = ANY($1::text[])
GROUP BY a.authorid, a.author_name
ORDER BY a.author_name
LIMIT 200;
    """.strip()
    return await run_title_query(pool, sql_authors, paper_ids)

async def resolve_papers_by_title_exact(pool, title: str) -> list[dict]:
    title_variants = build_title_variants(title)
    if not title_variants:
        return []
    sql_exact = """
SELECT paperid, title, display_name
FROM sciscinet_paperdetails
WHERE title = ANY($1::text[]) OR display_name = ANY($1::text[])
UNION ALL
SELECT paperid, title, NULL::text AS display_name
FROM sciscinet_papertitleabstract
WHERE title = ANY($1::text[])
LIMIT 100;
    """.strip()
    return await run_title_query(pool, sql_exact, title_variants)

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
            command_timeout=DB_COMMAND_TIMEOUT,
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

def mcp_text_result(payload: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "content": [
            {
                "type": "text",
                "text": json.dumps(payload, ensure_ascii=False)
            }
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
        for key in ("sql", "title", "mode", "keyword", "paperid", "paperids", "author_name"):
            if key in body:
                args[key] = body.get(key)
    return args

class SQLBody(BaseModel):
    sql: str

@app.get("/sse", dependencies=[Depends(check_auth)])
async def handle_sse(request: Request):
    if EventSourceResponse is None:
        raise HTTPException(
            status_code=500,
            detail="Missing dependency: sse-starlette. Please install: pip install sse-starlette"
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

@app.post("/mcp", dependencies=[Depends(check_auth)])
async def handle_mcp(request: Request):
    data = await request.json()
    method = (data or {}).get("method")
    params = (data or {}).get("params", {})
    msg_id = (data or {}).get("id")

    try:
        if method == "tools/list":
            result = {"tools": MCP_TOOLS}
        elif method == "tools/call":
            tool_name = params.get("name")
            args = normalize_tool_args(params.get("arguments", {}) or {}, params)
            if tool_name == TOOL_NAME:
                sql = (args.get("sql") or "").strip()
                title = (args.get("title") or "").strip()
                mode = (args.get("mode") or "").strip().lower()
                if sql:
                    ensure_readonly(sql)
                    rows = await run_sql(app.state.pool, sql)
                    result = mcp_text_result({"rows": rows})
                elif (title and (mode == "authors_by_title" or mode == "authors_by_title_keyword" or mode == "authors_by_name_and_title" or not mode or mode == "papers_by_title" or mode == "papers_by_title_exact")) or mode == "papers_by_keyword":
                    if mode == "papers_by_keyword":
                        keyword = (args.get("keyword") or title or "").strip()
                        rows = await resolve_papers_by_keyword(app.state.pool, keyword)
                        result = mcp_text_result({"keyword": keyword, "rows": rows})
                    else:
                        if mode == "papers_by_title":
                            rows = await resolve_papers_by_title(app.state.pool, title)
                            result = mcp_text_result({"title": title, "rows": rows})
                        elif mode == "papers_by_title_exact":
                            rows = await resolve_papers_by_title_exact(app.state.pool, title)
                            result = mcp_text_result({"title": title, "rows": rows})
                        elif mode == "authors_by_title_keyword":
                            rows = await resolve_authors_by_title_keywords(app.state.pool, title)
                            result = mcp_text_result({"title": title, "rows": rows})
                        elif mode == "authors_by_name_and_title":
                            author_name = (args.get("author_name") or "").strip()
                            rows = await resolve_authors_by_name_and_title(app.state.pool, author_name, title)
                            result = mcp_text_result({"author_name": author_name, "title": title, "rows": rows})
                        else:
                            rows = await resolve_authors_by_title(app.state.pool, title)
                            result = mcp_text_result({"title": title, "rows": rows})
                elif mode == "authors_by_paperid":
                    paperid = (args.get("paperid") or "").strip()
                    paperids = args.get("paperids") or []
                    ids = [p for p in ([paperid] + list(paperids)) if p]
                    if not ids:
                        raise Exception("Missing 'paperid' or 'paperids'")
                    rows = await resolve_authors_by_paperids(app.state.pool, ids)
                    result = mcp_text_result({"paperids": ids, "rows": rows})
                else:
                    if mode == "authors_by_name":
                        raise Exception("Unsupported mode: authors_by_name. Use authors_by_name_and_title with title.")
                    raise Exception("Missing 'sql' or 'title' or 'author_name'")
            else:
                raise Exception(f"Tool {tool_name} not found")
        else:
            raise Exception("Method not supported")

        return {"jsonrpc": "2.0", "id": msg_id, "result": result}
    except Exception as e:
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "error": {"code": -32603, "message": str(e)}
        }

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
    return {"tools": MCP_TOOLS}

@app.post("/api/tools/call", dependencies=[Depends(check_auth)])
async def tools_call(body: Dict[str, Any]):
    name = (body or {}).get("name","")
    args = normalize_tool_args((body or {}).get("arguments") or {}, body)
    if name == TOOL_NAME:
        sql = (args.get("sql") or "").strip()
        title = (args.get("title") or "").strip()
        mode = (args.get("mode") or "").strip().lower()
        if sql:
            ensure_readonly(sql)
            rows = await run_sql(app.state.pool, sql)
            return {"rows": rows}
        if (title and (mode == "authors_by_title" or mode == "authors_by_title_keyword" or mode == "authors_by_name_and_title" or not mode or mode == "papers_by_title" or mode == "papers_by_title_exact")) or mode == "papers_by_keyword":
            if mode == "papers_by_keyword":
                keyword = (args.get("keyword") or title or "").strip()
                rows = await resolve_papers_by_keyword(app.state.pool, keyword)
                return {"keyword": keyword, "rows": rows}
            if mode == "papers_by_title":
                rows = await resolve_papers_by_title(app.state.pool, title)
                return {"title": title, "rows": rows}
            if mode == "papers_by_title_exact":
                rows = await resolve_papers_by_title_exact(app.state.pool, title)
                return {"title": title, "rows": rows}
            if mode == "authors_by_title_keyword":
                rows = await resolve_authors_by_title_keywords(app.state.pool, title)
                return {"title": title, "rows": rows}
            if mode == "authors_by_name_and_title":
                author_name = (args.get("author_name") or "").strip()
                rows = await resolve_authors_by_name_and_title(app.state.pool, author_name, title)
                return {"author_name": author_name, "title": title, "rows": rows}
            rows = await resolve_authors_by_title(app.state.pool, title)
            return {"title": title, "rows": rows}
        if mode == "authors_by_paperid":
            paperid = (args.get("paperid") or "").strip()
            paperids = args.get("paperids") or []
            ids = [p for p in ([paperid] + list(paperids)) if p]
            if not ids:
                raise HTTPException(status_code=400, detail="Missing 'paperid' or 'paperids'")
            rows = await resolve_authors_by_paperids(app.state.pool, ids)
            return {"paperids": ids, "rows": rows}
        if mode in ("authors_by_title", "authors_by_title_keyword", "authors_by_name_and_title", "papers_by_title", "papers_by_title_exact") and not title:
            raise HTTPException(status_code=400, detail="Missing 'title'")
        if mode == "authors_by_name":
            raise HTTPException(status_code=400, detail="Unsupported mode: authors_by_name. Use authors_by_name_and_title with title.")
        raise HTTPException(status_code=400, detail="Missing 'sql' or 'title' or 'author_name'")
    raise HTTPException(status_code=404, detail="Tool not found")

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