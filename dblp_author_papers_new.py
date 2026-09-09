import psycopg2
import requests
from urllib.parse import quote, urlparse
from tqdm import tqdm
import re
import pandas as pd
from datetime import datetime
# ---------- 数据库连接 ----------
dblp_conn = psycopg2.connect(
    dbname="dblp",
    user="postgres",
    password="yourpassword",
    host="localhost",
    port="5432"
)

scisci_conn = psycopg2.connect(
    dbname="SciSciNetV2",
    user="postgres",
    password="yourpassword",
    host="localhost",
    port="5432"
)

# ---------- 用户输入 ----------
author_name = input("请输入作者姓名：").strip()
fields_input = input(
    "请输入要导出的字段（用英文逗号分隔，留空则导出全部字段）\n"
    "可选字段：论文名称, DOI, 机构名称, 期刊名称, ISSN, 出版商, ISBN, 是否国际合著, 本人排序, 发表年份\n"
    "字段选择: "
).strip()

all_fields = [
    '论文名称', 'DOI', '机构名称', '期刊名称',
    'ISSN', '出版商', 'ISBN', '是否国际合著', '本人排序', '发表年份'
]
selected_fields = (
    [f.strip() for f in fields_input.split(",") if f.strip()]
    if fields_input else all_fields
)

# ---------- 工具函数 ----------
def extract_doi(ee: str):
    """从 ee 字段中提取 DOI"""
    if not ee:
        return None
    ee = ee.strip()
    if ee.startswith("https://doi.org/") or ee.startswith("http://doi.org/"):
        return ee.split("doi.org/")[-1]
    elif ee.startswith("10."):
        return ee
    elif "doi" in ee.lower():
        parsed = urlparse(ee)
        if "doi.org" in parsed.netloc:
            return parsed.path.strip("/")
    return None

def parse_crossref_data(data):
    affiliations, countries = [], []
    for a in data.get('author', []):
        aff_list = a.get('affiliation', [])
        for aff in aff_list:
            aff_name = aff.get('name')
            aff_country = aff.get('country')
            if aff_name:
                affiliations.append(aff_name)
            if aff_country:
                countries.append(aff_country)
    return {
        'DOI': data.get('DOI', ''),
        '机构名称': affiliations,
        '期刊名称': data.get('container-title', [''])[0],
        'ISSN': ', '.join(data.get('ISSN', [])),
        '出版商': data.get('publisher', ''),
        'ISBN': ', '.join(data.get('ISBN', [])) if 'ISBN' in data else '',
        '国家列表': list(set(countries)),
        'author': data.get('author', [])
    }

def fetch_crossref_by_doi(doi: str):
    """根据 DOI 从 Crossref 获取详细信息"""
    try:
        url = f"https://api.crossref.org/works/{quote(doi)}"
        r = requests.get(url, timeout=10)
        if r.status_code != 200:
            return {}
        return parse_crossref_data(r.json().get('message', {}))
    except Exception:
        return {}


def fetch_crossref_by_title(title: str):
    """根据标题在 Crossref 搜索论文"""
    try:
        url = f"https://api.crossref.org/works?query.title={quote(title)}&rows=1"
        r = requests.get(url, timeout=10)
        if r.status_code != 200:
            return {}
        items = r.json().get('message', {}).get('items', [])
        if not items:
            return {}
        return parse_crossref_data(items[0])
    except Exception:
        return {}

