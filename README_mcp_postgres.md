# MCP Postgres 服务器部署指南

## 快速开始

### 1. 测试数据库连接

在启动服务前，先测试数据库连接：

```bash
# 使用默认配置测试
python3 test_db_connection.py

# 或指定自定义连接字符串
python3 test_db_connection.py "postgresql://user:pass@10.254.22.26:5432/dbname"
```

### 2. 启动服务

```bash
# 基本启动（使用默认配置）
python3 mcp_postgres_server.py --host 0.0.0.0 --port 8090

# 使用环境变量配置
export DB_URL="postgresql://postgres:postgres@10.254.22.26:5432/postgres"
export API_KEY="your-secret-key"  # 可选，用于API认证
export DB_TIMEOUT=30  # 连接超时（秒），默认10
export DB_MAX_SIZE=20  # 最大连接数，默认10
export DB_MIN_SIZE=2   # 最小连接数，默认2

python3 mcp_postgres_server.py --host 0.0.0.0 --port 8090
```

### 3. 后台运行

```bash
# 使用 nohup
nohup python3 mcp_postgres_server.py --host 0.0.0.0 --port 8090 > mcp_postgres.log 2>&1 &

# 使用 screen
screen -S mcp_postgres
python3 mcp_postgres_server.py --host 0.0.0.0 --port 8090
# 按 Ctrl+A+D 退出 screen

# 使用 systemd (创建服务文件)
sudo nano /etc/systemd/system/mcp-postgres.service
```

### 4. 测试服务

```bash
# 健康检查
curl http://localhost:8090/health

# 运行完整测试套件
chmod +x test_mcp_postgres.sh
./test_mcp_postgres.sh
```

## 连接内网数据库的几种方式

### 方式1: 直接连接（如果服务器在内网）

```bash
export DB_URL="postgresql://postgres:postgres@10.254.22.26:5432/postgres"
```

### 方式2: SSH 隧道（推荐）

在外网服务器上建立 SSH 隧道：

```bash
# 建立隧道（在后台运行）
ssh -f -N -L 5432:10.254.22.26:5432 user@jump_server

# 然后使用本地端口连接
export DB_URL="postgresql://postgres:postgres@127.0.0.1:5432/postgres"
```

### 方式3: VPN 连接

如果服务器已连接到 VPN，直接使用内网 IP：

```bash
export DB_URL="postgresql://postgres:postgres@10.254.22.26:5432/postgres"
```

## 安全配置

### 1. 创建只读数据库用户

```sql
-- 连接到 PostgreSQL
psql -h 10.254.22.26 -U postgres -d postgres

-- 创建只读用户
CREATE ROLE readonly LOGIN PASSWORD 'strong_password';

-- 授予连接权限
GRANT CONNECT ON DATABASE your_database TO readonly;

-- 授予 schema 使用权限
GRANT USAGE ON SCHEMA public TO readonly;

-- 授予表查询权限
GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly;

-- 设置默认权限（新表自动授予）
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO readonly;

-- 强制只读事务
ALTER ROLE readonly SET default_transaction_read_only = on;
```

### 2. 使用只读用户连接

```bash
export DB_URL="postgresql://readonly:strong_password@10.254.22.26:5432/your_database"
```

### 3. 启用 API 密钥认证

```bash
export API_KEY="your-very-secret-api-key"
```

## 环境变量说明

| 变量名 | 说明 | 默认值 | 必需 |
|--------|------|--------|------|
| `DB_URL` | PostgreSQL 连接字符串 | `postgresql://postgres:postgres@10.254.22.26:5432/postgres` | 是 |
| `API_KEY` | API 认证密钥（可选） | 空 | 否 |
| `DB_TIMEOUT` | 连接超时时间（秒） | 10 | 否 |
| `DB_MAX_SIZE` | 连接池最大连接数 | 10 | 否 |
| `DB_MIN_SIZE` | 连接池最小连接数 | 2 | 否 |

## API 端点

### 健康检查
```bash
GET /health
```

### 获取工具列表
```bash
GET /api/tools/list
# 如果设置了 API_KEY，需要添加:
# Authorization: Bearer YOUR_API_KEY
```

### 执行 SQL 查询
```bash
POST /api/sql_query
Content-Type: application/json

{
  "sql": "SELECT COUNT(*) FROM sciscinet_papers"
}
```

### MCP 工具调用
```bash
POST /api/tools/call
Content-Type: application/json

{
  "name": "sql.query",
  "arguments": {
    "sql": "SELECT * FROM sciscinet_papers LIMIT 10"
  }
}
```

## 故障排查

### 连接超时

1. **检查网络连通性**
   ```bash
   ping 10.254.22.26
   telnet 10.254.22.26 5432
   ```

2. **检查防火墙规则**
   ```bash
   # 确保防火墙允许访问
   sudo ufw allow from YOUR_SERVER_IP to 10.254.22.26 port 5432
   ```

3. **使用 SSH 隧道**
   如果无法直接连接，使用 SSH 隧道作为中转

4. **增加超时时间**
   ```bash
   export DB_TIMEOUT=30
   ```

### 认证失败

1. **检查用户名和密码**
   ```bash
   python3 test_db_connection.py
   ```

2. **检查数据库用户权限**
   ```sql
   \du  -- 列出所有用户
   ```

### 权限错误

1. **确保用户有 SELECT 权限**
   ```sql
   GRANT SELECT ON ALL TABLES IN SCHEMA public TO your_user;
   ```

2. **检查只读模式**
   ```sql
   ALTER ROLE your_user SET default_transaction_read_only = on;
   ```

## Systemd 服务配置示例

创建 `/etc/systemd/system/mcp-postgres.service`:

```ini
[Unit]
Description=MCP Postgres Server
After=network.target

[Service]
Type=simple
User=your_user
WorkingDirectory=/home/your_user/zotero
Environment="DB_URL=postgresql://readonly:password@127.0.0.1:5432/dbname"
Environment="API_KEY=your-secret-key"
Environment="DB_TIMEOUT=30"
ExecStart=/usr/bin/python3 /home/your_user/zotero/mcp_postgres_server.py --host 0.0.0.0 --port 8090
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

启用服务：
```bash
sudo systemctl daemon-reload
sudo systemctl enable mcp-postgres
sudo systemctl start mcp-postgres
sudo systemctl status mcp-postgres
```
