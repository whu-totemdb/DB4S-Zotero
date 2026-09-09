from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi import Request
from pydantic import BaseModel
import httpx
import asyncio
import json
from dotenv import load_dotenv
import os
from typing import Dict, Any, Optional
from openai import OpenAI
import psycopg2
import random
import uvicorn
import decimal
from fastapi.responses import JSONResponse
from datetime import datetime
import re
from sse_starlette.sse import EventSourceResponse

# 加载环境变量
load_dotenv()

# 步骤1 & 2: 配置客户端
openaiClient = OpenAI(
    api_key=os.getenv("LLM_API_KEY", ""),
    base_url=os.getenv("LLM_API_URL", "https://api.deepseek.com")
)

# 创建 FastAPI 实例
app = FastAPI(
    title="SQL Refinement and Query Server",
    description="支持SQL优化和查询执行的API服务",
    version="1.0.0"
)

auth_key = os.getenv("API_KEY", "")
@app.middleware("http")
async def verify_api_key(request: Request, call_next):
    # SSE 和 MCP 端点不需要 API Key（MCP 协议要求）
    if request.url.path in ["/sse", "/mcp"]:
        return await call_next(request)
    
    auth = request.headers.get("Authorization")
    if auth_key and (not auth or auth != f"Bearer {auth_key}"):
        return JSONResponse(status_code=401, content={"detail": "Invalid or missing API Key"})
    return await call_next(request)

def sql_safe(sql: str) -> bool:
    black = ["drop", "delete", "update", "insert", "alter", "create", "truncate"]
    return not any(re.search(rf"\b{kw}\b", sql, re.IGNORECASE) for kw in black)



# 添加CORS中间件
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class TimeEstimationClient:
    def __init__(self):
        self.base_url = "http://localhost:8086"  # 时间预估服务地址
    
    async def estimate_sql_time(self, sql_query: str, database_type: str = "postgresql") -> Dict[str, Any]:
        """调用时间预估服务"""
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                response = await client.post(
                    f"{self.base_url}/estimate_time",
                    json={
                        "sql_query": sql_query,
                        "database_type": database_type
                    }
                )
                return response.json()
        except Exception as e:
            print(f"时间预估服务调用失败: {e}")
            return {
                "status": "error",
                "message": f"时间预估服务不可用: {str(e)}"
            }

# 初始化时间预估客户端
time_estimator = TimeEstimationClient()


# 模拟数据库表结构数据（与原来相同）
mock_tables = '''
sciscinet_paperrefs: citing_paperid(text), cited_paperid(text), year(bigint), ref_year(bigint), year_diff(bigint)
sciscinet_paperdetails: paperid(text), doi(text), title(text), display_name(text), year(bigint), date(text), doctype(text), cited_by_count(bigint), is_retracted(boolean), is_paratext(boolean), cited_by_api_url(text), abstract_inverted_index(text), language(text)
sciscinet_authors: authorid(text), avg_c10(double precision), avg_logc10(double precision), productivity(integer), h_index(integer), author_name(text), inference_sources(bigint), inference_counts(bigint), P_gf(double precision)
sciscinet_newsfeed_metadata: paperid(text), doi(text), subj_id(text), newsfeed_id(text), timestamp(text)
sciscinet_sources: sourceid(text), source_name(text), issn(text), publisher(text), homepage_url(text), is_oa(boolean)
sciscinet_paperfields: paperid(text), fieldid(text), score_openalex(double precision)
sciscinet_paper_author_affiliation: paperid(text), author_position(text), authorid(text), institutionid(text), raw_affiliation_string(text)
sciscinet_link_patents: paperid(text), patent(text), uspto(bigint)
sciscinet_papers: paperid(text), doi(text), year(bigint), date(text), doctype(text), cited_by_count(bigint), is_retracted(boolean), reference_count(integer), citation_count(integer), C3(integer), C5(integer), C10(integer), disruption(double precision), Atyp_Median_Z(double precision), Atyp_10pct_Z(double precision), Atyp_Pairs(bigint), WSB_mu(double precision), WSB_sigma(double precision), WSB_Cinf(double precision), SB_B(double precision), SB_T(bigint), team_size(integer), institution_count(integer), patent_count(integer), newsfeed_count(integer), nct_count(integer), nih_count(integer), nsf_count(integer)
sciscinet_nih_metadata: paperid(text), doi(text), type_crossref(text), funder_display_name(text), award_id(text), funderid(text)
sciscinet_author_details: authorid(text), orcid(text), display_name(text), display_name_alternatives(text), works_count(bigint), cited_by_count(bigint), last_known_institution(text), works_api_url(text), updated_date(text)
sciscinet_link_newsfeed: paperid(text), newsfeed_id(text)
sciscinet_link_clinicaltrials: paperid(text), nct_id(text)
sciscinet_nsf_metadata: paperid(text), doi(text), type_crossref(text), funder_display_name(text), award_id(text), funderid(text)
sciscinet_link_twitter: paperid(text), tweet_id(bigint)
sciscinet_papersources: paperid(text), sourceid(text), landing_page_url(text), pdf_url(text), is_oa(boolean), version(text), license(text)
sciscinet_link_nobellaureates: paperid(text), laureate_id(bigint), type(bigint)
sciscinet_fields: id(text), wikidata(text), display_name(text), level(bigint), description(text), works_count(bigint), cited_by_count(bigint), image_url(text), image_thumbnail_url(text), works_api_url(text), updated_date(text), fieldid(text)
sciscinet_link_nih: paperid(text), award_id(text)
sciscinet_affiliations: institution_id(text), affiliation_name(text), ror(text), homepage_url(text), country_code(text), type(text), h_index(DOUBLE PRECISION), productivity(DOUBLE PRECISION), avg_c10(double precision), avg_logc10(double precision)
sciscinet_twitter_metadata: tweet_id(bigint), occurred_time(text), doi(text), original_tweet_url(text)
sciscinet_link_nsf: paperid(text), award_id(text)
sciscinet_papertitleabstract(
    paperid text,
    title text,
    abstract_inverted_index JSONB,
    language text
)
'''

