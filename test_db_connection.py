#!/usr/bin/env python3
"""
数据库连接测试脚本
用于诊断 PostgreSQL 连接问题
"""
import os
import sys
import asyncio
import asyncpg
from urllib.parse import urlparse

def parse_db_url(db_url: str):
    """解析数据库连接字符串"""
    try:
        parsed = urlparse(db_url)
        return {
            'host': parsed.hostname,
            'port': parsed.port or 5432,
            'user': parsed.username,
            'password': parsed.password,
            'database': parsed.path.lstrip('/')
        }
    except Exception as e:
        print(f"解析 DB_URL 失败: {e}")
        return None

async def test_connection(db_url: str, timeout: int = 5):
    """测试数据库连接"""
    print("=" * 60)
    print("PostgreSQL 连接测试")
    print("=" * 60)
    
    # 解析连接信息
    db_info = parse_db_url(db_url)
    if not db_info:
        return False
    
    print(f"\n连接信息:")
    print(f"  主机: {db_info['host']}")
    print(f"  端口: {db_info['port']}")
    print(f"  用户: {db_info['user']}")
    print(f"  数据库: {db_info['database']}")
    print(f"  超时: {timeout}秒")
    
    # 测试网络连通性
    print(f"\n[1/4] 测试网络连通性...")
    try:
        import socket
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        result = sock.connect_ex((db_info['host'], db_info['port']))
        sock.close()
        
        if result == 0:
            print(f"  ✓ 端口 {db_info['port']} 可访问")
        else:
            print(f"  ✗ 无法连接到 {db_info['host']}:{db_info['port']}")
            print(f"    错误代码: {result}")
            print(f"\n建议:")
            print(f"  - 检查服务器是否在同一网络")
            print(f"  - 检查防火墙规则")
            print(f"  - 如果数据库在内网，考虑使用 SSH 隧道:")
            print(f"    ssh -L 5432:{db_info['host']}:{db_info['port']} user@jump_server")
            return False
    except Exception as e:
        print(f"  ✗ 网络测试失败: {e}")
        return False
    
    # 测试 PostgreSQL 连接
    print(f"\n[2/4] 测试 PostgreSQL 连接...")
    try:
        conn = await asyncio.wait_for(
            asyncpg.connect(
                host=db_info['host'],
                port=db_info['port'],
                user=db_info['user'],
                password=db_info['password'],
                database=db_info['database'],
                timeout=timeout
            ),
            timeout=timeout
        )
        print(f"  ✓ 连接成功！")
        
        # 获取数据库信息
        print(f"\n[3/4] 获取数据库信息...")
        version = await conn.fetchval("SELECT version()")
        print(f"  PostgreSQL 版本: {version.split(',')[0] if version else '未知'}")
        
        db_name = await conn.fetchval("SELECT current_database()")
        print(f"  当前数据库: {db_name}")
        
        user = await conn.fetchval("SELECT current_user")
        print(f"  当前用户: {user}")
        
        # 测试查询权限
        print(f"\n[4/4] 测试查询权限...")
        try:
            # 尝试查询一个系统表
            count = await conn.fetchval("SELECT COUNT(*) FROM pg_tables LIMIT 1")
            print(f"  ✓ 查询权限正常")
        except Exception as e:
            print(f"  ⚠ 查询测试失败: {e}")
        
        await conn.close()
        print(f"\n" + "=" * 60)
        print("✓ 所有测试通过！数据库连接正常。")
        print("=" * 60)
        return True
        
    except asyncio.TimeoutError:
        print(f"  ✗ 连接超时（{timeout}秒）")
        print(f"\n建议:")
        print(f"  - 检查数据库服务器是否运行")
        print(f"  - 检查网络延迟")
        print(f"  - 增加超时时间: export DB_TIMEOUT=30")
        return False
    except asyncpg.exceptions.InvalidPasswordError:
        print(f"  ✗ 密码错误")
        print(f"\n建议:")
        print(f"  - 检查 DB_URL 中的密码是否正确")
        return False
    except asyncpg.exceptions.InvalidCatalogNameError:
        print(f"  ✗ 数据库 '{db_info['database']}' 不存在")
        print(f"\n建议:")
        print(f"  - 检查数据库名称是否正确")
        print(f"  - 列出可用数据库: psql -h {db_info['host']} -U {db_info['user']} -l")
        return False
    except asyncpg.exceptions.PostgresError as e:
        print(f"  ✗ PostgreSQL 错误: {e}")
        return False
    except Exception as e:
        print(f"  ✗ 连接失败: {type(e).__name__}: {e}")
        return False

def main():
    db_url = os.getenv("DB_URL", "postgresql://postgres:postgres@10.254.22.26:5432/postgres")
    timeout = int(os.getenv("DB_TIMEOUT", "10"))
    
    if len(sys.argv) > 1:
        db_url = sys.argv[1]
    
    print(f"使用连接字符串: {db_url.split('@')[1] if '@' in db_url else db_url}")
    
    success = asyncio.run(test_connection(db_url, timeout))
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()