def get_country_from_affiliation(affiliation_name: str):
    """根据机构名在 SciSciNetV2 查找国家代码，使用关键词智能提取并模糊匹配（不直接去掉国家名）"""
    if not affiliation_name:
        return None

    keywords = [
        "University", "College", "Institute", "Academy", "Laboratory",
        "Company", "Corporation", "Inc", "Ltd", "Center", "Centre",
        "Hospital", "Research"
    ]

    aff_clean = affiliation_name.strip()
    parts = [p.strip() for p in re.split(r"[;,]", aff_clean) if p.strip()]
    candidates = []

    # 提取含有关键词的部分作为候选
    for p in parts:
        if any(k.lower() in p.lower() for k in keywords):
            candidates.append(p)

    # 若无关键词，尝试整体匹配
    if not candidates:
        candidates.append(aff_clean)

    # 同时添加组合形式（如 “School of Computer Science, Wuhan University”）
    for i in range(len(parts) - 1):
        combined = ", ".join(parts[i:i+2])
        if any(k.lower() in combined.lower() for k in keywords):
            candidates.append(combined)

    # 去重，保持顺序
    seen = set()
    candidates = [x for x in candidates if not (x in seen or seen.add(x))]
    # 依次模糊匹配数据库
    cur = scisci_conn.cursor()
    for cand in candidates:
        for pattern in [cand, f"%{cand}%", f"%{cand.split()[-1]}%"]:
            cur.execute("""
                SELECT country_code
                FROM sciscinet_affiliations
                WHERE affiliation_name ILIKE %s
                LIMIT 1
            """, (pattern,))
            row = cur.fetchone()
            if row:
                cur.close()
                return row[0]

    cur.close()
    return None

def fill_missing_from_scisci(record, author_name):
    """从 SciSciNetV2 补齐缺失字段（期刊、ISSN、出版商、本人机构、国际合著）"""
    doi = record.get('DOI', '')
    if not doi:
        return record
    if doi and not doi.startswith("http"):
        doi_full = f"https://doi.org/{doi}"
    else:
        doi_full = doi
    cur = scisci_conn.cursor()

    # ---------- 补齐期刊、ISSN、出版商 ----------
    if not record.get('期刊名称') or not record.get('ISSN') or not record.get('出版商'):
        cur.execute("""
            SELECT s.source_name, s.issn, s.publisher
            FROM sciscinet_papersources ps
            JOIN sciscinet_sources s ON ps.sourceid = s.sourceid 
            WHERE ps.paperid IN (
                SELECT paperid FROM sciscinet_paperdetails WHERE doi = %s
            )
            LIMIT 1
        """, (doi_full,))
        src_row = cur.fetchone()
        if src_row:
            source_name, issn, publisher = src_row
            if not record.get('期刊名称') and source_name:
                record['期刊名称'] = source_name
            if not record.get('ISSN') and issn:
                record['ISSN'] = issn
            if not record.get('出版商') and publisher:
                record['出版商'] = publisher

    # ---------- 补齐本人机构 + 国际合著 ----------
    if not record.get('机构名称') or record.get('是否国际合著') is None:
        cur.execute("""
            SELECT paa.authorid, paa.raw_affiliation_string, a.affiliation_name, a.country_code
            FROM sciscinet_paper_author_affiliation paa
            LEFT JOIN sciscinet_affiliations a
                ON paa.institutionid = a.institution_id
            WHERE paa.paperid IN (
                SELECT paperid FROM sciscinet_paperdetails WHERE doi = %s
            )
        """, (doi_full,))
        rows = cur.fetchall()

        if rows:
            # 查找本人机构
            my_affiliation = ''
            countries = []
            clean_name = re.sub(r'\s*\d{3,4}$', '', author_name).strip().lower()
            for r in rows:
                authorid, raw_aff, aff_name, country_code = r
                # 只匹配本人作者
                if clean_name in (raw_aff or '').lower() or clean_name in (aff_name or '').lower():
                    if aff_name:
                        my_affiliation = aff_name
                    elif raw_aff:
                        my_affiliation = raw_aff
                if country_code:
                    countries.append(country_code)

            if not record.get('机构名称'):
                record['机构名称'] = my_affiliation
            if record.get('是否国际合著') is None:
                record['是否国际合著'] = len(set(countries)) > 1 if countries else None

    cur.close()
    return record
    
# ---------- 查询作者及其论文 ----------
cur = dblp_conn.cursor()