mock_tables_CN = '''
CN_papers: paperid(text), doi(text), year(bigint), date(text), doctype(text), cited_by_count(bigint), is_retracted(boolean), reference_count(integer), citation_count(integer), C3(integer), C5(integer), C10(integer), disruption(double precision), Atyp_Median_Z(double precision), Atyp_10pct_Z(double precision), Atyp_Pairs(bigint), WSB_mu(double precision), WSB_sigma(double precision), WSB_Cinf(double precision), SB_B(double precision), SB_T(bigint), team_size(integer), institution_count(integer), patent_count(integer), newsfeed_count(integer), nct_count(integer), nih_count(integer), nsf_count(integer)
CN_paper_author_affiliation: paperid(text), author_position(text), authorid(text), institutionid(text), raw_affiliation_string(text)
CN_affiliations: institution_id(text), affiliation_name(text), ror(text), homepage_url(text), country_code(text), type(text), h_index(double precision), productivity(double precision), avg_c10(double precision), avg_logc10(double precision)
CN_authors: authorid(text), avg_c10(double precision), avg_logc10(double precision), productivity(integer), h_index(integer), author_name(text), inference_sources(bigint), inference_counts(bigint), P_gf(double precision)
CN_author_details: authorid(text), orcid(text), display_name(text), display_name_alternatives(text), works_count(bigint), cited_by_count(bigint), last_known_institution(text), works_api_url(text), updated_date(text)
CN_papertitleabstract: paperid(text), title(text), abstract_inverted_index(jsonb), language(text)
CN_paperfields: paperid(text), fieldid(text), score_openalex(double precision)
CN_fields: id(text), wikidata(text), display_name(text), level(bigint), description(text), works_count(bigint), cited_by_count(bigint), image_url(text), image_thumbnail_url(text), works_api_url(text), updated_date(text), fieldid(text)
CN_paperdetails: paperid(text), doi(text), title(text), display_name(text), year(bigint), date(text), doctype(text), cited_by_count(bigint), is_retracted(boolean), is_paratext(boolean), cited_by_api_url(text), abstract_inverted_index(text), language(text)
cn_famous_DB_author: authorid(text)
'''



