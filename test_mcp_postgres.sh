#!/bin/bash
# MCP Postgres 服务测试脚本

BASE_URL="http://localhost:8090"

echo "=== 1. 健康检查 ==="
curl -s "${BASE_URL}/health" | jq .

echo -e "\n=== 2. 获取工具列表（需要 API_KEY） ==="
# 如果设置了 API_KEY，需要添加认证头
# curl -s -H "Authorization: Bearer YOUR_API_KEY" "${BASE_URL}/api/tools/list" | jq .
curl -s "${BASE_URL}/api/tools/list" | jq .

echo -e "\n=== 3. 测试查询：统计论文数量 ==="
curl -s -X POST "${BASE_URL}/api/sql_query" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT COUNT(*) as total_papers FROM sciscinet_papers"}' | jq .

echo -e "\n=== 4. 测试查询：查看前5篇论文 ==="
curl -s -X POST "${BASE_URL}/api/sql_query" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT paperid, title, year, citation_count FROM sciscinet_paperdetails LIMIT 5"}' | jq .

echo -e "\n=== 5. 测试查询：统计作者数量 ==="
curl -s -X POST "${BASE_URL}/api/sql_query" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT COUNT(*) as total_authors FROM sciscinet_authors"}' | jq .

echo -e "\n=== 6. 测试查询：按年份统计论文数 ==="
curl -s -X POST "${BASE_URL}/api/sql_query" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT year, COUNT(*) as count FROM sciscinet_papers WHERE year IS NOT NULL GROUP BY year ORDER BY year DESC LIMIT 10"}' | jq .

echo -e "\n=== 7. 测试查询：高引用论文 ==="
curl -s -X POST "${BASE_URL}/api/sql_query" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT paperid, citation_count, year FROM sciscinet_papers WHERE citation_count > 100 ORDER BY citation_count DESC LIMIT 5"}' | jq .

echo -e "\n=== 8. 测试查询：作者与论文关联 ==="
curl -s -X POST "${BASE_URL}/api/sql_query" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT p.paperid, p.title, a.author_name FROM sciscinet_paperdetails p JOIN sciscinet_paper_author_affiliation paa ON p.paperid = paa.paperid JOIN sciscinet_authors a ON paa.authorid = a.authorid LIMIT 5"}' | jq .

echo -e "\n=== 9. 测试只读保护：尝试 INSERT（应该失败） ==="
curl -s -X POST "${BASE_URL}/api/sql_query" \
  -H "Content-Type: application/json" \
  -d '{"sql": "INSERT INTO sciscinet_papers (paperid) VALUES (\x27test\x27)"}' | jq .

echo -e "\n=== 10. 测试 MCP 工具调用接口 ==="
curl -s -X POST "${BASE_URL}/api/tools/call" \
  -H "Content-Type: application/json" \
  -d '{"name": "sql.query", "arguments": {"sql": "SELECT COUNT(*) as total FROM sciscinet_affiliations"}}' | jq .

echo -e "\n测试完成！"
