"""
演示调用 ToolUniverse - Tool_Finder_Keyword
功能：通过硬核关键词匹配，稳定检索目标工具
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
    """使用MCP SDK的通用客户端"""
    
    def __init__(self, server_url: str):
        self.server_url = server_url
        self.session = None
        self.transport = None
        self.session_ctx = None
        
    async def connect(self):
        """建立连接并初始化会话"""
        print(f"\n{'='*80}")
        print("正在连接到 ToolUniverse MCP服务器...")
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
            print(f"✓ 连接成功 (Session ID: {self.get_session_id()})")
            print(f"{'='*80}\n")
            return True
        except Exception as e:
            print(f"✗ 连接失败: {e}")
            traceback.print_exc()
            return False
    
    async def disconnect(self):
        """断开连接"""
        try:
            if self.session: await self.session_ctx.__aexit__(None, None, None)
            if self.transport: await self.transport.__aexit__(None, None, None)
            print("\n✓ 已断开连接\n")
        except Exception:
            pass

async def main():
    client = ToolUniverseClient(ToolUniverse_SERVER_URL)
    
    if not await client.connect():
        return

    try:
        # =====================================================================
        # 核心逻辑：使用 Tool_Finder_Keyword 进行精准打击
        # =====================================================================
        target_tool = "Tool_Finder_Keyword"
        
        # 直接使用核心关键词，而不是完整的自然语言句子
        search_keyword = "UniProt"
        
        print(f"🔍 正在调用 {target_tool} 查找合适的工具...")
        print(f"   搜索关键词: '{search_keyword}'\n")
        
        # 构造精简的参数，避免可选参数引发服务端解析错误
        arguments = {
            "description": search_keyword,
            "limit": 5
        }
        
        # 执行工具调用
        result = await client.session.call_tool(target_tool, arguments=arguments)
        
        # =====================================================================
        # 结果解析与展示
        # =====================================================================
        print("============================== 推荐结果 ==============================")
        if hasattr(result, 'content') and result.content:
            content_text = result.content[0].text
            try:
                # 尝试将返回的字符串格式化为漂亮的 JSON
                parsed_json = json.loads(content_text)
                print(json.dumps(parsed_json, indent=2, ensure_ascii=False))
            except json.JSONDecodeError:
                # 如果服务端返回的不是标准 JSON，直接打印原始文本
                print(content_text)
        else:
            print("⚠️ 返回结果依然为空，请检查服务端该工具是否正常运行。")
        print("======================================================================")

    except Exception as e:
        print(f"\n❌ 发生异常: {e}")
        traceback.print_exc()
    finally:
        await client.disconnect()

if __name__ == '__main__':
    asyncio.run(main())