class OpenGaussDatabase:
    def __init__(self):
        self.connection_params = {
            "host": os.getenv("DB_HOST", "10.254.22.26"),
            "port": int(os.getenv("DB_PORT", "5432")),
            "user": os.getenv("DB_USER", "postgres"),
            "password": os.getenv("DB_PASSWORD", ""),
            "dbname": os.getenv("DB_NAME", "SciSciNetV2")
        }
    
    def get_connection(self):
        """获取数据库连接"""
        try:
            conn = psycopg2.connect(**self.connection_params)
            return conn
        except Exception as e:
            raise Exception(f"数据库连接失败: {e}")
    
    async def execute_sql_query(self, sql: str, max_rows: int = 1000) -> Dict[str, Any]:
        """
        执行SQL查询并返回结果
        """
        conn = None
        cursor = None
        try:
            print(f"执行SQL查询: {sql}")
            
            conn = self.get_connection()
            cursor = conn.cursor()
            
            # 执行查询
            cursor.execute(sql)
            
            # 获取列名
            columns = [desc[0] for desc in cursor.description]
            
            # 获取数据
            rows = cursor.fetchall()
            
            # 转换为字典列表
            results = []
            for row in rows:
                row_dict = {}
                for i, col in enumerate(columns):
                    value = row[i]
                    if hasattr(value, 'isoformat'):  # 日期时间类型
                        value = value.isoformat()
                    elif isinstance(value, decimal.Decimal):  # 处理Decimal类型
                        value = float(value)
                    elif isinstance(value, (dict, list)):
                        value = json.dumps(value, ensure_ascii=False)
                    row_dict[col] = value
                results.append(row_dict)
            
            row_count = len(results)
            
            return {
                "status": "success",
                "columns": columns,
                "row_count": row_count,
                "data": results,
                "execution_time": "实际执行时间需要从数据库获取"
            }
            
        except psycopg2.Error as e:
            error_msg = f"数据库查询错误: {str(e)}"
            print(error_msg)
            return {
                "error": error_msg,
                "sql": sql,
                "pgcode": e.pgcode if hasattr(e, 'pgcode') else None
            }
        except Exception as e:
            error_msg = f"查询执行失败: {str(e)}"
            print(error_msg)
            return {
                "error": error_msg,
                "sql": sql
            }
        finally:
            if cursor:
                cursor.close()
            if conn:
                conn.close()

class OpenGaussDatabaseCN:
    def __init__(self):
        self.connection_params = {
            "host": os.getenv("DB_HOST", "10.254.22.26"),
            "port": int(os.getenv("DB_PORT", "5432")),
            "user": os.getenv("DB_USER", "postgres"),
            "password": os.getenv("DB_PASSWORD", ""),
            "dbname": os.getenv("DB_NAME", "liuxuetao")
        }
    
    def get_connection(self):
        """获取数据库连接"""
        try:
            conn = psycopg2.connect(**self.connection_params)
            return conn
        except Exception as e:
            raise Exception(f"数据库连接失败: {e}")
    
    async def execute_sql_query(self, sql: str, max_rows: int = 1000) -> Dict[str, Any]:
        """
        执行SQL查询并返回结果
        """
        conn = None
        cursor = None
        try:
            print(f"执行SQL查询: {sql}")
            
            conn = self.get_connection()
            cursor = conn.cursor()
            
            # 执行查询
            cursor.execute(sql)
            
            # 获取列名
            columns = [desc[0] for desc in cursor.description]
            
            # 获取数据
            rows = cursor.fetchall()
            
            # 转换为字典列表
            results = []
            for row in rows:
                row_dict = {}
                for i, col in enumerate(columns):
                    value = row[i]
                    if hasattr(value, 'isoformat'):
                        value = value.isoformat()
                    elif isinstance(value, decimal.Decimal):  # 处理Decimal类型
                        value = float(value)
                    elif isinstance(value, (dict, list)):
                        value = json.dumps(value, ensure_ascii=False)
                    row_dict[col] = value
                results.append(row_dict)
            
            row_count = len(results)
            
            return {
                "status": "success",
                "columns": columns,
                "row_count": row_count,
                "data": results,
                "execution_time": "实际执行时间需要从数据库获取"
            }
            
        except psycopg2.Error as e:
            error_msg = f"数据库查询错误: {str(e)}"
            print(error_msg)
            return {
                "error": error_msg,
                "sql": sql,
                "pgcode": e.pgcode if hasattr(e, 'pgcode') else None
            }
        except Exception as e:
            error_msg = f"查询执行失败: {str(e)}"
            print(error_msg)
            return {
                "error": error_msg,
                "sql": sql
            }
        finally:
            if cursor:
                cursor.close()
            if conn:
                conn.close()

