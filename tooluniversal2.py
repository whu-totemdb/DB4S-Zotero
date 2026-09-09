"""
演示调用 ToolUniverse - UniProt_get_disease_variants_by_accession
功能：查询特定蛋白质（如 P04637）的疾病与突变关联信息
"""

import asyncio
import json
import os
import traceback
from mcp.client.streamable_http import streamablehttp_client
from mcp import ClientSession

# ToolUniverse SCP Server地址
ToolUniverse_SERVER_URL = os.getenv(
    "TOOLUNIVERSE_SERVER_URL",
    "https://scp.intern-ai.org.cn/api/v1/mcp/36/ToolUniverse",
)
SCP_HUB_API_KEY = os.getenv("SCP_HUB_API_KEY", "").strip()

class ToolUniverseClient:
    """使用MCP SDK的同步生物工具客户端"""
    
    def __init__(self, server_url: str):
        self.server_url = server_url
        self.session = None
        self.transport = None
        self.session_ctx = None
        
    async def connect(self):
        """建立连接并初始化会话"""
        print(f"\n{'='*80}")
        print("连接到同步 ToolUniverse MCP服务器")
        try:
            if not SCP_HUB_API_KEY:
                raise RuntimeError("缺少环境变量 SCP_HUB_API_KEY，请先设置你的 ToolUniverse API Key。")
            self.transport = streamablehttp_client(
                url=self.server_url,
                # 从环境变量读取，避免把密钥写进代码仓库
                headers={"SCP-HUB-API-KEY": SCP_HUB_API_KEY},
            )
            self.read, self.write, self.get_session_id = await self.transport.__aenter__()
            self.session_ctx = ClientSession(self.read, self.write)
            self.session = await self.session_ctx.__aenter__()
            await self.session.initialize()
            print(f"✓ 连接成功 (会话ID: {self.get_session_id()})")
            print(f"{'='*80}\n")
            return True
        except Exception as e:
            print(f"✗ 连接失败: {e}")
            return False
    
    async def disconnect(self):
        """断开连接"""
        try:
            if self.session: await self.session_ctx.__aexit__(None, None, None)
            if self.transport: await self.transport.__aexit__(None, None, None)
            print("\n✓ 已断开连接\n")
        except Exception:
            pass

    def parse_result(self, result):
        """解析MCP工具调用结果"""
        try:
            if hasattr(result, 'content') and result.content:
                content = result.content[0]
                if hasattr(content, 'text'):
                    try:
                        return json.loads(content.text)
                    except json.JSONDecodeError:
                        return content.text
            return str(result)
        except Exception as e:
            return {"error": str(e)}

async def main():
    client = ToolUniverseClient(ToolUniverse_SERVER_URL)
    if not await client.connect(): return

    try:
        # =====================================================================
        # 核心：调用刚才发现的突变与疾病查询工具
        # =====================================================================
        target_tool = "UniProt_get_disease_variants_by_accession"
        target_accession = "P04637" # p53 蛋白的编号
        
        print(f"🔬 正在调用工具: {target_tool}...")
        print(f"   查询参数: accession = '{target_accession}'\n")
        
        result = await client.session.call_tool(
            target_tool,
            arguments={
                "accession": target_accession
            }
        )
        
        # =====================================================================
        # 打印结果
        # =====================================================================
        print("--- 调用结果 (部分展示) ---")
        result_data = client.parse_result(result)
        
        # 因为突变数据可能非常庞大，为了避免刷屏，我们做一点优雅的处理
        if isinstance(result_data, dict) and 'features' in result_data:
            features = result_data['features']
            print(f"✅ 成功获取数据！共找到 {len(features)} 条突变/变异记录。\n")
            
            # 仅展示前 3 条突变记录作为示例
            print("展示前 3 条记录：")
            preview_data = features[:3]
            print(json.dumps(preview_data, indent=2, ensure_ascii=False))
            print(f"\n... (省略后续 {len(features) - 3} 条记录) ...")
        else:
            # 如果结构不符合预期，直接全部打印
            print(json.dumps(result_data, indent=2, ensure_ascii=False) if isinstance(result_data, (dict, list)) else result_data)

    except Exception as e:
        print(f"\n❌ 调用过程中出错: {e}")
        traceback.print_exc()
    finally:
        await client.disconnect()

if __name__ == '__main__':
    asyncio.run(main())