cur.execute("""
    SELECT a.name, pa.author_order, p.title, p.year, p.ee, p.isbn
    FROM authors a
    JOIN publication_authors pa ON a.id = pa.author_id
    JOIN publications p ON pa.publication_id = p.id
    WHERE a.name = %s
      AND p.title NOT ILIKE 'Home Page'
    ORDER BY p.year DESC;
""", (author_name,))

rows = cur.fetchall()
if not rows:
    print("未找到该作者的论文记录。")
    exit()
# ---------- 处理论文 ----------
records = []

print("\n📖 获取 Crossref 元数据中...")
for row in tqdm(rows):
    name, author_order, title, year, ee, isbn = row
    doi = extract_doi(ee)
    # ---------- 获取 Crossref 数据 ----------
    crossref_data = {}
    if doi:
        crossref_data = fetch_crossref_by_doi(doi)
        if not crossref_data or not crossref_data.get("author"):
            print(f"⚠️ DOI 查询失败，尝试使用标题搜索: {title}")
            crossref_data = fetch_crossref_by_title(title)
    else:
        crossref_data = fetch_crossref_by_title(title)

    authors_data = crossref_data.get("author", [])  # 原始作者列表
    affliations = crossref_data.get("机构名称", [])
    # 获取本人机构名称
    my_affiliation = ''
    # 🧠 匹配本人机构时再去掉序号（如 "Wang Yi 0001" -> "Wang Yi"）
    clean_name = re.sub(r'\s*\d{3,4}$', '', name).strip().lower()

    for author in authors_data:
        crossref_name = author.get('given', '').lower() + " " + author.get('family', '').lower()
        if clean_name in author.get('given', '').lower() + " " + author.get('family', '').lower():
            aff_list = author.get('affiliation', [])
            if aff_list:
                my_affiliation = aff_list[0].get('name', '')
            break

    # 如果 Crossref 没有国家信息，则从机构查
    country_list = crossref_data.get("国家列表", [])
    if not country_list and affliations:
        country_set = set()
        for aff in affliations:
            code = get_country_from_affiliation(aff)
            if code:
                country_set.add(code)
        country_list = list(country_set)

    # 调试输出
    print(f"\n🧩 论文标题: {title}")
    print(f"🏫 本人机构: {my_affiliation}")
    print(f"🌍 国家代码列表: {country_list}")

    # 计算国际合著（仅当国家信息存在时）
    if country_list:
        is_international = len(set(country_list)) > 1
    else:
        is_international = None  # 或者用 ''，取决于你是否希望 Excel 单元格为空

    record = {
        '论文名称': title,
        'DOI': crossref_data.get('DOI', doi or ''),
        '机构名称': my_affiliation,
        '期刊名称': crossref_data.get('期刊名称', ''),
        'ISSN': crossref_data.get('ISSN', ''),
        '出版商': crossref_data.get('出版商', ''),
        'ISBN': crossref_data.get('ISBN', isbn or ''),
        '是否国际合著': is_international,
        '本人排序': author_order,
        '发表年份': year
    }
        # ---------- 调用 SciSciNet 补齐函数 ----------
    record = fill_missing_from_scisci(record, name)

    # ---------- 根据用户选择字段保存 ----------
    records.append({k: v for k, v in record.items() if k in selected_fields})
cur.close()

print("\n✅ 查询完成，共获取到 {} 篇论文。".format(len(records)))

# ---------- 导出为 Excel ----------
if records:
    df = pd.DataFrame(records)
    # 自动生成文件名，如 dblp_王一_20251031.xlsx
    safe_name = re.sub(r'[\\/*?:"<>|]', "_", author_name)
    file_name = f"dblp_{safe_name}.xlsx"
    df.to_excel(file_name, index=False)

    print(f"\n📊 数据已保存到 Excel 文件: {file_name}")
else:
    print("\n⚠️ 未生成任何记录，未创建 Excel 文件。")

