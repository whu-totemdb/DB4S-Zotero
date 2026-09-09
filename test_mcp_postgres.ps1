# MCP Postgres 服务测试脚本 (PowerShell)

$BASE_URL = "http://localhost:8090"

Write-Host "=== 1. 健康检查 ===" -ForegroundColor Green
Invoke-RestMethod -Uri "${BASE_URL}/health" | ConvertTo-Json

Write-Host "`n=== 2. 获取工具列表 ===" -ForegroundColor Green
Invoke-RestMethod -Uri "${BASE_URL}/api/tools/list" | ConvertTo-Json

Write-Host "`n=== 3. 测试查询：统计论文数量 ===" -ForegroundColor Green
$body = @{sql = "SELECT COUNT(*) as total_papers FROM sciscinet_papers"} | ConvertTo-Json
Invoke-RestMethod -Uri "${BASE_URL}/api/sql_query" -Method Post -Body $body -ContentType "application/json" | ConvertTo-Json

Write-Host "`n=== 4. 测试查询：查看前5篇论文 ===" -ForegroundColor Green
$body = @{sql = "SELECT paperid, title, year, citation_count FROM sciscinet_paperdetails LIMIT 5"} | ConvertTo-Json
Invoke-RestMethod -Uri "${BASE_URL}/api/sql_query" -Method Post -Body $body -ContentType "application/json" | ConvertTo-Json

Write-Host "`n=== 5. 测试查询：统计作者数量 ===" -ForegroundColor Green
$body = @{sql = "SELECT COUNT(*) as total_authors FROM sciscinet_authors"} | ConvertTo-Json
Invoke-RestMethod -Uri "${BASE_URL}/api/sql_query" -Method Post -Body $body -ContentType "application/json" | ConvertTo-Json

Write-Host "`n=== 6. 测试查询：按年份统计论文数 ===" -ForegroundColor Green
$body = @{sql = "SELECT year, COUNT(*) as count FROM sciscinet_papers WHERE year IS NOT NULL GROUP BY year ORDER BY year DESC LIMIT 10"} | ConvertTo-Json
Invoke-RestMethod -Uri "${BASE_URL}/api/sql_query" -Method Post -Body $body -ContentType "application/json" | ConvertTo-Json

Write-Host "`n=== 7. 测试查询：高引用论文 ===" -ForegroundColor Green
$body = @{sql = "SELECT paperid, citation_count, year FROM sciscinet_papers WHERE citation_count > 100 ORDER BY citation_count DESC LIMIT 5"} | ConvertTo-Json
Invoke-RestMethod -Uri "${BASE_URL}/api/sql_query" -Method Post -Body $body -ContentType "application/json" | ConvertTo-Json

Write-Host "`n=== 8. 测试只读保护：尝试 INSERT（应该失败） ===" -ForegroundColor Yellow
try {
    $body = @{sql = "INSERT INTO sciscinet_papers (paperid) VALUES ('test')"} | ConvertTo-Json
    Invoke-RestMethod -Uri "${BASE_URL}/api/sql_query" -Method Post -Body $body -ContentType "application/json" | ConvertTo-Json
} catch {
    Write-Host "预期错误: $_" -ForegroundColor Red
}

Write-Host "`n=== 9. 测试 MCP 工具调用接口 ===" -ForegroundColor Green
$body = @{
    name = "sql.query"
    arguments = @{
        sql = "SELECT COUNT(*) as total FROM sciscinet_affiliations"
    }
} | ConvertTo-Json -Depth 3
Invoke-RestMethod -Uri "${BASE_URL}/api/tools/call" -Method Post -Body $body -ContentType "application/json" | ConvertTo-Json

Write-Host "`n测试完成！" -ForegroundColor Green