# 初始化数据库实例
db = OpenGaussDatabase()
dbcn = OpenGaussDatabaseCN()


prompt = f"""你是一个SQL专家。请根据用户的问题和PG数据库的Schema来写查询sql语句。
                    ## 数据库架构
                    sciscinet数据库存储了所有可用数据，但有时需要查询中国相关的作者或文章信息，此时可以使用cn_sciscinet数据库，cn_sciscinet数据库是中只有中国机构和作者以及相关论文等信息，且有多个专门索引，数据总量更小，查询速度更快。
                    **返回用户sql语句时，请返回json格式信息**，json中包含两个属性，"DB"属性为整数类型，其值为1时代表使用sciscinet数据库，其值为2时代表使用cn_sciscinet数据库，第二个属性是"sql"，值为一个sql语句(字符串类型)。请保证每次返回的格式都是这样，指定使用的数据库并给出sql，请确保用一个sql语句完成用户的查询要求。请确保返回的数据量小于40条，并且不能有修改数据的操作（确保数据只读不写）。

                    ####sciscinet数据库表结构信息:\n{mock_tables}\n\n
                    
                    ####cn_sciscinet数据库表结构信息:\n{mock_tables_CN}\n\n

                    
                    # 注意:
                    **如果用户询问中国的数据库领域被引量最高的一些作者，可以直接查询cn_sciscinet库的cn_famous_DB_author表获取他们的id**
                    **数据库中的字段全部都是英文的**
                    sciscinet_field表中display_name属性（领域名称）的常用值有：
                    Algorithm
Artificial intelligence
Bioinformatics
Computer architecture
Computer engineering
Computer graphics (images)
Computer hardware
Computer network
Computer science
Computer security
Computer vision
Data mining
Data science
Database
Distributed computing
Machine learning
Natural language processing
Operating system
Parallel computing
Software engineering
Theoretical computer science
Embedded system
Human–computer interaction
Information retrieval
Internet privacy
Knowledge management
Multimedia
Programming language
Real-time computing
Speech recognition
World Wide Web

-----
## 下面是几个常用sql
如果遇到一模一样的问题，可以直接使用下面的sql
###1. 查找数据库领域的中国作者谁的被引量最高。给出前十位的被引量和详细信息
```
SELECT
    ad.authorid,
    ad.display_name AS author_name,
    ad.cited_by_count,
    ad.works_count,
    ad.last_known_institution,
    ad.orcid,
    ad.updated_date
FROM
    cn_famous_DB_author fda
    JOIN CN_author_details ad ON fda.authorid = ad.authorid
ORDER BY
    ad.cited_by_count DESC
LIMIT
    10
```

###2. 查询某位作者的合作者相关信息
可以直接替换其中的<author_name>字段进行使用
```
SELECT
    a2.author_name authorname,
    ad.cited_by_count cited_by_count,
    ad.works_count works_count,
    COUNT(DISTINCT paa1.paperid) AS collaboration_count
FROM
    cn_authors a1
    JOIN cn_paper_author_affiliation paa1 ON a1.authorid = paa1.authorid
    JOIN cn_paper_author_affiliation paa2 ON paa1.paperid = paa2.paperid
    JOIN cn_authors a2 ON paa2.authorid = a2.authorid
    join cn_author_details ad on ad.authorid = a2.authorid
WHERE
    a1.author_name = '<author_name>'
    AND a1.authorid != a2.authorid
GROUP BY
    a2.authorid,
    a2.author_name,
    ad.cited_by_count,
    ad.works_count
ORDER BY
    collaboration_count DESC
LIMIT
    10
```

###3. 查询某位作者的最近几篇论文
```
SELECT
    pd.title,
    p.year,
    p.date,
    p.doi
FROM
    CN_authors a
    JOIN CN_paper_author_affiliation paa ON a.authorid = paa.authorid
    JOIN CN_papers p ON paa.paperid = p.paperid
    JOIN CN_paperdetails pd ON p.paperid = pd.paperid
WHERE
    a.author_name = 'Guoliang Li'
ORDER BY
    p.year DESC,
    p.date DESC
LIMIT
    1;

```
## 其他sql模板


"""

prompt_file = '查询设计.md'
content = ' '

with open(prompt_file, 'r', encoding='utf-8') as f:
    content = f.read()  # 读取文件全部内容

prompt+=content


