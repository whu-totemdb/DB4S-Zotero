import asyncio
import json
import time
import os
from fastmcp import Client
from fastmcp.client.transports import StreamableHttpTransport

# Server configuration
HEADERS = {
    "SCP-HUB-API-KEY": os.getenv("SCP_HUB_API_KEY", "")
}

class InternAgentClient:
    """Client for InternAgent Scientific Tools MCP server"""
    
    def __init__(self, server_url: str, headers: dict = None):
        self.server_url = server_url
        self.headers = headers or {}
        self.client = None

    async def connect(self):
        """Establish connection and initialize session"""
        print(f"{'='*80}")
        print("Connecting to InternAgent Scientific Tools MCP Server")
        print(f"{'='*80}")
        print(f"Server URL: {self.server_url}")
        print(f"Protocol: streamable-http")
        try:
            transport = StreamableHttpTransport(
                url=self.server_url,
                headers=self.headers
            )
            self.client = Client(transport)
            await self.client.__aenter__()
            print(f"✓ Connected successfully")
            print(f"{'='*80}\n")
            return True
        except Exception as e:
            print(f"✗ Connection failed: {e}")
            return False

    async def disconnect(self):
        """Disconnect from server"""
        try:
            if self.client:
                await self.client.__aexit__(None, None, None)
            print("\n✓ Disconnected\n")
        except Exception as e:
            print(f"✗ Error during disconnect: {e}")

    def _parse_result(self, result):
        """Parse MCP tool call result with crash handling"""
        try:
            if hasattr(result, 'content') and result.content:
                content = result.content[0]
                if hasattr(content, 'text'):
                    text_str = content.text.strip()
                    try:
                        return json.loads(text_str)
                    except json.JSONDecodeError:
                        # 拦截服务端返回的非 JSON 原生报错文本
                        return {"status": "backend_crash", "raw_text": text_str}
            return str(result)
        except Exception as e:
            return {"error": f"Failed to parse result: {e}", "raw": str(result)}

    async def execute_meta_analysis(self, prompt: str, max_polling_time: int = 300, poll_interval: int = 5):
        """
        Execute MetaAnalysis using start -> poll pattern
        """
        print(f"\n{'='*80}")
        print("Starting Automated MetaAnalysis Task")
        print(f"{'='*80}")
        print(f"Prompt: {prompt}\n")

        # ==========================================
        # Step 1: Start the task
        # ==========================================
        print("[1/2] Initiating task...")
        
        # 根据 Schema 构造 payload，type 默认为 table
        start_payload = {
            "prompt": prompt,
            "type": "table" 
        }
        
        # 调用 MetaAnalysis 的启动工具
        start_result = await self.client.call_tool("scp_start_MetaAnalysis", start_payload)
        parsed_start = self._parse_result(start_result)
        
        task_id = None
        if isinstance(parsed_start, dict):
            task_id = parsed_start.get("scp_output", {}).get("callback", {}).get("task_id")
            if not task_id: 
                 task_id = parsed_start.get("task_id") or parsed_start.get("data", {}).get("task_id")
        elif isinstance(parsed_start, str):
            task_id = parsed_start.strip()

        if not task_id:
            print(f"✗ Failed to extract task_id. Raw response:\n{parsed_start}")
            return None

        print(f"✓ Task started successfully. Task ID: {task_id}")

        # ==========================================
        # Step 2: Poll for results
        # ==========================================
        print(f"\n[2/2] Polling for results (interval: {poll_interval}s)...")
        
        query_payload = {
            "scp_input": {
                "callback": {
                    "task_id": task_id
                }
            }
        }

        start_time = time.time()
        
        while True:
            if time.time() - start_time > max_polling_time:
                print(f"\n✗ Polling timed out after {max_polling_time} seconds.")
                return None

            # 调用 MetaAnalysis 的查询工具
            query_result = await self.client.call_tool("scp_query_MetaAnalysis", query_payload)
            parsed_query = self._parse_result(query_result)
            
            current_time_str = time.strftime('%H:%M:%S')
            
            if isinstance(parsed_query, dict):
                if parsed_query.get("status") == "backend_crash":
                    print(f"\n[{current_time_str}] ✗ 远程服务端任务崩溃 (Backend Task Crashed):")
                    print(parsed_query.get("raw_text"))
                    print("\n提示: 看来整个异步调度框架都存在 Pydantic 校验冲突的问题。")
                    return None
                
                print(f"\n[{current_time_str}] Query Result:")
                print(json.dumps(parsed_query, ensure_ascii=False, indent=2))

                data_body = parsed_query.get("scp_output", parsed_query)
                status_str = str(data_body.get("status", data_body.get("state", ""))).lower()
                
                if status_str in ["completed", "finished", "success", "done"]:
                    print(f"\n{'='*80}")
                    print("✓ Task Completed Successfully!")
                    print(f"{'='*80}")
                    return parsed_query
                elif status_str in ["failed", "error", "cancelled"]:
                    print(f"\n✗ Task terminated with status: {status_str}")
                    return parsed_query
            else:
                print(f"\n[{current_time_str}] Unrecognized response type: {parsed_query}")
            
            await asyncio.sleep(poll_interval)


async def main():
    print(f"\n{'='*80}")
    print("MCP MetaAnalysis Automation Demo")
    print(f"{'='*80}\n")
    
    client = InternAgentClient("https://scp.intern-ai.org.cn/api/v1/mcp/28/InternAgent", HEADERS)
    if not await client.connect():
        return

    # 测试 MetaAnalysis 的一个典型 prompt
    research_prompt = "Conduct a meta-analysis on the efficacy of aspirin for cardiovascular disease prevention."
    
    final_result = await client.execute_meta_analysis(
        prompt=research_prompt, 
        max_polling_time=600,  
        poll_interval=10       
    )

    if final_result:
        print("\nFinal Data Retrieved.")
    
    await client.disconnect()

if __name__ == '__main__':
    asyncio.run(main())
