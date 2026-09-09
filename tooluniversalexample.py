import asyncio
import json
import os
from mcp.client.streamable_http import streamablehttp_client
from mcp import ClientSession

ToolUniverse_SERVER_URL = "https://scp.intern-ai.org.cn/api/v1/mcp/36/ToolUniverse" ## ToolUniverse SCP Server地址

class ToolUniverseClient:
    """使用MCP SDK的同步生物工具客户端"""
    
    def __init__(self, server_url: str):
        self.server_url = server_url
        self.session = None
        
    async def connect(self):
        """建立连接并初始化会话"""
        print(f"\n{'='*80}")
        print("连接到同步 ToolUniverse MCP服务器")
        print(f"{'='*80}")
        print(f"服务器地址: {self.server_url}")
        try:
            # 建立streamable-http传输连接
            self.transport = streamablehttp_client(
                url=self.server_url,
                headers={"SCP-HUB-API-KEY": os.getenv("SCP_HUB_API_KEY", "")}
            )
            self.read, self.write, self.get_session_id = await self.transport.__aenter__()
            
            # 创建客户端会话
            self.session_ctx = ClientSession(self.read, self.write)
            self.session = await self.session_ctx.__aenter__()
            
            # 初始化会话
            await self.session.initialize()
            session_id = self.get_session_id()
            
            print(f"✓ 连接成功")
            print(f"✓ 会话ID: {session_id}")
            print(f"{'='*80}\n")
            return True
            
        except Exception as e:
            print(f"✗ 连接失败: {e}")
            import traceback
            traceback.print_exc()
            return False
    
    async def disconnect(self):
        """断开连接"""
        try:
            if self.session:
                await self.session_ctx.__aexit__(None, None, None)
            if hasattr(self, 'transport'):
                await self.transport.__aexit__(None, None, None)
            print("\n✓ 已断开连接\n")
        except Exception as e:
            print(f"✗ 断开连接时出错: {e}")
    
    async def list_tools(self):
        """列出所有可用工具"""
        print(f"\n{'='*80}")
        print("正在获取服务器工具列表...")
        print(f"{'='*80}")
        
        try:
            tools_list = await self.session.list_tools()
            print(f"\n可用工具 (共{len(tools_list.tools)}个):\n")
            
            for i, tool in enumerate(tools_list.tools, 1):
                print(f"{i:2d}. 工具名称: {tool.name}")
                if tool.description:
                    print(f"    描述: {tool.description}")
                print("-" * 40)
            
            print(f"\n✓ 工具列表获取成功")
            return tools_list.tools
            
        except Exception as e:
            print(f"✗ 列出工具失败: {e}")
            return []

    def parse_result(self, result):
        """解析MCP工具调用结果"""
        try:
            if hasattr(result, 'content') and result.content:
                content = result.content[0]
                if hasattr(content, 'text'):
                    return json.loads(content.text)
            
            return str(result)
        except Exception as e:
            return {"error": f"解析结果失败: {e}", "raw": str(result)}


async def main():
    client = ToolUniverseClient(ToolUniverse_SERVER_URL)
    
    # 1. 连接服务器
    if not await client.connect():
        print("connection failed")
        return
    
    # 2. 列出所有工具 (这次只执行这一步)
    await client.list_tools()
    
    # 注释掉了原先的 call_tool 代码，这样就不会打印出那一大堆蛋白质数据了
    # result = await client.session.call_tool(...) 
    
    # 3. 断开连接
    await client.disconnect()
    
if __name__ == '__main__':
    asyncio.run(main())