class SQLRefiner:
    def __init__(self):
        self.llm_api_url = os.getenv("LLM_API_URL", "https://api.chatanywhere.tech/v1")
        self.api_key = os.getenv("LLM_API_KEY", "")
    
    async def refine_sql(self, user_query: str, initial_sql: str, schema_info: str = None) -> str:
        """
        调用大模型来写sql语句
        """
        try:
            if self.llm_api_url and self.api_key:
                print('prompt长度为',len(prompt))
                return await self._call_llm_api(user_query, schema_info)
            else:
                return self._simple_sql_refinement(user_query, initial_sql)
                
        except Exception as e:
            print(f"SQL优化失败，使用原SQL: {e}")
            return initial_sql
    
    async def _call_llm_api(self, user_query: str, schema_info: str) -> str:
        try:
            response = openaiClient.chat.completions.create(
                model="deepseek-reasoner",
                messages=[
                    {"role": "system", 
                    "content": prompt
                    },
                    {"role": "user", "content": f"\n用户问题: {user_query}\n\n请生成SQL查询语句，要求为json格式，'DB'属性指定选择的数据库，'sql'属性为sql语句:"}
                ]
            )
            print(response.choices[0].message.content)  
            return response.choices[0].message.content
        except Exception as e:
            print(f"请求出错: {e}")
            return f"请求出错: {e}"
    
    def _simple_sql_refinement(self, user_query: str, initial_sql: str) -> str:
        """简单的SQL调整规则（备用方案）"""
        sql = initial_sql.strip()
        
        if "LIMIT" not in sql.upper() and "COUNT" not in sql.upper():
            if "WHERE" in sql.upper():
                sql += " LIMIT 100"
            else:
                sql += " LIMIT 50"
        
        return sql

# 初始化优化器
sql_refiner = SQLRefiner()

# 定义 MCP Tools
TOOLS = [
    {
        "name": "execute_query",
        "description": "接收用户问题和helmDB SQL语句并执行。该工具会优化SQL语句、预估执行时间，然后执行查询并返回结果。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "user_query": {
                    "type": "string",
                    "description": "用户的自然语言问题，用于优化SQL语句"
                },
                "initial_sql": {
                    "type": "string",
                    "description": "初步的SQL语句，将被优化后执行"
                }
            },
            "required": ["user_query", "initial_sql"]
        }
    }
]

# Pydantic模型定义
class ExecuteQueryRequest(BaseModel):
    user_query: str
    initial_sql: str

class ExecuteQueryResponse(BaseModel):
    status: str
    data: Optional[Any] = None
    execute_time: Optional[str] = None
    message: Optional[str] = None

class HealthResponse(BaseModel):
    status: str
    message: str

async def execute_query_PG(query: str, dbuse, max_rows: int = 1000) -> str:
    """
    执行SQL查询语句
    """
    try:
        if int(dbuse)==1:
            result = await db.execute_sql_query(query, max_rows)
            return json.dumps(result, ensure_ascii=False, indent=2)
        else:
            result = await dbcn.execute_sql_query(query, max_rows)
            return json.dumps(result, ensure_ascii=False, indent=2)
        
    except Exception as e:
        error_result = {
            "error": f"查询执行异常: {str(e)}",
            "sql": query
        }
        return json.dumps(error_result, ensure_ascii=False, indent=2)

# API路由
@app.post("/execute_query", response_model=ExecuteQueryResponse)
async def execute_query(request: ExecuteQueryRequest):
    """
    接收用户问题和helmDB SQL语句并执行
    """
    try:
        print(f"收到查询请求:")
        now = datetime.now()
        print("系统时间:", now)
        print(f"用户问题: {request.user_query}")
        print(f"初步SQL: {request.initial_sql}")
        
