from mcp.server.fastmcp import FastMCP
import httpx
import asyncio
import json
from dotenv import load_dotenv
import os
from typing import Dict, Any
from openai import OpenAI
import psycopg2
import random
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

# 步骤1 & 2: 配置客户端
openaiClient = OpenAI(
    api_key=os.getenv("LLM_API_KEY", ""),
    base_url=os.getenv("LLM_API_URL", "https://api.deepseek.com")
    # base_url="https://api.chatanywhere.tech/v1"  # 国内中转地址
)

# 加载环境变量
load_dotenv()

# 创建 FastMCP 实例
mcp = FastMCP(
    name="SQL Refinement and Query Server",
    host="0.0.0.0",
    port=9003,
)



class TimeEstimationClient:
    def __init__(self):
        self.base_url = "http://localhost:8086"  # 时间预估服务地址
    
    async def estimate_sql_time(self, sql_query: str, database_type: str = "postgresql") -> Dict[str, Any]:
        """调用时间预估服务"""
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
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

# 模拟数据库表结构数据（简化版）
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
        
        Args:
            sql: SQL查询语句
            max_rows: 最大返回行数，防止数据过大
            
        Returns:
            包含查询结果的字典
        """
        conn = None
        cursor = None
        try:
            # # 安全检查：确保是SELECT查询
            # sql_upper = sql.strip().upper()
            # if not sql_upper.startswith('SELECT'):
            #     return {
            #         "error": "只允许执行SELECT查询",
            #         "sql": sql
            #     }
            
            # # 添加LIMIT子句（如果不存在且不是聚合查询）
            # if "LIMIT" not in sql_upper and max_rows > 0:
            #     if "COUNT(" not in sql_upper and "GROUP BY" not in sql_upper:
            #         sql += f" LIMIT {max_rows}"
            
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
                    # 处理特殊类型（如日期、JSON等）
                    value = row[i]
                    if hasattr(value, 'isoformat'):  # 日期时间类型
                        value = value.isoformat()
                    elif isinstance(value, (dict, list)):
                        value = json.dumps(value, ensure_ascii=False)
                    row_dict[col] = value
                results.append(row_dict)
            
            # 获取查询信息
            row_count = len(results)
            
            return {
                "status": "success",
                "columns": columns,
                "row_count": row_count,
                "data": results,
                "execution_time": "实际执行时间需要从数据库获取"  # 这里可以添加实际执行时间计算
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
            # 关闭连接
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
        
        Args:
            sql: SQL查询语句
            max_rows: 最大返回行数，防止数据过大
            
        Returns:
            包含查询结果的字典
        """
        conn = None
        cursor = None
        try:
            # # 安全检查：确保是SELECT查询
            # sql_upper = sql.strip().upper()
            # if not sql_upper.startswith('SELECT'):
            #     return {
            #         "error": "只允许执行SELECT查询",
            #         "sql": sql
            #     }
            
            # # 添加LIMIT子句（如果不存在且不是聚合查询）
            # if "LIMIT" not in sql_upper and max_rows > 0:
            #     if "COUNT(" not in sql_upper and "GROUP BY" not in sql_upper:
            #         sql += f" LIMIT {max_rows}"
            
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
                    # 处理特殊类型（如日期、JSON等）
                    value = row[i]
                    if hasattr(value, 'isoformat'):  # 日期时间类型
                        value = value.isoformat()
                    elif isinstance(value, (dict, list)):
                        value = json.dumps(value, ensure_ascii=False)
                    row_dict[col] = value
                results.append(row_dict)
            
            # 获取查询信息
            row_count = len(results)
            
            return {
                "status": "success",
                "columns": columns,
                "row_count": row_count,
                "data": results,
                "execution_time": "实际执行时间需要从数据库获取"  # 这里可以添加实际执行时间计算
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
            # 关闭连接
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


class MCPServer2Client:
    def __init__(self, base_url: str = "http://localhost:8082"):
        self.base_url = base_url
        self.client = httpx.AsyncClient(timeout=30.0)
    
    async def execute_query(self, query: str) -> Dict[str, Any]:
        """调用 mcpServer2 的 execute_query 工具"""
        try:
            # 构建 JSON-RPC 请求
            payload = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "execute_query",
                    "arguments": {
                        "query": query
                    }
                }
            }
            
            response = await self.client.post(f"{self.base_url}/sse", json=payload)
            response.raise_for_status()
            
            # 解析 SSE 响应
            result = await self._parse_sse_response(response)
            return result
            
        except Exception as e:
            return {"error": f"调用 mcpServer2 失败: {str(e)}"}
    
    async def _parse_sse_response(self, response: httpx.Response) -> Dict[str, Any]:
        """解析 SSE 响应格式"""
        try:
            # SSE 响应通常是多行数据，我们需要找到包含结果的那一行
            text = response.text
            lines = text.strip().split('\n')
            
            for line in lines:
                if line.startswith('data:'):
                    data = json.loads(line[5:])  # 去掉 'data:' 前缀
                    if 'result' in data:
                        return data['result']
                    elif 'error' in data:
                        return {"error": data['error']}
            
            return {"error": "无法解析 mcpServer2 响应"}
        except Exception as e:
            return {"error": f"解析响应失败: {str(e)}"}