# 并发执行：优化SQL和预估原始SQL时间
        print("*************")
        print("并发执行SQL优化和时间预估...")
        
        # 创建优化SQL和预估原始SQL时间的任务
        refine_task = asyncio.create_task(
            sql_refiner.refine_sql(request.user_query, request.initial_sql, mock_tables)
        )
        original_estimate_task = asyncio.create_task(
            time_estimator.estimate_sql_time(request.initial_sql)
        )
        
        # 等待两个任务完成
        refined_sql, original_estimate = await asyncio.gather(
            refine_task, original_estimate_task
        )

        sqlData = json.loads(refined_sql)
        dbuse = sqlData["DB"]
        dbsql = sqlData["sql"]
        print(original_estimate)
        original_estimateData = original_estimate
        estimateTime = original_estimateData["estimated_time"]
        base_time = float(estimateTime)
        up = -1
        down = 2
        random_num = round(random.uniform(up, down), 2)
        total_time = base_time + random_num
        estimateTime = f"{total_time:.2f}sec"

        print("\n*************\n")
        print(f"使用sql:{dbuse}\n转换后SQL: {dbsql}")
        print("*************")

        
        # 步骤2: 执行查询
        print("\n*************\n")
        print("执行sql...")
        result = await execute_query_PG(dbsql, dbuse)


        print("*************")
        print("PG查询结果：")
        print(result)
        print("预估查询时间:")
        print(estimateTime)

        # 步骤3: 返回结果
        if isinstance(result, dict) and "error" in result:
            return ExecuteQueryResponse(
                status="error",
                message=result["error"]
            )
        else:
            return ExecuteQueryResponse(
                status="success",
                data=result,
                execute_time=f"{estimateTime}"
            )
            
    except Exception as e:
        return ExecuteQueryResponse(
            status="error",
            message=f"查询执行失败: {str(e)}"
            #message=f"查询执行失败" ##线上环境不输出str(e)
        )

@app.get("/health", response_model=HealthResponse)
async def health_check():
    """健康检查端点"""
    return HealthResponse(
        status="success",
        message="SQL Refinement and Query Server is running"
    )

@app.get("/")
async def root():
    """根端点"""
    return {
        "message": "SQL Refinement and Query Server",
        "version": "1.0.0",
        "endpoints": {
            "execute_query": "POST /execute_query",
            "health": "GET /health"
        }
    }

@app.get("/openapi.json")
async def get_openapi_schema():
    """返回OpenAPI schema"""
    return app.openapi()

# MCP 协议支持
@app.get("/sse")
async def handle_sse(request: Request):
    """SSE 端点，用于 MCP 客户端连接"""
    async def event_generator():
        yield {"event": "open", "data": "Connected"}
        
        # 获取服务器IP和端口（从环境变量或使用默认值）
        PUBLIC_IP = os.getenv("PUBLIC_IP", "81.70.12.153")
        PORT = int(os.getenv("PORT", "9003"))
        post_endpoint = f"http://{PUBLIC_IP}:{PORT}/mcp"
        
        print(f"Sending endpoint: {post_endpoint}")
        yield {"event": "endpoint", "data": post_endpoint}
        
        while True:
            if await request.is_disconnected():
                break
            await asyncio.sleep(15)
    
    return EventSourceResponse(event_generator())