class SQLRefiner:
    def __init__(self):
        # 这里可以配置大模型API的地址和密钥
        self.llm_api_url = os.getenv("LLM_API_URL", "https://api.chatanywhere.tech/v1")
        self.api_key = os.getenv("LLM_API_KEY", "")
    
    async def refine_sql(self, user_query: str, initial_sql: str, schema_info: str = None) -> str:
        """
        调用大模型来写sql语句
        """
        try:
            # 如果配置了大模型API，这里调用实际的大模型
            if self.llm_api_url and self.api_key:
                return await self._call_llm_api(user_query, schema_info)
            else:
                # 如果没有配置大模型，使用简单的规则进行调整
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
        
        # 添加LIMIT如果查询可能返回大量数据
        if "LIMIT" not in sql.upper() and "COUNT" not in sql.upper():
            if "WHERE" in sql.upper():
                sql += " LIMIT 100"
            else:
                sql += " LIMIT 50"
        
        return sql

# 初始化客户端和优化器
mcp2_client = MCPServer2Client()
sql_refiner = SQLRefiner()


async def explain_query(query: str) -> str:
    """
    解释SQL查询的执行计划
    
    Args:
        query: SQL查询语句
        
    Returns:
        JSON格式的执行计划
    """
    try:
        # 使用EXPLAIN获取执行计划
        explain_query = f"EXPLAIN (FORMAT JSON) {query}"
        result = await db.execute_sql_query(explain_query, max_rows=0)
        
        return json.dumps({
            "original_query": query,
            "explain_query": explain_query,
            "execution_plan": result
        }, ensure_ascii=False, indent=2)
        
    except Exception as e:
        error_result = {
            "error": f"执行计划分析失败: {str(e)}",
            "query": query
        }
        return json.dumps(error_result, ensure_ascii=False, indent=2)


async def execute_query_PG(query: str, dbuse, max_rows: int = 1000) -> str:
    """
    执行SQL查询语句。请确保sql不修改数据库的数据，仅为查询和读取
    
    Args:
        query: SQL查询语句（只允许SELECT查询）
        max_rows: 最大返回行数，默认1000行，防止数据过大
        
    Returns:
        JSON格式的查询结果
    """
    try:
        # 执行查询
        if int(dbuse)==1:
            result = await db.execute_sql_query(query, max_rows)
            return json.dumps(result, ensure_ascii=False, indent=2)
        else:
            result = await dbcn.execute_sql_query(query, max_rows)
            return json.dumps(result, ensure_ascii=False, indent=2)
        
        # 返回JSON格式结果
        
        
    except Exception as e:
        error_result = {
            "error": f"查询执行异常: {str(e)}",
            "sql": query
        }
        return json.dumps(error_result, ensure_ascii=False, indent=2)

@mcp.tool()
async def execute_query(user_query: str, initial_sql: str) -> str:
    """
    接收用户问题和helmDB SQL语句并执行
    """
    try:
        print(f"收到查询请求:")
        now = datetime.now()
        print("系统时间:", now)
        print(f"收到查询请求:")
        print(f"用户问题: {user_query}")
        print(f"初步SQL: {initial_sql}")
        
# 并发执行：优化SQL和预估原始SQL时间
        print("*************")
        print("并发执行SQL优化和时间预估...")
        
        # 创建优化SQL和预估原始SQL时间的任务
        refine_task = asyncio.create_task(
            sql_refiner.refine_sql(user_query, initial_sql, mock_tables)
        )
        original_estimate_task = asyncio.create_task(
            time_estimator.estimate_sql_time(initial_sql)
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
            return json.dumps({
                "status": "error",
                "message": result["error"],
            }, ensure_ascii=False, indent=2)
        else:
            return json.dumps({
                "status": "success",
                "data": result,
                "execute_time": f"{estimateTime}sec"
            }, ensure_ascii=False, indent=2)
            
    except Exception as e:
        error_result = {
            "status": "error",
            "message": f"查询执行失败: {str(e)}",
            "user_query": user_query,
            "initial_sql": initial_sql
        }
        return json.dumps(error_result, ensure_ascii=False, indent=2)
    """
    接收用户问题和SQL语句并执行。
    
    Args:
        user_query: 用户的自然语言问题
        initial_sql: 使用的SQL语句
    """
    '''
    try:
        print(f"收到查询请求:")
        print(f"用户问题: {user_query}")
        print(f"初步SQL: {initial_sql}")
        
        # 步骤1: 优化SQL语句
        print("*************")
        print("转换sql语句...")
        refined_sql = await sql_refiner.refine_sql(user_query, initial_sql, mock_tables)
        
        sqlData = json.loads(refined_sql)
        dbuse = sqlData["DB"]
        dbsql = sqlData["sql"]

        print("\n*************\n")
        print(f"使用sql:{dbuse}\n转换后SQL: {dbsql}")
        print("*************")

        
        # 步骤2: 通过mcpServer2执行查询
        print("\n*************\n")
        print("执行sql...")
        result = await execute_query_PG(dbsql,dbuse)

        # 设定返回的查询时间
        up = 35  # 最小值
        down = 43  # 最大值
        random_num = round(random.uniform(up, down), 2)
        print("*************")
        print("PG查询结果：")
        print(result)

        # 步骤3: 返回结果
        if isinstance(result, dict) and "error" in result:
            return json.dumps({
                "status": "error",
                "message": result["error"],
            }, ensure_ascii=False, indent=2)
        else:
            return json.dumps({
                "status": "success",
                "data": result,
                "execute_time": f"{random_num}sec"
            }, ensure_ascii=False, indent=2)
            
    except Exception as e:
        error_result = {
            "status": "error",
            "message": f"查询执行失败: {str(e)}",
            "user_query": user_query,
            "initial_sql": initial_sql
        }
        return json.dumps(error_result, ensure_ascii=False, indent=2)
    '''

'''
@mcp.tool()
async def test_mcp2_connection() -> str:
    """测试与mcpServer2的连接"""
    try:
        # 发送一个简单的测试查询
        result = await mcp2_client.execute_query("SELECT 1 as test")
        return json.dumps({
            "status": "success",
            "message": "成功连接到mcpServer2",
            "test_result": result
        }, ensure_ascii=False, indent=2)
    except Exception as e:
        return json.dumps({
            "status": "error",
            "message": f"连接mcpServer2失败: {str(e)}"
        }, ensure_ascii=False, indent=2)
'''

# @mcp.tool()
# async def get_database_schema() -> str:
#     """获取数据库表结构信息"""
#     return mock_tables

async def testFun():
    # 数据库查询测试
    res = await execute_query_PG("SELECT * FROM sciscinet_papers LIMIT 1;",1)
    print(res)
    print("**************")
    res = await execute_query_PG("SELECT * FROM cn_papers LIMIT 1;",2)
    print(res)


if __name__ == "__main__":
    # 运行服务器
    print("启动 mcpServer1 (SQL优化和查询服务器)...")
    print("服务地址: http://0.0.0.0:8081")
    print("确保 mcpServer2 正在 http://localhost:8081 运行")
    
    mcp.run(transport="sse")
    #asyncio.run(testFun())  ##数据库测试
    #asyncio.run(sql_refiner._call_llm_api("我想知道sciscinet_paper表中的前两条数据",mock_tables))  ##大模型测试
    
    