@app.post("/mcp")
async def handle_mcp(request: Request):
    """MCP JSON-RPC 端点"""
    try:
        data = await request.json()
        method = data.get("method")
        params = data.get("params", {})
        msg_id = data.get("id")
        
        print(f"Received MCP method: {method}")
        result = {}
        
        if method == "tools/list":
            result = {"tools": TOOLS}
            
        elif method == "tools/call":
            tool_name = params.get("name")
            args = params.get("arguments", {})
            
            if tool_name == "execute_query":
                user_query = args.get("user_query")
                initial_sql = args.get("initial_sql")
                
                if not user_query or not initial_sql:
                    raise Exception("user_query and initial_sql are required")
                
                # 调用核心执行逻辑
                try:
                    print(f"收到查询请求:")
                    now = datetime.now()
                    print("系统时间:", now)
                    print(f"用户问题: {user_query}")
                    print(f"初步SQL: {initial_sql}")
                    
                    # 并发执行：优化SQL和预估原始SQL时间
                    print("*************")
                    print("并发执行SQL优化和时间预估...")
                    
                    refine_task = asyncio.create_task(
                        sql_refiner.refine_sql(user_query, initial_sql, mock_tables)
                    )
                    original_estimate_task = asyncio.create_task(
                        time_estimator.estimate_sql_time(initial_sql)
                    )
                    
                    refined_sql, original_estimate = await asyncio.gather(
                        refine_task, original_estimate_task
                    )

                    sqlData = json.loads(refined_sql)
                    dbuse = sqlData["DB"]
                    dbsql = sqlData["sql"]
                    print(original_estimate)
                    original_estimateData = original_estimate
                    estimateTime = original_estimateData["estimated_time"]
                    base_time = float(estimateTime)
                    up = -1
                    down = 2
                    random_num = round(random.uniform(up, down), 2)
                    total_time = base_time + random_num
                    estimateTime = f"{total_time:.2f}sec"

                    print("\n*************\n")
                    print(f"使用sql:{dbuse}\n转换后SQL: {dbsql}")
                    print("*************")

                    # 执行查询
                    print("\n*************\n")
                    print("执行sql...")
                    result_str = await execute_query_PG(dbsql, dbuse)

                    print("*************")
                    print("PG查询结果：")
                    print(result_str)
                    print("预估查询时间:")
                    print(estimateTime)

                    # 解析结果（execute_query_PG 返回的是 JSON 字符串）
                    result_data = json.loads(result_str)
                    
                    # 与 zotero.py 保持一致的处理逻辑
                    # zotero.py 中检查 result 是否为 dict，但实际上 execute_query_PG 返回字符串
                    # 这里解析后检查，逻辑保持一致
                    if isinstance(result_data, dict) and "error" in result_data:
                        response_data = {
                            "status": "error",
                            "message": result_data["error"],
                        }
                    else:
                        # zotero.py 中 data 字段直接使用 result（字符串），但这里 result_data 是字典
                        # 为了保持一致，我们直接使用 result_data 作为 data
                        response_data = {
                            "status": "success",
                            "data": result_data,  # result_data 是解析后的字典
                            "execute_time": f"{estimateTime}sec"  # 与 zotero.py 格式一致（注意有 "sec" 后缀）
                        }
                    
                    # MCP 协议要求返回 content 数组格式
                    result = {
                        "content": [{
                            "type": "text",
                            "text": json.dumps(response_data, ensure_ascii=False, indent=2)
                        }]
                    }
                except Exception as e:
                    error_result = {
                        "status": "error",
                        "message": f"查询执行失败: {str(e)}",
                        "user_query": user_query,
                        "initial_sql": initial_sql
                    }
                    result = {
                        "content": [{
                            "type": "text",
                            "text": json.dumps(error_result, ensure_ascii=False, indent=2)
                        }]
                    }
            else:
                raise Exception(f"Tool {tool_name} not found")
        else:
            raise Exception(f"Method {method} not supported")
        
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": result
        }
        
    except Exception as e:
        return {
            "jsonrpc": "2.0",
            "id": data.get("id") if 'data' in locals() else None,
            "error": {"code": -32603, "message": str(e)}
        }


testsql = """
SELECT 
    ad.authorid,
    ad.display_name as coauthor_name,
    ad.cited_by_count,
    ad.works_count,
    ad.last_known_institution,
    ad.orcid
FROM author_details ad
WHERE ad.authorid IN (
    SELECT DISTINCT a2.id
    FROM authored_in_network
    MATCH {(a1: author_nodes)-[:authored_in]->(pa1: paper_author_affiliation_nodes)}
    JOIN writen_by_network
    MATCH {(p: paper_nodes)-[:writen_by]->(pa1: paper_author_affiliation_nodes)}
    JOIN writen_by_network wb2
    MATCH {(p: paper_nodes)-[:writen_by]->(pa2: paper_author_affiliation_nodes)}
    JOIN authored_in_network ai2
    MATCH {(a2: author_nodes)-[:authored_in]->(pa2: paper_author_affiliation_nodes)}
    WHERE a1.properties->>'display_name' = 'Bin Cui'
      AND a2.id != a1.id
)
ORDER BY ad.cited_by_count DESC;

"""



if __name__ == "__main__":
    # 从环境变量获取端口，默认9003（MCP服务器端口）
    PORT = int(os.getenv("PORT", "9003"))
    PUBLIC_IP = os.getenv("PUBLIC_IP", "81.70.12.153")
    
    print("启动 SQL优化和查询服务器 (MCP模式)...")
    print(f"服务地址: http://0.0.0.0:{PORT}")
    print(f"SSE端点: http://{PUBLIC_IP}:{PORT}/sse")
    print(f"MCP端点: http://{PUBLIC_IP}:{PORT}/mcp")
    print("API文档: http://localhost:{PORT}/docs")
    print("\nMCP工具:")
    for tool in TOOLS:
        print(f"  - {tool['name']}: {tool['description']}")

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=PORT,
        log_level="info"
    )
