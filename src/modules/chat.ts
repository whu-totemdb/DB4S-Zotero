import { getLocaleID } from "../utils/locale";
import { getPDFText, getPDFTitle } from "./pdf";
import { RAGEngine } from "./rag";
import { MCPClient } from "./mcp";
import { conversationStorage, paperGroupStorage } from "./storage";
import {
    getAuthorsFromItem,
    searchAuthorByName,
    getPapersByAuthorPID,
    importPaperToZotero,
    searchPaperByTitleAndGetAuthors,
    importPapersToCollection,
    DBLPPaper,
    getAuthorOrcidByPid
} from "./dblp";

interface MCPServerConfig {
    name: string;
    url: string;
    apiKey?: string;
}

const PROMPT_TEST = `
 hello 我是 
`;


const HELMDB_PROMPT = `
# HelmDB查询助手系统设定

你是一个专业的HelmDB查询助手。

## HelmDB多模数据库说明

HelmDB是一个多模数据库。其多模查询语言是对关系型sql的扩展，也就是说helmDB的sql兼容在兼容传统关系型sql的基础上，可以将一个图表使用match字句将其匹配结果转为关系表从而参与与其他关系表的连接。在图表的信息中，ELABEL指的是图关系的边表，VLABEL指的是图关系的顶点表，例如：
我要使用ref_network这个图表中查询paperid为123的论文的被引论文，我可以这样写：
\`\`\`sql
select count(*) from ref_network
match {(p1: paper_nodes)-[]->(p2: paper_nodes)}
where p1.paperid = 123;
\`\`\`

## HelmDB的schema:

### 关系表
- paper_details: paperid(text), doi(text), title(text), display_name(text), year(bigint), date(text), doctype(text), cited_by_count(bigint), is_retracted(boolean), is_paratext(boolean), cited_by_api_url(text), abstract_inverted_index(text), language(text)
- papertitleabstract: paperid(text), title(text), abstract_inverted_index(jsonb), language(text)
- affiliations: institution_uid(bigserial), institution_id(text), display_name(text), ror(text), homepage_url(text), country_code(text), type(text), h_index(double precision), productivity(double precision), avg_c10(double precision), avg_logc10(double precision)
- author_details: authorid(text), orcid(text), display_name(text), display_name_alternatives(text), works_count(bigint), cited_by_count(bigint), last_known_institution(text), works_api_url(text), updated_date(text)
- link_clinicaltrial: paperid(text), nct_id(text)
- newsfeed_metadata: paperid(text), doi(text), subj_id(text), newsfeed_id(text), timestamp(text)
- nih_metadata: paperid(text), doi(text), type_crossref(text), funder_display_name(text), award_id(text), funderid(text)
- link_nobellaureates: paperid(text), laureate_id(bigint), type(bigint)
- nsf_metadata: paperid(text), doi(text), type_crossref(text), funder_display_name(text), award_id(text), funderid(text)
- link_patents: paperid(text), patent(text), uspto(bigint)

### 节点表
- paper_nodes: id(bigint), properties(jsonb)
- affiliation_nodes: id(bigint), properties(jsonb)
- author_nodes: id(bigint), properties(jsonb)
- field_nodes: id(bigint), properties(jsonb)
- paper_author_affiliation_nodes: id(bigserial), paper_uid(bigint), author_uid(bigint), institution_uid(bigint), properties(jsonb)
- source_nodes: id(bigint), properties(jsonb)
- twitter_nodes: id(bigint), properties(jsonb)

### 边表
- ref: startid(bigint), startlabelid(oid), endid(bigint), endlabelid(oid), properties(jsonb) - 连接关系：paper_nodes → paper_nodes (论文引用关系)
- in_field: startid(bigint), startlabelid(oid), endid(bigint), endlabelid(oid), properties(jsonb) - 连接关系：paper_nodes → field_nodes (论文属于某领域)
- authored_in: startid(bigint), startlabelid(oid), endid(bigint), endlabelid(oid), properties(jsonb) - 连接关系：author_nodes → paper_author_affiliation_nodes (作者参与写作)
- writen_by: startid(bigint), startlabelid(oid), endid(bigint), endlabelid(oid), properties(jsonb) - 连接关系：paper_nodes → paper_author_affiliation_nodes (论文由作者撰写)
- affiliated_with: startid(bigint), startlabelid(oid), endid(bigint), endlabelid(oid), properties(jsonb) - 连接关系：affiliation_nodes → paper_author_affiliation_nodes (机构与作者关联)
- from_source: startid(bigint), startlabelid(oid), endid(bigint), endlabelid(oid), properties(jsonb) - 连接关系：paper_nodes → source_nodes (论文来源)
- nsf_network: startid(bigint), startlabelid(oid), endid(bigint), endlabelid(oid), properties(jsonb) - 连接关系：paper_nodes → nsf_nodes (NSF资助关系)

### 图表
- ref_network: ELABEL=[ref], VLABEL=[paper_nodes] (论文引用网络)
- in_field_network: ELABEL=[in_field], VLABEL=[paper_nodes, field_nodes] (论文领域分类网络)
- authored_in_network: ELABEL=[authored_in], VLABEL=[author_nodes, paper_author_affiliation_nodes] (作者写作关系网络)
- writen_by_network: ELABEL=[writen_by], VLABEL=[paper_nodes, paper_author_affiliation_nodes] (论文撰写关系网络)
- affiliated_with_network: ELABEL=[affiliated_with], VLABEL=[affiliation_nodes, paper_author_affiliation_nodes] (机构从属关系网络)
- from_source_network: ELABEL=[from_source], VLABEL=[paper_nodes, source_nodes] (论文来源网络)
- nsf_network: ELABEL=[nsf_network], VLABEL=[paper_nodes, nsf_nodes] (NSF资助网络)

### 向量表
- paper_vec: paperid(text), vec(vector(768))

## match字句使用
每个图表都以对应边表的名称加上"_network"作为表名，对每个图表可以在select字句后加上match字句来进行图运算从而得到一个关系型的结果用于和其他关系型的表进行运算。

## 注意事项
**数据库中的字段(除了作者姓名，机构名称，文章名称之外)全部都是英文的**
**部分中国作者的姓名是拼音，不要当成英文了**
**需要注意的是，由于查询可能很复杂，不要对查询的结果太苛刻，查询的结果如果有一些不完美的地方，能用就用，尽量不要二次查询，因为查询成本很高**

## 向用户的输出
读取用户的输入后：
1. 查询已有的MCP工具（除execute_query外）能否直接匹配用户查询，能匹配直接调用工具即可
2. 若问题可以拆分成调用多个工具来实现，那么调用多个工具，注意前一工具的输出和后一工具的输入是否匹配
3. 根据用户的输入写出在helmDB数据库中的sql语句和查询思路（要求指出使用的图结构）
4. 已有MCP工具（除execute_query外）不能匹配用户查询和不能完成查询的情况调用execute_query工具，发送用户的请求和你的sql语句进行执行并等待结果。请注意，需要在一个sql中查询出结果，也就是每次一个sql，避免多个sql。
5. 向用户展示helmDB的sql语句，查询思路，查询结果和查询时间

你的回答应该以这句话开头："您好，我是helmDB多模数据库智能查询助手，正在根据您的要求进行查询。"

注意：中国研究机构在计算机领域的排名是根据筛选出的计算机领域论文在查询中计算H指数得来的。
`;




// Global variable to store active tools for display
let activeMCPTools: any[] = [];
// Store connected clients globally for this session/window (since callLLM is stateless, we might need a better way if supporting multiple chats properly, but this works for single active chat)
let activeMCPClients: MCPClient[] = [];
// Map tool name to client
let toolToClientMap: { [key: string]: MCPClient } = {};
// Map sanitized tool name back to original name
let toolNameToOriginalMap: { [key: string]: string } = {};
// Selected tool names by user
let selectedToolNames: Set<string> = new Set();
// Track the active chat window
let activeChatWindow: Window | null = null;

interface ResumeAuthor {
    name: string;
    affiliation?: string;
    country?: string;
    keywords?: string;
    biography?: string;
    website?: string;
    orcid?: string;
}

interface ResumePublication {
    title: string;
    year?: string;
    venue?: string;
    doi?: string;
    url?: string;
    datasets?: ResumeDataset[];
}

interface ResumeDataset {
    title: string;
    year?: string;
    source?: string;
    description?: string;
    url?: string;
    paperTitle?: string;
}

interface ResumeProject {
    title: string;
    year?: string;
    role?: string;
    description?: string;
    url?: string;
}

function normalizeDoi(doi?: string): string {
    return (doi || "")
        .trim()
        .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
        .toLowerCase();
}

function normalizeOrcid(orcid?: string | null): string {
    return (orcid || "")
        .trim()
        .replace(/^https?:\/\/orcid\.org\//i, "")
        .toLowerCase();
}

function buildAuthorResumeHtml(payload: {
    author: ResumeAuthor;
    publications: ResumePublication[];
    datasets: ResumeDataset[];
    projects: ResumeProject[];
}) {
    const a = payload.author;

    const section = (title: string, inner: string, count?: number) => {
        const badge = typeof count === "number" ? `<span class="badge">${count}</span>` : "";
        const sectionClass = title === "个人简介" ? "section section-bio" : "section";
        return `
      <section class="${sectionClass}">
        <div class="section-head">
          <h2 class="section-title">${escapeHtml(title)} ${badge}</h2>
        </div>
        <div class="section-body">${inner}</div>
      </section>
    `;
    };

    const renderList = (items: Array<{ title: string; meta?: string; link?: string }>) => {
        if (!items.length) return `<div class="empty">暂无</div>`;
        return items
            .map((it) => {
                const title = escapeHtml(it.title);
                const meta = it.meta ? `<div class="item-meta">${escapeHtml(it.meta)}</div>` : "";
                return `<div class="item">
          <div class="item-title">${title}</div>
          ${meta}
        </div>`;
            })
            .join("");
    };

    const pubs = payload.publications.map((p) => {
        const parts = [];
        if (p.venue) parts.push(p.venue);
        if (p.year) parts.push(p.year);
        const datasetText = (p.datasets || [])
            .map((d) => d.title)
            .filter((t) => t)
            .join("、");
        if (datasetText) parts.push(`数据集: ${datasetText}`);
        const meta = parts.length > 0 ? parts.join(" · ") : "";
        const link = p.url || (p.doi ? `https://doi.org/${normalizeDoi(p.doi)}` : "");
        return { title: p.title, meta, link };
    });

    const datasets = payload.datasets.map((d) => {
        const parts = [];
        if (d.paperTitle) parts.push(`论文: ${d.paperTitle}`);
        if (d.source) parts.push(d.source);
        if (d.year) parts.push(d.year);
        if (d.description) parts.push(d.description);
        const meta = parts.length > 0 ? parts.join(" · ") : "";
        return { title: d.title, meta, link: d.url || "" };
    });

    const header = `
    <div class="header">
      <div>
        <div class="name">${escapeHtml(a.name || "未填写姓名")}</div>
        <div class="sub">
          ${a.affiliation ? `<span>${escapeHtml(a.affiliation)}</span>` : ""}
          ${a.country ? `<span> · ${escapeHtml(a.country)}</span>` : ""}
          ${a.website ? `<span> · <a href="${escapeHtml(a.website)}" target="_blank" rel="noreferrer">${escapeHtml(a.website)}</a></span>` : ""}
        </div>
        ${a.keywords ? `<div class="chips">${a.keywords.split(",").map((k) => `<span class="chip">${escapeHtml(k.trim())}</span>`).join("")}</div>` : ""}
      </div>
    </div>
  `;

    const bio = a.biography
        ? `<div class="bio">${escapeHtml(a.biography)}</div>`
        : "";

    return `
    <style>
      :root{ --bg:#ffffff; --text:#1f2328; --muted:#6b7280; --border:#e5e7eb; --card:#ffffff; --chip:#f3f4f6; --primary:#0b5bd3;}
      *{ box-sizing: border-box; }
      html, body{ margin:0; padding:0; background:#ffffff !important; color:var(--text); font-family: "Microsoft YaHei", "SimHei", "PingFang SC", "Hiragino Sans GB", system-ui, -apple-system, sans-serif; }
      .page{ padding:18px 20px 20px 20px; max-width: 210mm; margin: 0 auto; background:#ffffff; min-height: 100vh; }
      .header-bio-group{ page-break-inside: avoid; }
      .header{ display:flex; gap:12px; justify-content:space-between; align-items:flex-start; padding-bottom:10px; border-bottom:2px solid #1f2328; background:#ffffff; margin-bottom:14px; }
      .name{ font-size:24px; font-weight:700; letter-spacing:0.3px; color:#1f2328; margin-bottom:4px; }
      .sub{ font-size:11px; color:var(--muted); margin-top:2px; line-height:1.5; }
      .sub a{ color:var(--muted); text-decoration:none; }
      .sub a:hover{ text-decoration:underline; }
      .chips{ margin-top:6px; display:flex; flex-wrap:wrap; gap:4px; }
      .chip{ background:var(--chip); border:1px solid var(--border); padding:2px 6px; border-radius:2px; font-size:10px; color:#374151; }
      .section{ margin-top:14px; background:#ffffff; page-break-inside: avoid; }
      .section-bio{ page-break-after: avoid; margin-top:14px; }
      .header-bio-group .section-bio{ margin-top:14px; }
      .section-head{ display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; padding-bottom:4px; border-bottom:1px solid #1f2328; }
      .section-title{ font-size:13px; font-weight:700; margin:0; display:flex; align-items:center; gap:6px; color:#1f2328; text-transform: uppercase; letter-spacing:0.3px; }
      .badge{ font-size:9px; color:#374151; background:#f3f4f6; border:1px solid var(--border); padding:1px 5px; border-radius:2px; }
      .bio{ font-size:11px; color:#374151; line-height:1.6; white-space:pre-wrap; margin:0; }
      .empty{ font-size:11px; color:var(--muted); font-style:italic; }
      .item{ margin-bottom:8px; page-break-inside: avoid; }
      .item-title{ font-weight:600; font-size:12px; line-height:1.4; color:#1f2328; margin-bottom:2px; }
      .item-meta{ margin-top:1px; font-size:10px; color:var(--muted); line-height:1.4; }
      @media print{
        @page {
          size: A4;
          margin: 12mm 12mm 12mm 12mm;
          marks: none;
        }
        html, body{ margin:0; padding:0; background:#fff !important; }
        a{ color: #000; text-decoration: none; }
        .page{ padding:0; max-width:100%; margin:0; }
        .header-bio-group{ page-break-inside: avoid !important; page-break-after: avoid !important; }
        .header{ border-bottom:2px solid #000; padding-bottom:8px; margin-bottom:12px; }
        .section{ margin-top:12px; }
        .section-bio{ page-break-after: avoid !important; page-break-before: avoid !important; }
        .section-head{ border-bottom:1px solid #000; margin-bottom:6px; padding-bottom:3px; }
        .item{ margin-bottom:6px; }
        body {
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        * {
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
      }
    </style>
    <div class="page">
      <div class="header-bio-group">
        ${header}
        ${bio ? section("个人简介", bio) : ""}
      </div>
      ${section("论文", renderList(pubs), payload.publications.length)}
      ${section("数据集", renderList(datasets), payload.datasets.length)}
    </div>
    `;
}

function getDefaultDownloadsDirectory(): any {
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { Services } = (globalThis as any).ChromeUtils.importESModule(
            "resource://gre/modules/Services.sys.mjs"
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const Ci = (globalThis as any).Components.interfaces;
        return Services.dirsvc.get("DfltDwnld", Ci.nsIFile);
    } catch (e) {
        return ztoolkit.getGlobal("Zotero").getTempDirectory();
    }
}

function buildPdfFilePath(authorName?: string): string {
    const dir = getDefaultDownloadsDirectory();
    const name = (authorName || "resume").trim() || "resume";
    const safeBase = name.replace(/[\\/:*?"<>|]/g, "_");
    const stamp = new Date()
        .toISOString()
        .replace(/[:]/g, "")
        .replace(/\..+$/, "")
        .replace("T", "_");
    const fileName = `${safeBase}_CV_${stamp}.pdf`;
    const file = dir.clone();
    file.append(fileName);
    return file.path;
}

function buildResumeHtmlDocument(
    author: ResumeAuthor,
    publications: ResumePublication[],
    datasets: ResumeDataset[],
    projects: ResumeProject[]
): string {
    const bodyHtml = buildAuthorResumeHtml({ author, publications, datasets, projects });
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(author.name || "Resume")}</title>
  <script>
    (function() {
      let hasTriggered = false;
      function triggerPrint() {
        if (hasTriggered) return;
        hasTriggered = true;
        try {
          if (window.print) {
            window.print();
          }
        } catch (e) {
          console.error("触发打印失败:", e);
        }
      }
      if (document.readyState === "complete") {
        setTimeout(triggerPrint, 500);
      } else {
        window.addEventListener("load", function() {
          setTimeout(triggerPrint, 500);
        });
      }
    })();
  </script>
</head>
<body>
  ${bodyHtml}
</body>
</html>`;
}

function exportAuthorResumePdfInBrowser(
    author: ResumeAuthor,
    publications: ResumePublication[],
    datasets: ResumeDataset[],
    projects: ResumeProject[]
) {
    try {
        const suggestedPdfPath = buildPdfFilePath(author.name);
        const ZoteroGlobal = ztoolkit.getGlobal("Zotero") as any;
        if (!ZoteroGlobal || !ZoteroGlobal.getTempDirectory) {
            throw new Error("无法获取 Zotero 临时目录");
        }

        const tempDir = ZoteroGlobal.getTempDirectory();
        const name = (author.name || "resume").trim() || "resume";
        const safeBase = name.replace(/[\\/:*?"<>|]/g, "_");
        const stamp = new Date()
            .toISOString()
            .replace(/[:]/g, "")
            .replace(/\..+$/, "")
            .replace("T", "_");
        const htmlFileName = `${safeBase}_CV_${stamp}.html`;
        const pdfFileName = `${safeBase}_CV_${stamp}.pdf`;

        const htmlFile = tempDir.clone();
        htmlFile.append(htmlFileName);

        const fullHtml = buildResumeHtmlDocument(author, publications, datasets, projects);

        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const Cc = (globalThis as any).Components.classes;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const Ci = (globalThis as any).Components.interfaces;
            const foStream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(
                Ci.nsIFileOutputStream
            );
            foStream.init(htmlFile, 0x02 | 0x08 | 0x20, 0o644, 0);
            const converter = Cc["@mozilla.org/intl/converter-output-stream;1"].createInstance(
                Ci.nsIConverterOutputStream
            );
            converter.init(foStream, "UTF-8", 0, 0);
            converter.writeString(fullHtml);
            converter.close();
        } catch (writeErr) {
            ztoolkit.log("写入作者简历 HTML 失败:", writeErr);
            throw new Error("无法写入临时 HTML 文件");
        }

        try {
            ZoteroGlobal.launchFile(htmlFile);
        } catch (launchErr) {
            ztoolkit.log("通过浏览器打开 HTML 失败:", launchErr);
            throw new Error("无法通过浏览器打开简历 HTML 文件");
        }

        new ztoolkit.ProgressWindow(addon.data.config.addonName)
            .createLine({
                text:
                    `已在系统浏览器中打开简历，打印对话框将自动弹出。` +
                    `请选择"另存为 PDF"并保存。推荐文件名：${pdfFileName}（建议保存到：${suggestedPdfPath}）`,
                type: "default",
                progress: 100,
            })
            .show();
    } catch (e) {
        ztoolkit.log("导出作者简历失败:", e);
        const errorMsg = e instanceof Error ? e.message : String(e);
        ztoolkit.getGlobal("alert")("导出作者简历失败: " + errorMsg);
    }
}

function extractMcpJsonResult(res: any): any | null {
    if (!res) return null;
    if (res && typeof res === "object" && Array.isArray((res as any).content)) {
        const textParts = (res as any).content
            .filter((item: any) => item?.type === "text" && item.text)
            .map((item: any) => item.text);
        const joined = textParts.join("\n\n");
        if (!joined) return null;
        try {
            return JSON.parse(joined);
        } catch (e) {
            Zotero.debug(`[AI for Science] Failed to parse MCP text result: ${e}`);
            return null;
        }
    }
    return res;
}

function pickNodeTitle(node: any): string {
    if (typeof node === "string") return node;
    const props = node?.properties || {};
    return (
        node?.title ||
        node?.name ||
        node?.display_name ||
        props.title ||
        props.name ||
        props.display_name ||
        props.id ||
        node?.id ||
        "未命名"
    );
}

function pickNodeMeta(node: any): string {
    if (typeof node === "string") return "";
    const props = node?.properties || {};
    const parts: string[] = [];
    const year = props.year || node?.year;
    const source = props.source || node?.source || props.venue || node?.venue;
    const desc = props.description || node?.description;
    if (source) parts.push(String(source));
    if (year) parts.push(String(year));
    if (desc) parts.push(String(desc));
    return parts.join(" · ");
}

function pickNodeUrl(node: any): string | undefined {
    const props = node?.properties || {};
    return props.url || node?.url || props.homepage || node?.homepage;
}

function dedupeByTitle<T extends { title: string }>(items: T[]): T[] {
    const seen = new Set<string>();
    const result: T[] = [];
    for (const item of items) {
        const key = (item.title || "").trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(item);
    }
    return result;
}

function dedupeByTitleAndPaper<T extends { title: string; paperTitle?: string }>(items: T[]): T[] {
    const seen = new Set<string>();
    const result: T[] = [];
    for (const item of items) {
        const titleKey = (item.title || "").trim().toLowerCase();
        const paperKey = (item.paperTitle || "").trim().toLowerCase();
        const key = `${titleKey}__${paperKey}`;
        if (!titleKey || seen.has(key)) continue;
        seen.add(key);
        result.push(item);
    }
    return result;
}

async function callMcpToolByOriginalName(toolOriginalName: string, args: any): Promise<any | null> {
    if (activeMCPTools.length === 0) {
        await loadMCPTools();
    }
    const tool = activeMCPTools.find((t: any) =>
        t?.originalName === toolOriginalName || t?.function?.name === toolOriginalName
    );
    if (!tool) return null;
    const toolName = tool.function.name;
    const client = toolToClientMap[toolName];
    if (!client) return null;
    const res = await client.callTool(resolveToolNameForCall(toolName), args);
    return extractMcpJsonResult(res);
}

function getPaperDatasetDbConfig(): { url: string; user: string; password: string } {
    const prefsPrefix = addon.data.config.prefsPrefix;
    const url = (Zotero.Prefs.get(`${prefsPrefix}.paperDatasetDbUrl`) as string) || "";
    const user = (Zotero.Prefs.get(`${prefsPrefix}.paperDatasetDbUser`) as string) || "";
    const password = (Zotero.Prefs.get(`${prefsPrefix}.paperDatasetDbPassword`) as string) || "";
    return { url: url.trim(), user: user.trim(), password };
}

function buildNeo4jHttpEndpoint(baseUrl: string): string {
    const cleaned = (baseUrl || "").trim().replace(/\/+$/, "");
    if (!cleaned) return "";
    if (/\/db\/.+\/tx\/commit$/i.test(cleaned)) return cleaned;
    return `${cleaned}/db/neo4j/tx/commit`;
}

/**
 * 通过 OpenAlex API 查询作者的数据集（不依赖图数据库）
 * OpenAlex API: https://api.openalex.org/works?filter=author.orcid:{orcid},type:dataset
 */
async function fetchDatasetsByOrcidFromOpenAlex(orcid: string): Promise<ResumeDataset[]> {
    const normalized = normalizeOrcid(orcid);
    if (!normalized) return [];

    const datasets: ResumeDataset[] = [];
    try {
        // OpenAlex API: 查询该作者的所有数据集类型 works
        const url = `https://api.openalex.org/works?filter=author.orcid:${encodeURIComponent(`https://orcid.org/${normalized}`)},type:dataset&per-page=200&sort=publication_date:desc`;
        
        const response = await Zotero.HTTP.request("GET", url, {
            responseType: "json",
            timeout: 30000
        });

        if (response.status !== 200) {
            Zotero.debug(`[AI for Science] OpenAlex API returned status ${response.status}`);
            return [];
        }

        const data = response.response;
        const results = data?.results || [];
        
        for (const work of results) {
            const title = work?.title || work?.display_name || "未命名数据集";
            const year = work?.publication_year?.toString() || "";
            const doi = work?.doi ? work.doi.replace(/^https?:\/\//, "") : "";
            const url = work?.primary_location?.landing_page_url || work?.doi || (doi ? `https://doi.org/${doi}` : "");
            const description = work?.abstract || work?.summary || "";
            
            datasets.push({
                title,
                year,
                description,
                url,
                source: "OpenAlex"
            });
        }

        Zotero.debug(`[AI for Science] Found ${datasets.length} datasets from OpenAlex for ORCID ${normalized}`);
        return datasets;
    } catch (e) {
        Zotero.debug(`[AI for Science] Failed to fetch datasets from OpenAlex: ${e}`);
        return [];
    }
}

/**
 * 通过 DataCite API 查询作者的数据集（不依赖图数据库）
 * DataCite API: https://api.datacite.org/works?filter=creators.orcid:{orcid}&resource-type-id=dataset
 */
async function fetchDatasetsByOrcidFromDataCite(orcid: string): Promise<ResumeDataset[]> {
    const normalized = normalizeOrcid(orcid);
    if (!normalized) return [];

    const datasets: ResumeDataset[] = [];
    try {
        const url = `https://api.datacite.org/works?filter=creators.orcid:${encodeURIComponent(normalized)}&resource-type-id=dataset&page[size]=100`;
        
        const response = await Zotero.HTTP.request("GET", url, {
            responseType: "json",
            timeout: 30000
        });

        if (response.status !== 200) {
            Zotero.debug(`[AI for Science] DataCite API returned status ${response.status}`);
            return [];
        }

        const data = response.response;
        const items = data?.data || [];
        
        for (const item of items) {
            const attr = item?.attributes || {};
            const titles = attr?.titles || [];
            const title = titles[0]?.title || "未命名数据集";
            const year = attr?.publicationYear?.toString() || "";
            const doi = normalizeDoi(attr?.doi || "");
            const url = attr?.url || (doi ? `https://doi.org/${doi}` : "");
            const description = attr?.descriptions?.[0]?.description || "";
            const source = attr?.publisher || attr?.container?.title || "DataCite";
            
            datasets.push({
                title,
                year,
                description,
                url,
                source
            });
        }

        Zotero.debug(`[AI for Science] Found ${datasets.length} datasets from DataCite for ORCID ${normalized}`);
        return datasets;
    } catch (e) {
        Zotero.debug(`[AI for Science] Failed to fetch datasets from DataCite: ${e}`);
        return [];
    }
}

/**
 * 通过 ORCID 查询作者的数据集（优先使用 OpenAlex，失败则使用 DataCite，最后尝试图数据库）
 */
async function fetchDatasetsByOrcidFromDb(orcid: string): Promise<ResumeDataset[]> {
    const normalized = normalizeOrcid(orcid);
    if (!normalized) return [];

    // 优先使用 OpenAlex API（免费，无需图数据库）
    let datasets = await fetchDatasetsByOrcidFromOpenAlex(normalized);
    
    // 如果 OpenAlex 没有结果，尝试 DataCite
    if (datasets.length === 0) {
        datasets = await fetchDatasetsByOrcidFromDataCite(normalized);
    }

    // 如果仍然没有结果，且有图数据库配置，则尝试图数据库（作为最后备选）
    if (datasets.length === 0) {
        const { url, user, password } = getPaperDatasetDbConfig();
        const endpoint = buildNeo4jHttpEndpoint(url);
        if (endpoint) {
            try {
                const headers: Record<string, string> = {
                    "Content-Type": "application/json"
                };
                if (user) {
                    const auth = btoa(`${user}:${password || ""}`);
                    headers.Authorization = `Basic ${auth}`;
                }

                const cypher = `
MATCH (a:Author)
WHERE toLower(replace(replace(coalesce(a.orcid, a.orcid_id, a.orcidId, ""), "https://orcid.org/", ""), "http://orcid.org/", "")) = $orcid
WITH a
OPTIONAL MATCH (a)-[:AUTHOR_OF|:AUTHORED|:WROTE|:FIRST_AUTHOR|:CORRESPONDING_AUTHOR|:CO_AUTHOR]->(p:Paper)
OPTIONAL MATCH (a)-[:USES_DATASET|:USED_DATASET|:HAS_DATASET|:DATASET|:USES]->(d1:Dataset)
OPTIONAL MATCH (p)-[:USES_DATASET|:USED_DATASET|:HAS_DATASET|:DATASET|:USES|:USED_BY]->(d2:Dataset)
WITH collect(d1) + collect(d2) AS ds
UNWIND ds AS d
WITH DISTINCT d WHERE d IS NOT NULL
RETURN d { .*, id: id(d) } AS dataset
LIMIT $limit
`;

                const response = await Zotero.HTTP.request("POST", endpoint, {
                    headers,
                    body: JSON.stringify({
                        statements: [
                            {
                                statement: cypher,
                                parameters: { orcid: normalized, limit: 200 },
                                resultDataContents: ["row"]
                            }
                        ]
                    }),
                    responseType: "json",
                    timeout: 30000
                });

                const payload = response?.response;
                const errors = payload?.errors;
                if (Array.isArray(errors) && errors.length > 0) {
                    Zotero.debug(`[AI for Science] ORCID dataset query from DB failed: ${JSON.stringify(errors[0])}`);
                } else {
                    const rows = payload?.results?.[0]?.data || [];
                    rows.forEach((row: any) => {
                        const dataset = row?.row?.[0] ?? row?.row?.dataset ?? row?.dataset;
                        if (!dataset) return;
                        const node = typeof dataset === "object" ? { properties: dataset } : dataset;
                        datasets.push({
                            title: pickNodeTitle(node),
                            description: pickNodeMeta(node),
                            url: pickNodeUrl(node),
                            source: "Neo4j"
                        });
                    });
                }
            } catch (e) {
                Zotero.debug(`[AI for Science] Failed to query datasets by ORCID from DB: ${e}`);
            }
        }
    }

    return datasets;
}

function extractOrcidFromNode(node: any): string | null {
    const props = node?.properties || {};
    const orcid =
        props.orcid ||
        node?.orcid ||
        props.orcid_id ||
        node?.orcid_id ||
        props.orcidId ||
        node?.orcidId;
    return orcid ? String(orcid).trim() : null;
}

function extractAuthorNameFromNode(node: any): string | null {
    const props = node?.properties || {};
    const name =
        node?.display_name ||
        node?.author_name ||
        node?.raw_name ||
        props.display_name ||
        props.author_name ||
        props.raw_name ||
        node?.name ||
        props.name;
    return name ? String(name).trim() : null;
}

function extractPaperIdFromNode(node: any): { id: string; idType: "arxiv_id" | "openalex_id" } | null {
    const props = node?.properties || {};
    const arxivId = props.arxiv_id || node?.arxiv_id;
    if (arxivId) {
        return { id: String(arxivId).trim(), idType: "arxiv_id" };
    }
    const openalexId = props.openalex_id || node?.openalex_id;
    if (openalexId) {
        return { id: String(openalexId).trim(), idType: "openalex_id" };
    }
    const doi = props.doi || node?.doi;
    if (doi) {
        return { id: String(doi).trim(), idType: "openalex_id" };
    }
    return null;
}

function extractAuthorsFromPaperDetail(detail: any): any[] {
    const candidates: any[] = [];
    const pushAll = (arr: any) => {
        if (Array.isArray(arr)) {
            arr.forEach((a) => candidates.push(a));
        }
    };
    if (!detail) return candidates;
    pushAll(detail.authors);
    pushAll(detail.author);
    pushAll(detail.author_list);
    pushAll(detail?.properties?.authors);
    pushAll(detail?.properties?.author);
    return candidates;
}

function extractNodesFromPaperDetail(detail: any, keys: string[]): any[] {
    const candidates: any[] = [];
    const pushValue = (value: any) => {
        if (!value) return;
        if (Array.isArray(value)) {
            value.forEach((item) => candidates.push(item));
        } else {
            candidates.push(value);
        }
    };
    if (!detail) return candidates;
    keys.forEach((key) => {
        pushValue((detail as any)[key]);
        pushValue(detail?.properties?.[key]);
    });
    return candidates;
}

function extractDatasetsFromPaperDetail(detail: any): any[] {
    return extractNodesFromPaperDetail(detail, [
        "datasets",
        "dataset",
        "data_sets",
        "used_datasets",
        "used_dataset",
        "related_datasets",
        "dataset_list",
        "datasets_used"
    ]);
}

/**
 * 通过 DBLP 查询作者的 ORCID（不依赖 MCP）
 * 使用 DBLP 的 searchPaperByTitleAndGetAuthors 和 getAuthorOrcidByPid
 */
async function resolveAuthorOrcidFromDblp(
    authorName: string,
    paperTitles: string[] = []
): Promise<string | null> {
    if (!authorName) return null;

    // 如果有论文标题，先通过论文标题搜索作者
    if (paperTitles.length > 0) {
        for (const title of paperTitles) {
            try {
                const authors = await searchPaperByTitleAndGetAuthors(title);
                const matched = authors.find(a => 
                    normalizeNameForMatch(a.name) === normalizeNameForMatch(authorName)
                );
                if (matched && matched.pid) {
                    const orcid = await getAuthorOrcidByPid(matched.pid);
                    if (orcid) {
                        Zotero.debug(`[AI for Science] Found ORCID from DBLP for ${authorName}: ${orcid}`);
                        return orcid;
                    }
                }
            } catch (e) {
                Zotero.debug(`[AI for Science] Failed to resolve ORCID from paper "${title}": ${e}`);
            }
        }
    }

    // 如果通过论文标题没找到，尝试直接搜索作者
    try {
        const authorPid = await searchAuthorByName(authorName);
        if (authorPid) {
            const orcid = await getAuthorOrcidByPid(authorPid);
            if (orcid) {
                Zotero.debug(`[AI for Science] Found ORCID from DBLP for ${authorName}: ${orcid}`);
                return orcid;
            }
        }
    } catch (e) {
        Zotero.debug(`[AI for Science] Failed to resolve ORCID from DBLP: ${e}`);
    }
    
    return null;
}

/**
 * 获取作者的数据集和项目（仅使用 DBLP 和 OpenAlex API，不依赖 MCP）
 */
async function fetchAuthorDatasetsAndProjects(
    authorName: string,
    publications: ResumePublication[],
    orcid?: string
) {
    const datasets: ResumeDataset[] = [];

    // 如果没有提供 ORCID，尝试从 DBLP 获取
    let resolvedOrcid: string | null = orcid || null;
    if (!resolvedOrcid) {
        try {
            const paperTitles = publications.map((p) => p.title).filter((t) => t);
            resolvedOrcid = await resolveAuthorOrcidFromDblp(authorName, paperTitles);
        } catch (e) {
            Zotero.debug(`[AI for Science] Failed to resolve ORCID from DBLP: ${e}`);
        }
    }

    // 如果有 ORCID，使用 OpenAlex API 查询数据集
    if (resolvedOrcid) {
        try {
            const list = await fetchDatasetsByOrcidFromDb(resolvedOrcid);
            if (Array.isArray(list) && list.length > 0) {
                datasets.push(...list);
                Zotero.debug(`[AI for Science] Found ${list.length} datasets for ORCID ${resolvedOrcid}`);
            }
        } catch (e) {
            Zotero.debug(`[AI for Science] Failed to fetch datasets by ORCID: ${e}`);
        }
    } else {
        Zotero.debug(`[AI for Science] No ORCID found for ${authorName}, skipping dataset query`);
    }

    return {
        datasets: dedupeByTitleAndPaper(datasets),
        projects: []
    };
}

async function generateAuthorBiography(
    author: ResumeAuthor,
    publications: ResumePublication[],
    datasets: ResumeDataset[],
    projects: ResumeProject[],
): Promise<string> {
    const prefsPrefix = addon.data.config.prefsPrefix;
    const provider = Zotero.Prefs.get(`${prefsPrefix}.provider`) as string;
    if (!provider) return "";

    const pubText = publications.slice(0, 10)
        .map((p, i) => `${i + 1}. ${p.title}${p.year ? ` (${p.year})` : ""}`)
        .join("\n");
    const datasetText = datasets.slice(0, 10)
        .map((d, i) => `${i + 1}. ${d.title}`)
        .join("\n");
    const projectText = projects.slice(0, 10)
        .map((p, i) => `${i + 1}. ${p.title}`)
        .join("\n");

    const systemPrompt = "你是学术简历助手，请根据作者的论文和数据集信息，用中文生成简洁、专业的个人简介。";
    
    // 分析论文主题关键词
    const paperKeywords: string[] = [];
    publications.slice(0, 10).forEach(p => {
        const title = (p.title || "").toLowerCase();
        // 提取可能的领域关键词（简单启发式）
        if (title.includes("machine learning") || title.includes("深度学习") || title.includes("neural")) paperKeywords.push("机器学习");
        if (title.includes("database") || title.includes("数据") || title.includes("data")) paperKeywords.push("数据管理");
        if (title.includes("network") || title.includes("网络")) paperKeywords.push("网络");
        if (title.includes("algorithm") || title.includes("算法")) paperKeywords.push("算法");
        if (title.includes("system") || title.includes("系统")) paperKeywords.push("系统");
    });
    const uniqueKeywords = Array.from(new Set(paperKeywords)).slice(0, 5);
    const researchAreas = uniqueKeywords.length > 0 ? uniqueKeywords.join("、") : "计算机科学";
    
    const userPrompt = `作者信息：
姓名：${author.name || "未知"}
单位：${author.affiliation || "未知"}
研究领域：${researchAreas}

论文列表（共${publications.length}篇，显示前10篇）：
${pubText || "暂无"}

数据集列表（共${datasets.length}个，显示前10个）：
${datasetText || "暂无"}

项目列表（共${projects.length}个，显示前10个）：
${projectText || "暂无"}

请根据以上信息生成个人简介，要求：
1. 长度控制在 120-200 字；
2. 突出作者的主要研究方向和贡献；
3. 如果提供了数据集，要体现作者在数据资源建设方面的贡献；
4. 语言自然、学术化，使用第三人称，不要使用列表格式；
5. 根据论文标题和数据集名称，总结作者的研究重点和特色。`;

    const messages = [
        { role: "system", content: sanitizeString(systemPrompt) },
        { role: "user", content: sanitizeString(userPrompt) }
    ];

    try {
        if (provider === "Gemini") {
            const apiKey = Zotero.Prefs.get(`${prefsPrefix}.geminiApiKey`) as string;
            const model = Zotero.Prefs.get(`${prefsPrefix}.geminiModel`) as string;
            if (!apiKey) return "";
            const baseUrl = "https://generativelanguage.googleapis.com/v1beta/models";
            const url = `${baseUrl}/${model}:generateContent?key=${apiKey}`;
            const response = await Zotero.HTTP.request("POST", url, {
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{
                        role: "user",
                        parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }]
                    }]
                }),
                responseType: "json",
                timeout: 120000
            });
            const parts = response?.response?.candidates?.[0]?.content?.parts || [];
            const text = parts.map((p: any) => p?.text || "").join("").trim();
            return text;
        }

        if (provider === "Claude") {
            const baseUrl = Zotero.Prefs.get(`${prefsPrefix}.claudeBaseUrl`) as string || "https://api.anthropic.com/v1";
            const apiKey = Zotero.Prefs.get(`${prefsPrefix}.claudeApiKey`) as string;
            const model = Zotero.Prefs.get(`${prefsPrefix}.claudeModel`) as string;
            if (!apiKey) return "";
            const endpoint = `${baseUrl}/messages`.replace(/([^:]\/)\/+/g, "$1");
            const response = await Zotero.HTTP.request("POST", endpoint, {
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": apiKey,
                    "anthropic-version": "2023-06-01"
                },
                body: JSON.stringify({
                    model: model,
                    max_tokens: 512,
                    messages: [{
                        role: "user",
                        content: `${systemPrompt}\n\n${userPrompt}`
                    }]
                }),
                responseType: "json",
                timeout: 120000
            });
            const text = response?.response?.content?.[0]?.text || "";
            return (text || "").trim();
        }

        let baseUrl = Zotero.Prefs.get(`${prefsPrefix}.openaiBaseUrl`) as string;
        let apiKey = Zotero.Prefs.get(`${prefsPrefix}.openaiApiKey`) as string;
        let model = Zotero.Prefs.get(`${prefsPrefix}.openaiModel`) as string;

        if (provider === "DeepSeek") {
            baseUrl = Zotero.Prefs.get(`${prefsPrefix}.deepseekBaseUrl`) as string;
            apiKey = Zotero.Prefs.get(`${prefsPrefix}.deepseekApiKey`) as string;
            model = Zotero.Prefs.get(`${prefsPrefix}.deepseekModel`) as string;
        } else if (provider === "Custom") {
            baseUrl = Zotero.Prefs.get(`${prefsPrefix}.customBaseUrl`) as string;
            apiKey = Zotero.Prefs.get(`${prefsPrefix}.customApiKey`) as string;
            model = Zotero.Prefs.get(`${prefsPrefix}.customModel`) as string;
        }

        if (!apiKey || !baseUrl) return "";
        let endpoint = `${baseUrl}/chat/completions`;
        endpoint = endpoint.replace(/([^:]\/)\/+/g, "$1");

        const response = await Zotero.HTTP.request("POST", endpoint, {
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model,
                messages,
                temperature: 0.4,
                max_tokens: 512
            }),
            responseType: "json",
            timeout: 120000
        });
        const text = response?.response?.choices?.[0]?.message?.content || "";
        return (text || "").trim();
    } catch (e) {
        Zotero.debug(`[AI for Science] Failed to generate biography: ${e}`);
        return "";
    }
}

const BACKTICK = "`";
const SCISCINET_HTML_ONLY_INSTRUCTION =
    "你可以根据需要多次调用工具获取数据；当确认不再需要调用工具时，再生成并只输出一个完整HTML文档（从 <!DOCTYPE html> 开始），不要输出任何解释或非HTML文本。";
const SCISCINET_HTML_PROMPT = [
    "## 系统概述",
    "本系统是一个综合的学术研究轨迹分析平台，通过多维度数据模型，支持对学术论文、作者、机构的深入分析。",
    "连接的数据库是：postgres",
    "数据库下面的对应的模式：SciSciNetV2",
    "模式下面对应的表信息（包含作者文章机构等信息）如下：",
    "表名: 字段名(类型)",
    "sciscinet_affiliations:institution_id(text),affiliation_name(text),h_index(double_precision), productivity(double_precision), avg_c10(double precision), avg_logc10(double precision)",
    "sciscinet_authors: authorid(text), author_name(text), h_index(bigint), productivity(bigint), average_c10(double precision), average_logc10(double precision), inference_sources(bigint), inference_counts(bigint), P(gf)(double precision)",
    "sciscinet_fields: id(text), description(text), display_name(text)",
    "sciscinet_link_clinicaltrials: paperid(text), nct_id(text)",
    "sciscinet_link_newsfeed: paperid(text), newsfeed_id(text)",
    "sciscinet_link_nih: paperid(text), award_id(text)",
    "sciscinet_link_nobellaureates: laureate_id(bigint), paperid(text), type(bigint)",
    "sciscinet_link_nsf: award_id(text), paperid(text)",
    "sciscinet_link_patents: paperid(text), patent(text), uspto(bigint)",
    "sciscinet_link_twitter: paperid(text), tweet_id(bigint)",
    "sciscinet_newsfeed_metadata:paperid(text),doi(text),subj_id(text),newsfeed_id(text),timestamp(text),funderid(text)",
    "sciscinet_nsf_metadata:paperid(text),doi(text),type_crossrref(text),funder_display_name(text),award_id(text)",
    "sciscinet_paper_author_affiliation: paperid(text), authorid(text), institutionid(text), raw_affiliation_string(text)",
    "sciscinet_paperdetails: paperid(text), doi(text), DocType(text), title(text), display_name(text), year(integer), date(text), citation_by_count(integer),",
    "sciscinet_paperfields: paperid(text), fieldid(text), score_openalex(real)",
    "sciscinet_papers: paperid(text), doi(text), doctype(text), year(bigint), date(text),citation_count(bigint), C10(double precision), reference_count(bigint), C5(bigint), team_size(bigint), institution_count(bigint), disruption(bigint), Atyp_10pct_Z(bigint), Atyp_Pairs(bigint), Atyp_Median_Z(bigint), SB_B(bigint), SB_T(bigint), patent_count(bigint), newsfeed_count(bigint), nct_count(bigint), nih_count(bigint), nsf_count(bigint), WSB_mu(bigint), WSB_sigma(bigint), WSB_Cinf(bigint)",
    "sciscinet_twitter_metadata: tweetid(bigint), occurred_time(text)",
    "",
    "注意1：表名可以不加引号，列名必须加双引号;多个表有同名字段，加表别名;",
    "注意2: 所有的数据都是标准英文的，中文匹配不到信息;",
    "注意3: 当用户只给出作者名时，必须同时传入当前PDF标题进行作者解析，仅允许使用 mode='authors_by_name_and_title'，禁止使用 authors_by_name。",
    "## 学术作者主题轨迹分析框架",
    "",
    "以下为面向单一作者（以 [AuthorID] 占位符）设计的模块查询。尽量完整利用以下sql语句查询的结果，调用工具SciScinet论文数据库查询数据，专注于作者的主题轨迹生成。！",
    "注意突出以上数据科技主题轨迹检索，及其预测。",
    "",
    "## 学术作者主题轨迹分析框架",
    "sciscinet工具用来分析当前查询的作者对应的科技主题轨迹（只用把作者发表的最多30篇论文标题和年份获取），获取后，请你用大模型能力分析",
    "",
    "## 系统概述",
    "本系统是一个综合的学术研究轨迹分析平台，通过多维度数据模型，支持对学术论文、作者、机构的深入分析。",
    "",
    "## 学术作者画像与科研贡献分析框架",
    "",
    "### ① 作者基础信息与研究绩效分析",
    `${BACKTICK}${BACKTICK}${BACKTICK}sql`,
    "-- 基础信息查询",
    "-- 基础信息查询（明确列出所有需要的字段）",
    "SELECT a.authorid, a.author_name, a.h_index, a.productivity, a.average_c10, a.average_logc10,",
    "       COUNT(DISTINCT paa.paperid) as total_papers,",
    "       COUNT(DISTINCT aff.institution_id) as total_affiliations",
    "FROM sciscinet_authors a",
    "LEFT JOIN sciscinet_paper_author_affiliation paa ON a.authorid = paa.authorid",
    "LEFT JOIN sciscinet_affiliations aff ON paa.institutionid = aff.institution_id",
    "WHERE a.authorid = [AuthorID] ",
    "GROUP BY a.authorid, a.author_name, a.h_index, a.productivity, a.average_c10, a.average_logc10",
    "LIMIT 1;",
    "",
    "-- 年度研究绩效",
    "WITH aff_papers AS (",
    "  SELECT DISTINCT paperid",
    "  FROM sciscinet_paper_author_affiliation",
    "  WHERE authorid = [AuthorID]",
    ")",
    "SELECT",
    "  COALESCE(pd.year, p.year)::int AS year,",
    "  COALESCE(f.display_name, f.description, pf.fieldid) AS field_name,",
    "  COUNT(DISTINCT ap.paperid) AS number_of_publications,",
    "  SUM(COALESCE(p.citation_count, 0)) AS total_citations,",
    "  AVG(COALESCE(p.citation_count, 0)) AS average_citations_per_paper,",
    "  COUNT(DISTINCT ap.paperid) FILTER (WHERE COALESCE(p.citation_count, 0) >= 50) AS highly_cited_papers",
    "FROM aff_papers ap",
    "JOIN sciscinet_papers p ON p.paperid = ap.paperid",
    "LEFT JOIN sciscinet_paperdetails pd ON pd.paperid = ap.paperid",
    "JOIN sciscinet_paperfields pf ON pf.paperid = ap.paperid",
    "LEFT JOIN sciscinet_fields f",
    "  ON lower(COALESCE(substring(pf.fieldid from '(C[0-9]+)'),",
    "                    regexp_replace(pf.fieldid, '^@?https?://openalex\\.org/', '')))",
    "   = lower(COALESCE(substring(f.id from '(C[0-9]+)'),",
    "                    regexp_replace(f.id, '^@?https?://openalex\\.org/', '')))",
    "GROUP BY COALESCE(pd.year, p.year), COALESCE(f.display_name, f.description, pf.fieldid)",
    "ORDER BY year DESC, total_citations DESC",
    "LIMIT 15;",
    "",
    "作者研究领域与主题演变分析",
    "-- 核心研究领域分析",
    "SELECT",
    "  COALESCE(f.display_name, f.description, pf.fieldid) AS field_name,",
    "  COUNT(DISTINCT paa.paperid) AS paper_count,",
    "  AVG(COALESCE(pd.cited_by_count, p.citation_count, 0)) AS avg_citations,",
    "  SUM(COALESCE(pd.cited_by_count, p.citation_count, 0)) AS total_citations",
    "FROM sciscinet_paper_author_affiliation AS paa",
    "JOIN sciscinet_paperfields AS pf",
    "  ON paa.paperid = pf.paperid",
    "LEFT JOIN sciscinet_fields AS f",
    "  ON lower(COALESCE(substring(pf.fieldid from '(C[0-9]+)'),",
    "                    regexp_replace(pf.fieldid, '^@?https?://openalex\\.org/', '')))",
    "   = lower(COALESCE(substring(f.id from '(C[0-9]+)'),",
    "                    regexp_replace(f.id, '^@?https?://openalex\\.org/', '')))",
    "LEFT JOIN sciscinet_paperdetails AS pd",
    "  ON paa.paperid = pd.paperid",
    "LEFT JOIN sciscinet_papers AS p",
    "  ON paa.paperid = p.paperid",
    "WHERE paa.authorid = [AuthorID]",
    "GROUP BY COALESCE(f.display_name, f.description, pf.fieldid)",
    "ORDER BY paper_count DESC, total_citations DESC",
    "LIMIT 15;",
    "",
    "-- 研究主题时序演变",
    "WITH yearly_fields AS (",
    "  SELECT",
    "    COALESCE(pd.year, p.year)::int AS year,",
    "    COALESCE(f.display_name, f.description, pf.fieldid) AS field_name,",
    "    COUNT(DISTINCT paa.paperid) AS papers_count,",
    "    AVG(COALESCE(pd.cited_by_count, p.citation_count, 0)) AS avg_citations",
    "  FROM sciscinet_paper_author_affiliation AS paa",
    "  JOIN sciscinet_paperfields AS pf",
    "    ON paa.paperid = pf.paperid",
    "  LEFT JOIN sciscinet_fields AS f",
    "    ON lower(COALESCE(substring(pf.fieldid from '(C[0-9]+)'),",
    "                      regexp_replace(pf.fieldid, '^@?https?://openalex\\.org/', '')))",
    "     = lower(COALESCE(substring(f.id from '(C[0-9]+)'),",
    "                      regexp_replace(f.id, '^@?https?://openalex\\.org/', '')))",
    "  LEFT JOIN sciscinet_paperdetails AS pd",
    "    ON paa.paperid = pd.paperid",
    "  LEFT JOIN sciscinet_papers AS p",
    "    ON paa.paperid = p.paperid",
    "  WHERE paa.authorid = [AuthorID]",
    "    AND COALESCE(pd.year, p.year) > 2015",
    "  GROUP BY COALESCE(pd.year, p.year), COALESCE(f.display_name, f.description, pf.fieldid)",
    ")",
    "SELECT *",
    "FROM yearly_fields",
    "ORDER BY year DESC, papers_count DESC",
    "LIMIT 15;",
    `${BACKTICK}${BACKTICK}${BACKTICK}`,
    "",
    "",
    "## 网页生成要求",
    "尽量完整使用以上查询数据生成包含以下信息：",
    "1. 作者基本信息 (必选) - 姓名、ID、H指数等基础指标 - 总发文量与年度分布 2. 研究领域分析 (必选) - 核心研究方向识别 - 研究主题演变图谱 ",
    "",
    "通过这个框架，您将能够生成一份**专业、数据驱动且具有战略洞察力的学术作者主题轨迹分析报告**，特别聚焦于其研究方向、科研影响力、合作网络及创新贡献。只需替换查询中的[AuthorID]，即可适用于任何作者的学术作者主题轨迹分析报告。",
    "",
    "## 生成网页要求",
    "",
    "### 技术规范",
    "",
    "* 使用HTML5、Font Awesome、Tailwind CSS和必要的JavaScript",
    "* Font Awesome: https://lf6-cdn-tos.bytecdntp.com/cdn/expire-100-M/font-awesome/6.0.0/css/all.min.css",
    "* 中文字体: https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;500;600;700&family=Noto+Sans+SC:wght@300;400;500;700&display=swap",
    "",
    "确保代码简洁高效，注重性能和可维护性",
    "使用CSS变量管理颜色和间距，便于风格统一",
    "",
    "### 输出要求",
    "",
    "* 提供一个完整的HTML文件，包含所有学者画像设计风格的卡片",
    "* 代码应当优雅且符合最佳实践，CSS应体现出对细节的极致追求",
    "* 页面宽度根据手机宽度自适应，保证响应式效果",
    "* 注意文字可阅读性，保持背景干净、字体颜色清晰对比",
    "* 保证信息完整性，避免遗漏",
    "* 注意为了减少网页复杂度，尽量不设计点击功能",
    "",
    "### 风格要求",
    "",
    "#### 设计目标",
    "",
    "* **视觉吸引力**：创造一个视觉上令人惊艳的学术画像页面，立即吸引读者注意力，激发阅读兴趣。",
    "* **可读性**：内容布局清晰易读，适合桌面及移动端，提供舒适的浏览体验。",
    "* **信息传达**：以美观高效的方式呈现学术数据，突出研究重点和贡献，引导用户理解研究脉络。",
    "* **情感共鸣**：通过设计唤起与学术主题相关的情绪，例如：严谨、创新、深度。",
    "",
    "#### 设计指导（请灵活运用，而非死板遵循）：",
    "",
    "* **整体风格**：可以采用出版物风格、数据可视化风格，打造如数字杂志般的质感和深度。",
    "* **Hero模块（可选但建议）**：可设置一个引人注目的封面区域，包含作者姓名、简介、研究领域、背景图片等。",
    "* **排版**：",
    "",
    "  * 精心选择中文字体组合（衬线与无衬线），提升阅读体验。",
    "  * 使用不同字号、字重、颜色和样式，构建清晰的视觉层次结构。",
    "  * 可以引入精致排版细节（如首字下沉、悬挂标点）增强质感。",
    "  * 使用Font Awesome图标增添趣味和识别度。",
    "* **配色方案**：",
    "",
    "  * 采用和谐且具有视觉冲击力的配色。",
    "  * 色彩活泼大方但不过于花哨，适合科研主题。",
    "  * 高对比度搭配突出关键信息；可尝试渐变、阴影等提升层次感。",
    "* **布局**：",
    "",
    "  * 基于网格系统布局，逻辑分明、易于导航。",
    "  * 合理留白，避免拥挤感，提供视觉呼吸空间。",
    "  * 使用卡片、分割线、图标等将不同数据模块分隔开。",
    "* **调性**：高端、专业、注重细节，营造深度感与科研严谨氛围。",
    "",
    "### 数据可视化",
    "",
    "* 使用ECharts绘制交互式图表（柱状图、折线图、气泡图、混合图等）展示作者的主题轨迹分析报告等。",
    `* 保持图表比例，添加${BACKTICK}maintainAspectRatio${BACKTICK}选项，设置明确宽高比，防止压缩和重叠。`,
    "* 针对不同数据量级使用对数坐标、独立Y轴等优化。",
    "* 交互效果灵敏，支持鼠标悬停显示详细数据、点击高亮等功能。",
    "* Leaflet.js地图标注合作作者所在地区，支持直接跳转至高德地图。",
    `<link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">`,
    `* <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin=""/>`,
    `* <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>`,
    "",
    "### 其他核心注意事项",
    "",
    "* MCPO查询决定了报告的深度和准确性，需保证SQL查询设计科学、全面。",
    "* 控制文字挤压情况，避免文字重叠或被截断，保证可读性。",
    "* 所有图表需具备宽高比控制、对数比例、Y轴分离、min/max限制、字体和图例优化。",
    "* 响应式设计支持多设备，针对手机端需加媒体查询控制图表尺寸和文字布局。",
    "",
    "",
    "注意关键是按照论文的主题时间详细分析，注意是主题轨迹（检索出来的作者的主题轨迹展示清晰）。",
    "注意突出科技主题轨迹检索，及其预测。sciscinet工具用来分析当前查询的作者对应的科技主题轨迹（只用把作者发表的最多30篇论文标题和年份获取），获取后，请你用大模型能力分析。展示要突出轨迹序列。注意不要搞特别花哨的图，简洁为主，避免渲染出错。",
    "*注意保证网页js和css显示合理无显示问题",
    "",
    "## 强制输出规则",
    "当工具 sql_query 返回数据后：",
    "0) 若用户问的是某篇论文中的作者轨迹，必须先调用工具 sql.query：",
    "   - 若用户给出作者名，使用 {\"title\": \"<当前论文标题>\", \"author_name\": \"<作者名>\", \"mode\": \"authors_by_name_and_title\"}",
    "   - 否则使用 {\"title\": \"<当前论文标题>\", \"mode\": \"authors_by_title_keyword\"}",
    "   然后仅使用该列表中的 authorid 进行后续 sql.query 查询",
    "   如果未解析到 authorid，停止作者/论文级查询并直接在 HTML 中说明无法解析",
    "1) 如果仍需更多数据，继续调用工具（允许多次调用）",
    "2) 禁止查询 information_schema/pg_catalog 或进行表结构探索，除非必须用于解析当前论文作者ID",
    "3) 若上下文中存在 [Resolved Author For This Paper] 或 [Paper author candidates from SciSciNet]，必须只使用其中提供的 authorid，禁止再按 author_name 进行全库搜索",
    "4) 如果未解析出 authorid，则停止作者/论文级查询并直接在 HTML 中说明无法从当前论文解析到该作者",
    "5) 当确认不再需要工具时，只输出一个完整的 HTML 文档（从 <!DOCTYPE html> 开始）",
    "6) 不要输出任务拆解、进度、解释、前后缀说明、或任何非 HTML 文本",
    "7) 不要要求用户补充信息，直接基于已获得的数据生成页面"
].join("\n");
// Conversation data structure
interface Conversation {
    id: string; // Unique conversation ID
    itemID?: number; // Zotero item ID (optional, for single paper conversations)
    groupID?: string; // Paper group ID (optional, for group conversations)
    title: string; // Conversation title (first user message or auto-generated)
    createdAt: number; // Timestamp
    updatedAt: number; // Last update timestamp
    messages: Array<{ sender: string, text: string, type: string }>;
}

// Track chat history for each item (list of conversations)
let chatHistory: { [itemID: number]: Conversation[] } = {};
// Track current conversation ID
let currentConversationID: string | null = null;
// Track current conversation item ID
let currentConversationItemID: number | null = null;

// Paper Group data structure
interface PaperGroup {
    id: string; // Unique group ID
    name: string; // Group name
    itemIDs: number[]; // Array of Zotero item IDs
    createdAt: number; // Timestamp
    updatedAt: number; // Last update timestamp
}

// Track current paper group ID (if a group is selected)
let currentPaperGroupID: string | null = null;

// Helper to get all open PDF readers
async function getAllOpenPDFReaders(): Promise<Array<{ item: Zotero.Item, reader: any, title: string }>> {
    const readers: Array<{ item: Zotero.Item, reader: any, title: string }> = [];
    try {
        const win = Zotero.getMainWindow();
        if (!win || !win.Zotero || !win.Zotero.Reader) return readers;

        // @ts-ignore
        const allReaders = win.Zotero.Reader._readers || [];

        for (const reader of allReaders) {
            try {
                const itemID = reader.itemID;
                if (!itemID) continue;

                const item = Zotero.Items.get(itemID);
                if (!item) continue;

                // Get parent item if this is an attachment
                let displayItem = item;
                if (item.isAttachment()) {
                    const parentID = item.parentItemID;
                    if (parentID) {
                        const parent = Zotero.Items.get(parentID);
                        if (parent) displayItem = parent;
                    }
                }

                const title = displayItem.getField('title') || 'Untitled';
                readers.push({ item: displayItem, reader, title });
            } catch (e) {
                Zotero.debug(`Error getting reader info: ${e}`);
            }
        }
    } catch (e) {
        Zotero.debug(`Error getting all readers: ${e}`);
    }
    return readers;
}

// Helper to generate conversation ID
function generateConversationID(): string {
    return `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Helper to generate paper group ID
function generatePaperGroupID(): string {
    return `group_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Paper Group Management Functions
async function getAllPaperGroups(): Promise<PaperGroup[]> {
    try {
        const groups = await paperGroupStorage.get("all_groups");
        if (groups && Array.isArray(groups)) {
            return groups;
        }
        return [];
    } catch (e) {
        Zotero.log(`[PaperGroups] Error getting groups: ${e}`);
        return [];
    }
}

async function saveAllPaperGroups(groups: PaperGroup[]): Promise<void> {
    try {
        await paperGroupStorage.set("all_groups", groups);
    } catch (e) {
        Zotero.log(`[PaperGroups] Error saving groups: ${e}`);
    }
}

async function createPaperGroup(name: string, itemIDs: number[]): Promise<PaperGroup> {
    const groups = await getAllPaperGroups();
    const newGroup: PaperGroup = {
        id: generatePaperGroupID(),
        name: name,
        itemIDs: itemIDs,
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    groups.push(newGroup);
    await saveAllPaperGroups(groups);
    return newGroup;
}

async function updatePaperGroup(groupID: string, name?: string, itemIDs?: number[]): Promise<boolean> {
    const groups = await getAllPaperGroups();
    const index = groups.findIndex(g => g.id === groupID);
    if (index === -1) return false;

    if (name !== undefined) groups[index].name = name;
    if (itemIDs !== undefined) groups[index].itemIDs = itemIDs;
    groups[index].updatedAt = Date.now();

    await saveAllPaperGroups(groups);
    return true;
}

async function deletePaperGroup(groupID: string): Promise<boolean> {
    const groups = await getAllPaperGroups();
    const filtered = groups.filter(g => g.id !== groupID);
    if (filtered.length === groups.length) return false;

    await saveAllPaperGroups(filtered);
    return true;
}

async function getPaperGroup(groupID: string): Promise<PaperGroup | null> {
    const groups = await getAllPaperGroups();
    return groups.find(g => g.id === groupID) || null;
}

// Helper to get all conversations (from all items)
async function getAllConversations(): Promise<Conversation[]> {
    try {
        // Load all conversations from file storage
        const allConversations = await conversationStorage.get("all_conversations");
        if (allConversations && Array.isArray(allConversations)) {
            return allConversations;
        }

        // Try to migrate from old per-item format
        const { config } = await import("../../package.json");
        const prefsPrefix = config.prefsPrefix;
        const migrated: Conversation[] = [];

        // Try to find all item IDs that have conversations
        // We'll check common item IDs or try to migrate from preferences
        for (let i = 1; i <= 1000; i++) {
            const oldKey = `${prefsPrefix}.conversations.${i}`;
            const oldHistoryStr = Zotero.Prefs.get(oldKey) as string;
            if (oldHistoryStr) {
                try {
                    const oldConversations = JSON.parse(oldHistoryStr);
                    if (Array.isArray(oldConversations) && oldConversations.length > 0) {
                        migrated.push(...oldConversations);
                        Zotero.Prefs.clear(oldKey);
                    }
                } catch (e) {
                    // Ignore
                }
            }

            // Also check very old format
            const veryOldKey = `${prefsPrefix}.chatHistory.${i}`;
            const veryOldHistoryStr = Zotero.Prefs.get(veryOldKey) as string;
            if (veryOldHistoryStr) {
                try {
                    const oldMessages = JSON.parse(veryOldHistoryStr);
                    if (Array.isArray(oldMessages) && oldMessages.length > 0) {
                        const migratedConv: Conversation = {
                            id: generateConversationID(),
                            itemID: i,
                            title: oldMessages.find((m: any) => m.type === "user")?.text.substring(0, 50) || "历史对话",
                            createdAt: Date.now(),
                            updatedAt: Date.now(),
                            messages: oldMessages.filter((m: any) => m.type === "user" || m.type === "ai")
                        };
                        migrated.push(migratedConv);
                        Zotero.Prefs.clear(veryOldKey);
                    }
                } catch (e) {
                    // Ignore
                }
            }
        }

        if (migrated.length > 0) {
            await saveAllConversations(migrated);
            return migrated;
        }
    } catch (e) {
        Zotero.debug(`Error loading all conversations: ${e}`);
    }
    return [];
}

// Helper to get conversations for a specific item or group
async function getConversations(itemID?: number, groupID?: string): Promise<Conversation[]> {
    const allConversations = await getAllConversations();
    if (groupID) {
        return allConversations.filter(c => c.groupID === groupID);
    } else if (itemID) {
        return allConversations.filter(c => c.itemID === itemID);
    }
    return [];
}

// Helper to save all conversations
async function saveAllConversations(conversations: Conversation[]) {
    try {
        // Sort by updatedAt descending (newest first)
        conversations.sort((a, b) => b.updatedAt - a.updatedAt);
        // Save all conversations to file storage
        await conversationStorage.set("all_conversations", conversations);
    } catch (e) {
        Zotero.debug(`Error saving all conversations: ${e}`);
    }
}

// Helper to save conversations for an item (deprecated, use saveAllConversations)
async function saveConversations(itemID: number, conversations: Conversation[]) {
    // Get all conversations, update the ones for this item, then save all
    const allConversations = await getAllConversations();
    // Remove old conversations for this item
    const filtered = allConversations.filter(c => c.itemID !== itemID);
    // Add new conversations
    filtered.push(...conversations);
    await saveAllConversations(filtered);
}

// Helper to save current conversation (only if it has user messages)
async function saveCurrentConversation(itemID: number | undefined, conversationID: string, messages: Array<{ sender: string, text: string, type: string }>, title?: string, groupID?: string) {
    try {
        // Only save if there are user messages (user has actually sent something)
        const hasUserMessages = messages.some(m => m.type === "user");
        if (!hasUserMessages) {
            // Don't save empty conversations
            return;
        }

        const allConversations = await getAllConversations();
        let conversation = allConversations.find(c => c.id === conversationID);

        if (!conversation) {
            // Create new conversation
            const firstUserMessage = messages.find(m => m.type === "user");
            let conversationTitle = title || firstUserMessage?.text.substring(0, 50) || "新对话";

            // For group conversations, try to get group name
            if (groupID) {
                try {
                    const group = await getPaperGroup(groupID);
                    if (group) {
                        conversationTitle = title || `📚 ${group.name}` || conversationTitle;
                    }
                } catch (e) {
                    Zotero.debug(`Error getting group name: ${e}`);
                }
            } else if (itemID) {
                const item = Zotero.Items.get(itemID);
                if (item) {
                    const itemTitle = item.getField('title') || 'Untitled';
                    // Don't override if title is provided
                    if (!title) {
                        conversationTitle = itemTitle;
                    }
                }
            }

            conversation = {
                id: conversationID,
                itemID: itemID,
                groupID: groupID,
                title: conversationTitle,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                messages: []
            };
            allConversations.push(conversation);
        }

        // Update conversation
        conversation.messages = messages;
        conversation.updatedAt = Date.now();
        if (title) {
            conversation.title = title;
        } else if (conversation.title === "新对话" && messages.length > 0) {
            const firstUserMessage = messages.find(m => m.type === "user");
            if (firstUserMessage) {
                conversation.title = firstUserMessage.text.substring(0, 50);
            }
        }

        await saveAllConversations(allConversations);
    } catch (e) {
        Zotero.debug(`Error saving current conversation: ${e}`);
    }
}

// Helper to get a specific conversation
async function getConversation(itemID: number | undefined, conversationID: string, groupID?: string): Promise<Conversation | null> {
    try {
        const allConversations = await getAllConversations();
        return allConversations.find(c => c.id === conversationID) || null;
    } catch (e) {
        Zotero.debug(`Error getting conversation: ${e}`);
    }
    return null;
}

// Helper to delete a conversation
async function deleteConversation(itemID: number | undefined, conversationID: string, groupID?: string) {
    try {
        const allConversations = await getAllConversations();
        const filtered = allConversations.filter(c => c.id !== conversationID);
        await saveAllConversations(filtered);
    } catch (e) {
        Zotero.debug(`Error deleting conversation: ${e}`);
    }
}

// Helper to create a new conversation
function createNewConversation(itemID?: number, title?: string, groupID?: string): Conversation {
    return {
        id: generateConversationID(),
        itemID: itemID,
        groupID: groupID,
        title: title || "新对话",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: []
    };
}

// Helper to get selected text
function getSelectedText(): string {
    try {
        const win = Zotero.getMainWindow();
        if (!win || !win.Zotero_Tabs) return "";

        // Check if we have a valid selection in the active reader
        const reader = win.Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
        if (!reader) return "";

        return ztoolkit.Reader.getSelectedText(reader);
    } catch (e) {
        return "";
    }
}

// Helper to get the top-level parent item ID (recursively get parent until we reach a non-attachment)
function getTopLevelItemID(item: Zotero.Item): number {
    if (item.isAttachment()) {
        const parentID = item.parentItemID;
        if (parentID) {
            const parent = Zotero.Items.get(parentID);
            if (parent) {
                // Recursively get parent until we reach a non-attachment
                return getTopLevelItemID(parent);
            }
        }
    }
    return item.id;
}

// Helper to get the item ID of the currently selected text's PDF
// Returns the top-level parent item ID if the PDF is an attachment, otherwise returns the item ID itself
// This function should return the same normalized ID as normalizeItemID() for consistency
function getSelectedTextItemID(): number | null {
    try {
        const win = Zotero.getMainWindow();
        if (!win || !win.Zotero_Tabs) return null;

        const reader = win.Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
        if (!reader || !reader.itemID) return null;

        const attachment = Zotero.Items.get(reader.itemID);
        if (!attachment) return null;

        // Use recursive function to get top-level parent item
        return getTopLevelItemID(attachment);
    } catch (e) {
        Zotero.debug(`[AI for Science] getSelectedTextItemID error: ${e}`);
        return null;
    }
}

// Helper to normalize item ID - always return the top-level parent item ID if it's an attachment
function normalizeItemID(item: Zotero.Item | null): number | null {
    if (!item) return null;
    return getTopLevelItemID(item);
}

// Helper to clear text selection in PDF reader
function clearPDFSelection(): void {
    try {
        const win = Zotero.getMainWindow();
        if (!win || !win.Zotero_Tabs) return;

        // Get the active reader
        const reader = win.Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
        if (!reader) return;

        // Clear selection in the reader's iframe window
        const iframeWindow = reader._iframeWindow;
        if (iframeWindow && iframeWindow.document) {
            // Method 1: Clear selection using getSelection()
            const selection = iframeWindow.getSelection();
            if (selection && selection.rangeCount > 0) {
                selection.removeAllRanges();
            }

            // Method 2: Also try to clear selection in the document
            if (iframeWindow.document.getSelection) {
                const docSelection = iframeWindow.document.getSelection();
                if (docSelection && docSelection.rangeCount > 0) {
                    docSelection.removeAllRanges();
                }
            }

            // Method 3: Try to click on the document to deselect
            // This simulates a user click which typically clears selection
            try {
                const clickEvent = new iframeWindow.MouseEvent('click', {
                    bubbles: true,
                    cancelable: true,
                    view: iframeWindow,
                    button: 0
                });
                if (iframeWindow.document.body) {
                    iframeWindow.document.body.dispatchEvent(clickEvent);
                }
            } catch (e) {
                // Ignore if MouseEvent creation fails
            }

            // Method 4: Blur any focused element
            if (iframeWindow.document.activeElement) {
                try {
                    (iframeWindow.document.activeElement as HTMLElement).blur();
                } catch (e) {
                    // Ignore blur errors
                }
            }
        }
    } catch (e) {
        Zotero.debug("[AI for Science] Failed to clear PDF selection: " + e);
    }
}

async function getPDFReaderStatus(item: Zotero.Item): Promise<{ isOpen: boolean, hasPDF: boolean }> {
    let hasPDF = false;
    let isOpen = false;

    try {
        const win = Zotero.getMainWindow();
        let attachment: Zotero.Item | null = null;

        if (item.isAttachment()) {
            attachment = item;
        } else {
            // @ts-ignore
            if (item.getBestAttachment) {
                // @ts-ignore
                const res = item.getBestAttachment();
                if (res instanceof Promise) {
                    const val = await res;
                    if (val) attachment = val as Zotero.Item;
                } else {
                    if (res) attachment = res as Zotero.Item;
                }
            }
        }

        if (attachment && attachment.isAttachment()) {
            // Check content type or extension
            // @ts-ignore
            const contentType = attachment.attachmentContentType;
            // @ts-ignore
            const filename = attachment.attachmentFilename;

            if (contentType === 'application/pdf' || (filename && filename.toLowerCase().endsWith('.pdf'))) {
                hasPDF = true;

                // @ts-ignore
                if (win && win.Zotero && win.Zotero.Reader && win.Zotero.Reader.getByItemID) {
                    // @ts-ignore
                    const reader = win.Zotero.Reader.getByItemID(attachment.id);
                    isOpen = !!reader;
                }
            }
        }
    } catch (e) {
        Zotero.debug("Error checking PDF status: " + e);
    }

    return { isOpen, hasPDF };
}

// Helper to check which papers in a group have PDFs not opened
async function getPapersWithoutOpenPDF(group: PaperGroup): Promise<Array<{ itemID: number, title: string }>> {
    const papersWithoutPDF: Array<{ itemID: number, title: string }> = [];

    try {
        const win = Zotero.getMainWindow();
        // @ts-ignore
        const allReaders = win?.Zotero?.Reader?._readers || [];
        const openAttachmentIDs = new Set<number>();

        // Collect all open attachment IDs
        for (const reader of allReaders) {
            if (reader.itemID) {
                openAttachmentIDs.add(reader.itemID);
            }
        }

        for (const itemID of group.itemIDs) {
            try {
                const paperItem = Zotero.Items.get(itemID);
                if (paperItem) {
                    // Get PDF attachment
                    let attachment: Zotero.Item | null = null;
                    // @ts-ignore
                    if (paperItem.getBestAttachment) {
                        // @ts-ignore
                        const res = paperItem.getBestAttachment();
                        if (res instanceof Promise) {
                            const result = await res;
                            attachment = result === false ? null : result;
                        } else {
                            attachment = res === false ? null : (res as Zotero.Item | null);
                        }
                    }

                    // Check if PDF attachment is open
                    const isPDFOpen = attachment && attachment.isAttachment() && openAttachmentIDs.has(attachment.id);

                    if (!isPDFOpen) {
                        const title = paperItem.getField('title') || 'Untitled';
                        papersWithoutPDF.push({ itemID, title });
                    }
                }
            } catch (e) {
                Zotero.debug(`Error checking paper ${itemID}: ${e}`);
            }
        }
    } catch (e) {
        Zotero.debug(`Error checking papers without open PDF: ${e}`);
    }

    return papersWithoutPDF;
}

// Helper to check which papers in a group are not in the single article list (opened PDFs)
async function getPapersNotInSingleArticleList(group: PaperGroup): Promise<Array<{ itemID: number, title: string }>> {
    const papersNotInList: Array<{ itemID: number, title: string }> = [];

    try {
        // Get all open PDF readers (single article list)
        const openReaders = await getAllOpenPDFReaders();
        const openItemIDs = new Set<number>();

        // Collect all item IDs from open PDFs
        for (const readerInfo of openReaders) {
            openItemIDs.add(readerInfo.item.id);
        }

        // Check each paper in the group
        for (const itemID of group.itemIDs) {
            try {
                const paperItem = Zotero.Items.get(itemID);
                if (paperItem) {
                    // Check if this paper is in the single article list (has open PDF)
                    if (!openItemIDs.has(itemID)) {
                        const title = paperItem.getField('title') || 'Untitled';
                        papersNotInList.push({ itemID, title });
                    }
                }
            } catch (e) {
                Zotero.debug(`Error checking paper ${itemID}: ${e}`);
            }
        }
    } catch (e) {
        Zotero.debug(`Error checking papers not in single article list: ${e}`);
    }

    return papersNotInList;
}

// Helper function to show overlay warning dialog for papers not in single article list
function showPapersNotInListWarning(doc: Document, papersNotInList: Array<{ itemID: number, title: string }>): void {
    try {
        // Remove existing overlay if any
        const existingOverlay = doc.getElementById("papers-not-in-list-warning-overlay") as HTMLElement | null;
        if (existingOverlay) {
            existingOverlay.remove();
        }

        // Create overlay
        const overlay = doc.createElement("div");
        overlay.id = "papers-not-in-list-warning-overlay";
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: rgba(0, 0, 0, 0.5);
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
        `;

        // Create dialog container
        const dialog = doc.createElement("div");
        dialog.style.cssText = `
            background: white;
            border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
            width: 500px;
            max-width: 90vw;
            max-height: 80vh;
            display: flex;
            flex-direction: column;
        `;

        // Dialog header
        const header = doc.createElement("div");
        header.style.cssText = `
            padding: 16px 20px;
            border-bottom: 1px solid #eee;
            display: flex;
            justify-content: space-between;
            align-items: center;
        `;
        const title = doc.createElement("h3");
        title.textContent = "⚠️ 提示";
        title.style.cssText = "margin: 0; font-size: 16px; font-weight: 600; color: #ff9800;";
        const closeBtn = doc.createElement("button");
        closeBtn.textContent = "×";
        closeBtn.style.cssText = `
            background: none;
            border: none;
            font-size: 24px;
            cursor: pointer;
            color: #666;
            padding: 0;
            width: 30px;
            height: 30px;
            line-height: 1;
        `;
        closeBtn.onclick = () => overlay.remove();
        closeBtn.onmouseenter = () => {
            closeBtn.style.color = "#333";
        };
        closeBtn.onmouseleave = () => {
            closeBtn.style.color = "#666";
        };
        header.appendChild(title);
        header.appendChild(closeBtn);

        // Dialog content
        const content = doc.createElement("div");
        content.style.cssText = `
            padding: 20px;
            overflow-y: auto;
            max-height: 60vh;
        `;

        const message = doc.createElement("div");
        message.style.cssText = "font-size: 14px; color: #333; line-height: 1.6; margin-bottom: 16px;";
        message.textContent = `以下 ${papersNotInList.length} 篇论文的PDF尚未打开，可能影响分析效果：`;
        content.appendChild(message);

        // Paper list
        const paperList = doc.createElement("div");
        paperList.style.cssText = "margin-bottom: 16px;";
        papersNotInList.forEach((paper, index) => {
            const paperItem = doc.createElement("div");
            paperItem.style.cssText = `
                padding: 8px 12px;
                margin-bottom: 8px;
                background-color: #fff3cd;
                border-left: 3px solid #ffc107;
                border-radius: 4px;
                font-size: 13px;
                color: #856404;
            `;
            paperItem.textContent = `${index + 1}. ${paper.title}`;
            paperList.appendChild(paperItem);
        });
        content.appendChild(paperList);

        // Footer message
        const footer = doc.createElement("div");
        footer.style.cssText = "font-size: 13px; color: #666; font-style: italic;";
        footer.textContent = "建议先打开这些论文的PDF以获得更好的分析效果。";
        content.appendChild(footer);

        dialog.appendChild(header);
        dialog.appendChild(content);
        overlay.appendChild(dialog);

        // Close on overlay click (outside dialog)
        overlay.onclick = (e) => {
            if (e.target === overlay) {
                overlay.remove();
            }
        };

        if (doc.body) {
            doc.body.appendChild(overlay);
        }
    } catch (e) {
        Zotero.debug(`[AI for Science] Error showing papers not in list warning: ${e}`);
    }
}

// Helper function to check if PDF is open and show warning if not
async function checkAndWarnPDFNotOpen(item: Zotero.Item, pdfText: string): Promise<void> {
    // Only check if PDF text is empty or very short (less than 100 characters)
    if (pdfText && pdfText.length >= 100) {
        return; // PDF was successfully read
    }

    try {
        // Handle attachment case - get parent item for title
        let metadataItem = item;
        if (item.isAttachment() && item.parentItem) {
            // @ts-ignore
            metadataItem = item.parentItem;
        }

        const status = await getPDFReaderStatus(item);

        if (status.hasPDF && !status.isOpen) {
            // Get paper title from metadata item
            const title = metadataItem.getField('title') || 'Untitled';

            // Show warning using ProgressWindow
            try {
                const progressWindow = new (Zotero as any).ProgressWindow("PDF未打开");
                progressWindow.changeHeadline("PDF未打开");
                progressWindow.createLine({
                    text: `论文 "${title}" 的PDF未打开，无法读取完整内容。请先打开PDF文件。`,
                    type: "fail",
                    progress: 100
                });
                progressWindow.show();

                // Auto-close after 5 seconds
                setTimeout(() => {
                    try {
                        progressWindow.startCloseTimer(0);
                    } catch (e) {
                        // Ignore close errors
                    }
                }, 5000);
            } catch (e) {
                Zotero.debug(`[AI for Science] Failed to show PDF warning: ${e}`);
                // Fallback: log to console
                Zotero.log(`[AI for Science] 警告: 论文 "${title}" 的PDF未打开，无法读取完整内容。`);
            }
        }
    } catch (e) {
        Zotero.debug(`[AI for Science] Error checking PDF status for warning: ${e}`);
    }
}

// Function to load tools
async function loadMCPTools() {
    // Clear existing
    activeMCPClients.forEach(c => c.close());
    activeMCPClients = [];
    activeMCPTools = [];
    toolToClientMap = {};
    toolNameToOriginalMap = {};
    selectedToolNames.clear();

    const prefsPrefix = addon.data.config.prefsPrefix;
    const provider = Zotero.Prefs.get(`${prefsPrefix}.provider`) as string;
    const mcpEnabledVal = Zotero.Prefs.get(`${prefsPrefix}.mcpEnabled`);
    const mcpEnabled = mcpEnabledVal === undefined || mcpEnabledVal === true || mcpEnabledVal === "true";

    if (!mcpEnabled || provider === "Gemini" || provider === "Claude") return;

    let serversStr = Zotero.Prefs.get(`${prefsPrefix}.mcpServers`) as string;
    let servers: MCPServerConfig[] = [];
    try {
        if (serversStr) {
            servers = JSON.parse(serversStr);
        }
    } catch (e) {
        Zotero.debug(`[AI for Science] Error parsing MCP servers config: ${e}`);
    }

    for (const server of servers) {
        let client: MCPClient | null = null;
        try {
            Zotero.debug(`[AI for Science] Connecting to MCP server: ${server.name} (${server.url})`);
            client = new MCPClient(server.url, server.apiKey);
            await client.connect();

            Zotero.debug(`[AI for Science] Fetching tools from MCP server: ${server.name}`);
            const mcpTools = await client.getTools();

            // Debug: log the actual response structure
            Zotero.debug(`[AI for Science] MCP tools response from ${server.name}: ${JSON.stringify(mcpTools)}`);

            // Handle null or invalid response
            if (mcpTools === null || mcpTools === undefined) {
                Zotero.debug(`[AI for Science] MCP server ${server.name} returned null/undefined tools. This may indicate the server is still initializing. Closing connection.`);
                if (client) {
                    client.close();
                }
                continue; // Skip this server but don't throw error
            }

            const formattedTools = formatMCPTools(mcpTools);

            if (formattedTools.length === 0) {
                Zotero.debug(`[AI for Science] No tools found from MCP server ${server.name}. This may be normal if the server is still initializing or has no tools available.`);
                // Still keep the client connection even if no tools, in case tools become available later
                activeMCPClients.push(client);
            } else {
                Zotero.debug(`[AI for Science] Loaded ${formattedTools.length} tools from MCP server: ${server.name}`);
                // Only add client to active list if we have tools
                activeMCPClients.push(client);

                formattedTools.forEach((tool: any) => {
                    activeMCPTools.push(tool);
                    toolToClientMap[tool.function.name] = client!;
                    toolNameToOriginalMap[tool.function.name] = tool.originalName || tool.function.name;

                    // 👇 新增下面这一行，实现默认全选 👇
                    selectedToolNames.add(tool.function.name);
                });
            }
        } catch (e: any) {
            const errorMsg = e?.message || String(e);
            Zotero.log(`[AI for Science] Failed to connect to MCP server ${server.name}: ${errorMsg}`);
            Zotero.debug(`[AI for Science] MCP server connection error details: ${JSON.stringify(e)}`);
            // Clean up client if connection failed
            if (client) {
                try {
                    client.close();
                } catch (closeError) {
                    // Ignore close errors
                }
            }
        }
    }
}

export class ChatFactory {
    static registerItemPaneSection() {
        Zotero.ItemPaneManager.registerSection({
            paneID: "ai-mcp-chat",
            pluginID: addon.data.config.addonID,
            header: {
                l10nID: getLocaleID("ai-chat-section-header"),
                icon: `chrome://${addon.data.config.addonRef}/content/icons/robot.png`,
            },
            sidenav: {
                l10nID: getLocaleID("ai-chat-section-sidenav"),
                icon: `chrome://${addon.data.config.addonRef}/content/icons/robot.png`,
            },
            onItemChange: ({ item, setEnabled, tabType }) => {
                // Only show the section when in Reader tab (PDF reader is active)
                setEnabled(tabType === "reader");
                return true;
            },
            onRender: ({ body, item }) => {
                // Clear existing content to ensure fresh state for new item
                body.innerHTML = "";

                const doc = body.ownerDocument;
                if (!doc) return;

                // Main container
                const mainContainer = doc.createElement("div");
                mainContainer.style.padding = "10px";
                mainContainer.style.display = "flex";
                mainContainer.style.flexDirection = "column";
                mainContainer.style.gap = "10px";

                // Open AI Chat button
                const chatContainer = doc.createElement("div");
                chatContainer.style.display = "flex";
                chatContainer.style.justifyContent = "center";

                const btn = doc.createElement("button");
                btn.textContent = "Open AI Chat";
                btn.style.padding = "6px 12px";
                btn.style.width = "100%";
                btn.style.cursor = "pointer";

                btn.onclick = () => {
                    ChatFactory.openChatWindow(item);
                };

                chatContainer.appendChild(btn);
                mainContainer.appendChild(chatContainer);

                // Author papers section
                const papersSection = doc.createElement("div");
                papersSection.style.display = "flex";
                papersSection.style.flexDirection = "column";
                papersSection.style.gap = "8px";

                const sectionTitle = doc.createElement("div");
                sectionTitle.textContent = "作者相关论文";
                sectionTitle.style.fontWeight = "bold";
                sectionTitle.style.fontSize = "12px";
                sectionTitle.style.marginBottom = "4px";
                papersSection.appendChild(sectionTitle);

                // Loading indicator
                const loadingDiv = doc.createElement("div");
                loadingDiv.textContent = "正在加载...";
                loadingDiv.style.fontSize = "11px";
                loadingDiv.style.color = "#666";
                loadingDiv.style.display = "none";
                papersSection.appendChild(loadingDiv);

                // Papers container
                const papersContainer = doc.createElement("div");
                papersContainer.style.display = "flex";
                papersContainer.style.flexDirection = "column";
                papersContainer.style.gap = "6px";
                papersContainer.id = "author-papers-container";
                papersSection.appendChild(papersContainer);

                mainContainer.appendChild(papersSection);
                body.appendChild(mainContainer);

                // Load author papers asynchronously - directly search by title
                (async () => {
                    try {
                        loadingDiv.style.display = "block";
                        loadingDiv.textContent = "正在搜索...";
                        papersContainer.innerHTML = "";

                        // Get the actual item (handle attachment case)
                        let actualItem = item;
                        if (!actualItem) {
                            loadingDiv.textContent = "无法获取项目信息";
                            return;
                        }

                        // Get attachment for PDF title extraction
                        let pdfAttachment: Zotero.Item | null = null;
                        if (actualItem.isAttachment && actualItem.isAttachment()) {
                            pdfAttachment = actualItem;
                            // Also get parent for later use
                            const parentID = actualItem.parentItemID;
                            if (parentID) {
                                try {
                                    const parent = Zotero.Items.get(parentID);
                                    if (parent) {
                                        actualItem = parent;
                                    }
                                } catch (e) {
                                    Zotero.debug(`[DBLP] Error getting parent item: ${e}`);
                                }
                            }
                        } else {
                            // @ts-expect-error Zotero types
                            pdfAttachment = await actualItem.getBestAttachment();
                        }

                        // Always get title from PDF - wait a bit for Reader to load
                        loadingDiv.textContent = "正在从PDF获取标题...";
                        await Zotero.Promise.delay(1500); // Wait for Reader to fully load
                        const title = pdfAttachment ? await getPDFTitle(pdfAttachment) : null;

                        if (!title) {
                            loadingDiv.textContent = "无法从PDF获取标题，无法搜索";
                            const errorDiv = doc.createElement("div");
                            errorDiv.textContent = "提示：请确保PDF文件已在Reader中打开并完全加载";
                            errorDiv.style.fontSize = "10px";
                            errorDiv.style.color = "#999";
                            errorDiv.style.marginTop = "4px";
                            papersContainer.appendChild(errorDiv);
                            return;
                        }

                        Zotero.debug(`[DBLP] Searching by title: ${title}`);

                        // Search for paper by title and get authors
                        loadingDiv.textContent = "正在通过标题搜索作者...";
                        const authorsFromDBLP = await searchPaperByTitleAndGetAuthors(title);

                        if (authorsFromDBLP.length === 0) {
                            loadingDiv.textContent = "未在DBLP中找到该论文的作者";
                            return;
                        }

                        Zotero.debug(`[DBLP] Found ${authorsFromDBLP.length} authors: ${authorsFromDBLP.map(a => a.name).join(', ')}`);

                        loadingDiv.textContent = `找到 ${authorsFromDBLP.length} 位作者，正在获取论文...`;

                        // Collect papers grouped by author with deduplication within each author
                        // 使用完全串行处理，避免触发限流和服务不可用
                        const papersByAuthor: Array<{ authorName: string; papers: DBLPPaper[] }> = [];
                        
                        // 串行处理每个作者，请求之间添加延迟
                        for (let i = 0; i < authorsFromDBLP.length; i++) {
                            const authorInfo = authorsFromDBLP[i];
                            try {
                                Zotero.debug(`[DBLP] Getting papers for author: ${authorInfo.name} (PID: ${authorInfo.pid})`);
                                loadingDiv.textContent = `正在获取 ${i + 1}/${authorsFromDBLP.length} 位作者的论文...`;
                                
                                // Get papers by PID
                                const papers = await getPapersByAuthorPID(authorInfo.pid);
                                Zotero.debug(`[DBLP] Got ${papers.length} papers for author ${authorInfo.name}`);

                                // Filter out papers without title
                                const validPapers = papers.filter(paper => paper.title);

                                // Deduplicate papers within this author's list using key or title
                                const seenPapers = new Set<string>();
                                const uniquePapers: DBLPPaper[] = [];

                                for (const paper of validPapers) {
                                    // Use key if available, otherwise use title as unique identifier
                                    const paperId = paper.key || paper.title.toLowerCase().trim();
                                    if (!seenPapers.has(paperId)) {
                                        seenPapers.add(paperId);
                                        uniquePapers.push(paper);
                                    } else {
                                        Zotero.debug(`[DBLP] Skipping duplicate paper for ${authorInfo.name}: ${paper.title}`);
                                    }
                                }

                                Zotero.debug(`[DBLP] After deduplication: ${uniquePapers.length} unique papers for ${authorInfo.name}`);

                                // 即使没有论文，也显示作者（论文列表为空）
                                papersByAuthor.push({
                                    authorName: authorInfo.name,
                                    papers: uniquePapers
                                });
                            } catch (e) {
                                Zotero.debug(`[DBLP] Error loading papers for author ${authorInfo.name}: ${e}`);
                                // 即使获取失败，也显示作者（论文列表为空）
                                papersByAuthor.push({
                                    authorName: authorInfo.name,
                                    papers: []
                                });
                            }
                            
                            // 请求之间添加延迟，避免触发限流（除了最后一个）
                            if (i < authorsFromDBLP.length - 1) {
                                await new Promise(resolve => setTimeout(resolve, 3000)); // 等待3秒
                            }
                        }

                        const totalPapers = papersByAuthor.reduce((sum, author) => sum + author.papers.length, 0);
                        Zotero.debug(`[DBLP] Total papers found: ${totalPapers} from ${papersByAuthor.length} authors`);

                        loadingDiv.style.display = "none";

                        if (papersByAuthor.length === 0) {
                            const noPapersDiv = doc.createElement("div");
                            noPapersDiv.textContent = "未找到相关论文";
                            noPapersDiv.style.fontSize = "11px";
                            noPapersDiv.style.color = "#666";
                            papersContainer.appendChild(noPapersDiv);
                            return;
                        }

                        // Display papers grouped by author
                        for (const { authorName, papers } of papersByAuthor) {
                            // Author header with collapse/expand functionality
                            const authorSection = doc.createElement("div");
                            authorSection.style.marginTop = "12px";
                            authorSection.style.marginBottom = "8px";

                            const authorHeader = doc.createElement("div");
                            authorHeader.style.padding = "8px";
                            authorHeader.style.backgroundColor = "#e3f2fd";
                            authorHeader.style.borderRadius = "4px";
                            authorHeader.style.cursor = "pointer";
                            authorHeader.style.userSelect = "none";
                            authorHeader.style.display = "flex";
                            authorHeader.style.justifyContent = "space-between";
                            authorHeader.style.alignItems = "center";

                            const authorInfoDiv = doc.createElement("div");
                            authorInfoDiv.style.display = "flex";
                            authorInfoDiv.style.flexDirection = "column";

                            const authorNameDiv = doc.createElement("div");
                            authorNameDiv.textContent = authorName;
                            authorNameDiv.style.fontWeight = "bold";
                            authorNameDiv.style.fontSize = "13px";
                            authorNameDiv.style.color = "#1976d2";
                            authorInfoDiv.appendChild(authorNameDiv);

                            const paperCountDiv = doc.createElement("div");
                            paperCountDiv.textContent = `${papers.length} 篇论文`;
                            paperCountDiv.style.fontSize = "10px";
                            paperCountDiv.style.color = "#666";
                            paperCountDiv.style.marginTop = "2px";
                            authorInfoDiv.appendChild(paperCountDiv);

                            const collapseIcon = doc.createElement("span");
                            collapseIcon.textContent = "▼";
                            collapseIcon.style.fontSize = "10px";
                            collapseIcon.style.color = "#666";
                            collapseIcon.style.marginLeft = "4px";

                            const resumeBtn = doc.createElement("button");
                            resumeBtn.textContent = "生成简历";
                            resumeBtn.style.padding = "2px 6px";
                            resumeBtn.style.fontSize = "10px";
                            resumeBtn.style.border = "1px solid #bcd0f7";
                            resumeBtn.style.background = "#ffffff";
                            resumeBtn.style.color = "#1e5bb8";
                            resumeBtn.style.borderRadius = "4px";
                            resumeBtn.style.cursor = "pointer";
                            resumeBtn.style.whiteSpace = "nowrap";
                            resumeBtn.title = "生成该作者简历并在浏览器中打开";
                            resumeBtn.addEventListener("click", async (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                const resumeAuthor: ResumeAuthor = { name: authorName };
                                const resumePublications: ResumePublication[] = papers.map((paper) => {
                                    const doi = normalizeDoi(paper.doi);
                                    const url = paper.ee || paper.url || (doi ? `https://doi.org/${doi}` : "");
                                    return {
                                        title: paper.title || "无标题",
                                        year: paper.year || "",
                                        venue: paper.venue || "",
                                        doi: doi || "",
                                        url,
                                    };
                                });
                                const originalText = resumeBtn.textContent || "生成简历";
                                resumeBtn.textContent = "生成中...";
                                resumeBtn.disabled = true;
                                try {
                                    const paperTitles = resumePublications
                                        .map((p) => p.title)
                                        .filter((t) => t);
                                    const authorPid = authorsFromDBLP.find(a => a.name === authorName)?.pid;
                                    if (authorPid) {
                                        const orcid = await getAuthorOrcidByPid(authorPid);
                                        if (orcid) {
                                            resumeAuthor.orcid = orcid;
                                        }
                                    }
                                    const { datasets } = await fetchAuthorDatasetsAndProjects(
                                        authorName,
                                        resumePublications,
                                        resumeAuthor.orcid
                                    );
                                    
                                    // 使用配置的 AI 模型生成个人简介
                                    try {
                                        resumeBtn.textContent = "生成简介中...";
                                        const biography = await generateAuthorBiography(
                                            resumeAuthor,
                                            resumePublications,
                                            datasets,
                                            []
                                        );
                                        if (biography) {
                                            resumeAuthor.biography = biography;
                                            Zotero.debug(`[AI for Science] Generated biography for ${authorName}`);
                                        }
                                    } catch (bioErr) {
                                        Zotero.debug(`[AI for Science] Failed to generate biography: ${bioErr}`);
                                        // 即使生成简介失败，也继续生成简历
                                    }
                                    
                                    exportAuthorResumePdfInBrowser(
                                        resumeAuthor,
                                        resumePublications,
                                        datasets,
                                        []
                                    );
                                } catch (err) {
                                    Zotero.debug(`[AI for Science] Failed to generate resume: ${err}`);
                                    exportAuthorResumePdfInBrowser(
                                        resumeAuthor,
                                        resumePublications,
                                        [],
                                        []
                                    );
                                } finally {
                                    resumeBtn.textContent = originalText;
                                    resumeBtn.disabled = false;
                                }
                            });

                            const rightActions = doc.createElement("div");
                            rightActions.style.display = "flex";
                            rightActions.style.alignItems = "center";
                            rightActions.style.gap = "6px";

                            rightActions.appendChild(resumeBtn);
                            rightActions.appendChild(collapseIcon);

                            authorHeader.appendChild(authorInfoDiv);
                            authorHeader.appendChild(rightActions);

                            // Papers container (collapsible) - default collapsed
                            const papersListContainer = doc.createElement("div");
                            papersListContainer.style.display = "none";
                            papersListContainer.style.marginTop = "6px";

                            // Set initial icon for collapsed state
                            collapseIcon.textContent = "▶";

                            // Add "Import All" button at the top of papers list
                            const importAllBtn = doc.createElement("button");
                            importAllBtn.textContent = `一键导入该作者全部论文 (${papers.length}篇)`;
                            importAllBtn.style.padding = "6px 12px";
                            importAllBtn.style.width = "100%";
                            importAllBtn.style.cursor = "pointer";
                            importAllBtn.style.marginBottom = "8px";
                            importAllBtn.style.fontWeight = "bold";
                            importAllBtn.style.backgroundColor = "#f0f0f0";
                            importAllBtn.style.border = "1px solid #ccc";
                            importAllBtn.style.borderRadius = "4px";

                            let isImportingAll = false;
                            importAllBtn.onclick = async () => {
                                if (isImportingAll) return;

                                isImportingAll = true;
                                importAllBtn.textContent = "正在导入";
                                importAllBtn.disabled = true;

                                try {
                                    const result = await importPapersToCollection(papers, authorName);

                                    if (result.success > 0) {
                                        // 有新增的论文导入
                                        importAllBtn.textContent = `已导入 ${result.success} 篇论文到分类"${authorName}"`;
                                        new ztoolkit.ProgressWindow("批量导入完成")
                                            .createLine({
                                                text: `成功导入 ${result.success} 篇论文到分类"${authorName}"`,
                                                type: "success"
                                            })
                                            .show();
                                    } else if (result.failed === 0) {
                                        // 全部跳过（已存在），显示已导入
                                        importAllBtn.textContent = `已导入到分类"${authorName}"`;
                                        new ztoolkit.ProgressWindow("批量导入完成")
                                            .createLine({
                                                text: `所有论文已存在于分类"${authorName}"中`,
                                                type: "success"
                                            })
                                            .show();
                                    } else {
                                        // 有失败的导入
                                        importAllBtn.textContent = "导入失败";
                                        new ztoolkit.ProgressWindow("批量导入失败")
                                            .createLine({
                                                text: `导入失败，请查看控制台日志`,
                                                type: "fail"
                                            })
                                            .show();
                                    }
                                } catch (e) {
                                    Zotero.debug(`[DBLP] Error importing all papers: ${e}`);
                                    importAllBtn.textContent = "导入失败";
                                    new ztoolkit.ProgressWindow("批量导入失败")
                                        .createLine({
                                            text: `导入失败: ${e}`,
                                            type: "fail"
                                        })
                                        .show();
                                } finally {
                                    isImportingAll = false;
                                    importAllBtn.disabled = false;
                                }
                            };

                            papersListContainer.appendChild(importAllBtn);

                            // Toggle collapse/expand
                            let isExpanded = false;
                            authorHeader.onclick = () => {
                                isExpanded = !isExpanded;
                                if (isExpanded) {
                                    papersListContainer.style.display = "block";
                                    collapseIcon.textContent = "▼";
                                } else {
                                    papersListContainer.style.display = "none";
                                    collapseIcon.textContent = "▶";
                                }
                            };

                            authorSection.appendChild(authorHeader);
                            authorSection.appendChild(papersListContainer);
                            papersContainer.appendChild(authorSection);

                            // Display all papers for this author (no limit)
                            for (const paper of papers) {
                                const paperDiv = doc.createElement("div");
                                paperDiv.style.display = "flex";
                                paperDiv.style.flexDirection = "column";
                                paperDiv.style.padding = "6px";
                                paperDiv.style.border = "1px solid #ddd";
                                paperDiv.style.borderRadius = "4px";
                                paperDiv.style.backgroundColor = "#f9f9f9";
                                paperDiv.style.fontSize = "11px";
                                paperDiv.style.marginBottom = "6px";

                                // Title
                                const titleDiv = doc.createElement("div");
                                titleDiv.textContent = paper.title || "无标题";
                                titleDiv.style.fontWeight = "bold";
                                titleDiv.style.marginBottom = "2px";
                                titleDiv.style.wordBreak = "break-word";
                                paperDiv.appendChild(titleDiv);

                                // Authors and year
                                const metaDiv = doc.createElement("div");
                                metaDiv.style.color = "#666";
                                metaDiv.style.fontSize = "10px";
                                if (paper.authors && paper.authors.length > 0) {
                                    // 显示所有作者，不再限制为3个
                                    metaDiv.textContent = paper.authors.join(", ");
                                }
                                if (paper.year) {
                                    if (metaDiv.textContent) {
                                        metaDiv.textContent += ` (${paper.year})`;
                                    } else {
                                        metaDiv.textContent = paper.year;
                                    }
                                }
                                if (metaDiv.textContent) {
                                    paperDiv.appendChild(metaDiv);
                                }

                                // Venue
                                if (paper.venue) {
                                    const venueDiv = doc.createElement("div");
                                    venueDiv.textContent = paper.venue;
                                    venueDiv.style.color = "#666";
                                    venueDiv.style.fontSize = "10px";
                                    venueDiv.style.fontStyle = "italic";
                                    paperDiv.appendChild(venueDiv);
                                }

                                // Import button - use same style as "Open AI Chat" button
                                const importBtn = doc.createElement("button");
                                importBtn.textContent = "导入到我的文库";
                                importBtn.style.padding = "6px 12px";
                                importBtn.style.width = "100%";
                                importBtn.style.cursor = "pointer";
                                importBtn.style.marginTop = "4px";

                                let isImporting = false;
                                importBtn.onclick = async () => {
                                    if (isImporting) return;

                                    isImporting = true;
                                    importBtn.textContent = "导入中...";
                                    importBtn.disabled = true;

                                    try {
                                        const importedItem = await importPaperToZotero(paper);
                                        if (importedItem) {
                                            importBtn.textContent = "已导入";
                                            // Show notification
                                            new ztoolkit.ProgressWindow("导入成功")
                                                .createLine({ text: `已导入: ${paper.title}`, type: "success" })
                                                .show();
                                        } else {
                                            importBtn.textContent = "导入失败";
                                        }
                                    } catch (e) {
                                        Zotero.debug(`[DBLP] Error importing paper: ${e}`);
                                        importBtn.textContent = "导入失败";
                                    } finally {
                                        isImporting = false;
                                    }
                                };

                                paperDiv.appendChild(importBtn);
                                papersListContainer.appendChild(paperDiv);
                            }
                        }

                    } catch (e) {
                        Zotero.debug(`[DBLP] Error loading author papers: ${e}`);
                        loadingDiv.textContent = "加载失败，请稍后重试";
                        loadingDiv.style.color = "#dc3545";
                    }
                })();
            },
        });
    }

    static registerToolbarButton(win: Window) {
        const doc = win.document;
        if (doc.getElementById("ai-mcp-toolbar-button")) return;

        const toolbar = doc.getElementById("zotero-toolbar");
        if (!toolbar) {
            ztoolkit.log("Toolbar not found");
            return;
        }

        const button = doc.createElementNS("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul", "toolbarbutton");
        button.id = "ai-mcp-toolbar-button";
        button.setAttribute("label", "AI Chat");
        button.setAttribute("tooltiptext", "Open AI Chat Window");
        button.setAttribute("image", `chrome://${addon.data.config.addonRef}/content/icons/robot.png`);
        button.className = "toolbarbutton-1 chromeclass-toolbar-additional";

        button.addEventListener("click", () => {
            // @ts-expect-error Zotero types
            const zp = Zotero.getActiveZoteroPane ? Zotero.getActiveZoteroPane() : ZoteroPane;
            if (!zp) return;
            const items = zp.getSelectedItems();
            const item = items.length > 0 ? items[0] : null;
            this.openChatWindow(item);
        });

        toolbar.appendChild(button);
    }

    static async registerReaderToolbarButton(reader: _ZoteroTypes.ReaderInstance) {
        if (!reader) return;

        // Wait for reader to be fully ready
        await Zotero.Promise.delay(1000);

        const doc = reader._iframeWindow?.document;
        if (!doc) {
            Zotero.log("AI Chat: Reader document not found.");
            return;
        }

        // 1. Add to Top Toolbar (Left side usually has space)
        const topToolbarId = "ai-mcp-top-toolbar-button";
        if (!doc.getElementById(topToolbarId)) {
            const topToolbar = doc.getElementById("toolbarViewerLeft") || doc.getElementById("toolbarViewer");
            if (topToolbar) {
                const btn = doc.createElement("button");
                btn.id = topToolbarId;
                btn.className = "toolbarButton";
                btn.title = "AI Chat";
                btn.style.backgroundImage = `url(chrome://${addon.data.config.addonRef}/content/icons/robot.png)`;
                btn.style.backgroundRepeat = "no-repeat";
                btn.style.backgroundPosition = "center";
                btn.style.backgroundSize = "20px";
                btn.style.width = "24px";
                btn.style.height = "24px";
                btn.style.minWidth = "24px";
                btn.style.border = "none";
                btn.style.backgroundColor = "transparent";
                btn.style.cursor = "pointer";
                btn.style.marginLeft = "8px"; // Spacing

                btn.onclick = () => {
                    // @ts-ignore
                    const item = Zotero.Items.get(reader.itemID);
                    if (item) this.openChatWindow(item);
                };

                topToolbar.appendChild(btn);
                Zotero.log("AI Chat: Added to Top Toolbar");
            }
        }

        // 2. Add to Right Toolbar (if exists) or Floating Bottom-Right
        const rightToolbarId = "ai-mcp-right-toolbar-button";
        if (!doc.getElementById(rightToolbarId)) {
            // Try to find the vertical toolbar on the right
            const rightToolbar = doc.getElementById("toolbarViewerRight");

            const btn = doc.createElement("button");
            btn.id = rightToolbarId;
            btn.className = "toolbarButton"; // Try to inherit Zotero styles
            btn.title = "AI Chat (Side)";
            btn.style.backgroundImage = `url(chrome://${addon.data.config.addonRef}/content/icons/robot.png)`;
            btn.style.backgroundRepeat = "no-repeat";
            btn.style.backgroundPosition = "center";
            btn.style.backgroundSize = "20px";
            btn.style.width = "30px";
            btn.style.height = "30px";
            btn.style.border = "none";
            btn.style.backgroundColor = "rgba(255,255,255,0.8)"; // Semi-transparent white background
            btn.style.borderRadius = "4px";
            btn.style.cursor = "pointer";
            btn.style.zIndex = "10000"; // Ensure visibility

            btn.onclick = () => {
                // @ts-ignore
                const item = Zotero.Items.get(reader.itemID);
                if (item) this.openChatWindow(item);
            };

            if (rightToolbar) {
                // Add to the end of right toolbar
                btn.style.marginTop = "10px"; // Spacing
                btn.style.backgroundColor = "transparent"; // Reset if in toolbar
                rightToolbar.appendChild(btn);
                Zotero.log("AI Chat: Added to Right Toolbar");
            } else {
                // Fallback: Floating Bottom-Right
                btn.style.position = "absolute";
                btn.style.bottom = "100px"; // Adjust to not overlap with zoom controls
                btn.style.right = "20px";
                btn.style.borderRadius = "50%";
                btn.style.width = "40px";
                btn.style.height = "40px";
                btn.style.boxShadow = "0 2px 5px rgba(0,0,0,0.3)";
                btn.style.backgroundColor = "white";

                if (doc.body) {
                    doc.body.appendChild(btn);
                    Zotero.log("AI Chat: Added Floating Button (Right)");
                }
            }
        }
    }

    // Register a listener for the annotation popup (context menu on highlight/selection)
    static registerAnnotationPopup() {
        // In Zotero 7, the PDF reader uses PDF.js and its own overlay for annotations.
        // We can hook into the 'reader' events or try to inject into the popup.
        // The popup ID is usually '#annotation-popup-container' or similar in the reader's iframe.

        // @ts-ignore
        Zotero.Reader.registerEventListener("render", (event) => {
            const reader = event.reader;
            // Wait for DOM
            setTimeout(() => {
                const doc = reader._iframeWindow?.document;
                if (!doc) return;

                // Helper to inject button into a container
                const injectButton = (container: HTMLElement) => {
                    if (container.querySelector(".ai-mcp-annotation-btn")) return;

                    const btn = doc.createElement("button");
                    btn.className = "ai-mcp-annotation-btn";
                    btn.title = "Ask AI about this";
                    // Style to match Zotero popup buttons
                    btn.style.width = "28px";
                    btn.style.height = "28px";
                    btn.style.border = "none";
                    btn.style.background = "transparent";
                    btn.style.cursor = "pointer";
                    btn.style.backgroundImage = `url(chrome://${addon.data.config.addonRef}/content/icons/robot.png)`;
                    btn.style.backgroundSize = "20px";
                    btn.style.backgroundRepeat = "no-repeat";
                    btn.style.backgroundPosition = "center";
                    btn.style.display = "inline-block";
                    btn.style.verticalAlign = "middle";
                    btn.style.opacity = "0.8";

                    btn.onmouseenter = () => btn.style.opacity = "1";
                    btn.onmouseleave = () => btn.style.opacity = "0.8";

                    btn.onmousedown = (e) => {
                        e.stopPropagation(); // Prevent closing popup immediately
                    };

                    btn.onclick = async (e) => {
                        e.stopPropagation();
                        // Get selected text or annotation text
                        let text = "";

                        // Try to get current selection
                        // @ts-ignore
                        text = ztoolkit.Reader.getSelectedText(reader);

                        if (text) {
                            const itemID = reader.itemID;
                            // @ts-ignore
                            const item = Zotero.Items.get(itemID);
                            // Open Chat Window
                            const win = Zotero.getMainWindow();
                            const chatWin = win.openDialog(
                                `chrome://${addon.data.config.addonRef}/content/chat.xhtml`,
                                "ai-mcp-chat-window",
                                "chrome,centerscreen,resizable=yes,width=500,height=600"
                            );
                            if (chatWin) {
                                chatWin.addEventListener("load", () => {
                                    // We need to pass the text to the window.
                                    // Wait for init
                                    setTimeout(() => {
                                        const input = chatWin.document.getElementById("chat-input") as HTMLTextAreaElement;
                                        if (input) {
                                            input.value = `Context: "${text}"\n\nQuestion: `;
                                            input.focus();
                                        }
                                        ChatFactory.initChatWindow(chatWin, item);
                                    }, 100);
                                }, { once: true });
                            }
                        }
                    };

                    // Zotero 7 popups usually have a color palette or tools container
                    // We append to the main container
                    container.appendChild(btn);
                };

                // Monitor for popup appearance
                const observer = new MutationObserver((mutations) => {
                    mutations.forEach((mutation) => {
                        if (mutation.type === "childList") {
                            // Broader selectors for Zotero 7 popup
                            // .editor-toolbar, .popup-toolbar, .annotation-popup
                            const popups = doc.querySelectorAll("div[class*='popup'], div[class*='toolbar'], #annotation-popup-container");
                            popups.forEach((popup: Element) => {
                                const el = popup as HTMLElement;
                                // Check if it's likely the annotation popup
                                if (el.offsetParent !== null && (el.className.includes("popup") || el.id.includes("popup"))) {
                                    injectButton(el);
                                }
                            });
                        }
                    });
                });

                if (doc.body) {
                    observer.observe(doc.body, { childList: true, subtree: true });
                }
            }, 1000); // Wait for initial render
        });
    }

    // ChatFactory.registerRightClickMenu() removed as requested

    static isChatWindowOpen(): boolean {
        if (activeChatWindow) {
            try {
                // @ts-ignore
                return !activeChatWindow.closed && activeChatWindow.document;
            } catch (e) {
                return false;
            }
        }
        return false;
    }

    static switchToItem(item: Zotero.Item | null) {
        if (!item) return;
        if (activeChatWindow) {
            try {
                // @ts-ignore
                if (!activeChatWindow.closed && activeChatWindow.document) {
                    // Save current window position before switching
                    const currentX = activeChatWindow.screenX;
                    const currentY = activeChatWindow.screenY;
                    const currentWidth = activeChatWindow.outerWidth;
                    const currentHeight = activeChatWindow.outerHeight;

                    // Store position restore function
                    const restorePosition = () => {
                        try {
                            activeChatWindow!.moveTo(currentX, currentY);
                            activeChatWindow!.resizeTo(currentWidth, currentHeight);
                        } catch (e) {
                            // Ignore if moveTo/resizeTo fails
                        }
                    };

                    // Switch to the item - try to load latest conversation first, create new if none exists
                    // Use setTimeout to ensure the window is ready
                    setTimeout(async () => {
                        await this.initChatWindow(activeChatWindow!, item, true, false, true); // shouldCreateNewConversation = false, preservePosition = true
                        // Note: Warning message will be automatically shown/hidden by checkSelection polling

                        // Restore position immediately and multiple times to ensure it sticks
                        restorePosition();
                        setTimeout(restorePosition, 50);
                        setTimeout(restorePosition, 200);
                        setTimeout(restorePosition, 500);
                    }, 50);
                }
            } catch (e) {
                Zotero.debug(`Error switching chat window to item: ${e}`);
            }
        }
    }

    static openChatWindow(item: Zotero.Item | null, alwaysRaised: boolean = true) {
        const win = Zotero.getMainWindow();

        // Check if chat window already exists and is open
        if (activeChatWindow) {
            try {
                // Check if window is still open (not closed)
                // @ts-ignore
                if (!activeChatWindow.closed && activeChatWindow.document) {
                    // Window exists and is open
                    const SNAP_THRESHOLD = 10;

                    // Check if window is docked at top (screenY is near 0 or negative)
                    if (activeChatWindow.screenY <= SNAP_THRESHOLD) {
                        // Window is docked at top, expand it
                        // @ts-ignore
                        if (typeof activeChatWindow.expandChatWindow === "function") {
                            // @ts-ignore
                            activeChatWindow.expandChatWindow();
                        } else {
                            // Fallback: manually expand by moving window to visible position
                            activeChatWindow.moveTo(activeChatWindow.screenX, 0);
                            activeChatWindow.focus();
                        }

                        // Update item if different - always create new conversation when switching
                        if (item) {
                            // @ts-ignore
                            if (activeChatWindow.currentItemID !== item.id) {
                                // Save current window position before switching
                                const currentX = activeChatWindow.screenX;
                                const currentY = activeChatWindow.screenY;
                                const currentWidth = activeChatWindow.outerWidth;
                                const currentHeight = activeChatWindow.outerHeight;

                                // Store position restore function
                                const restorePosition = () => {
                                    try {
                                        activeChatWindow!.moveTo(currentX, currentY);
                                        activeChatWindow!.resizeTo(currentWidth, currentHeight);
                                    } catch (e) {
                                        // Ignore if moveTo/resizeTo fails
                                    }
                                };

                                // Re-initialize with new item and create new conversation
                                setTimeout(async () => {
                                    await this.initChatWindow(activeChatWindow!, item, alwaysRaised, true, true); // preservePosition = true
                                    // Note: Warning message will be automatically shown/hidden by checkSelection polling

                                    // Restore position immediately and multiple times to ensure it sticks
                                    restorePosition();
                                    setTimeout(restorePosition, 50);
                                    setTimeout(restorePosition, 200);
                                    setTimeout(restorePosition, 500);
                                }, 50);
                            }
                        }

                        return;
                    } else {
                        // Window exists but not docked, just focus it
                        activeChatWindow.focus();

                        // Update item if different - always create new conversation when switching
                        if (item) {
                            // @ts-ignore
                            if (activeChatWindow.currentItemID !== item.id) {
                                // Save current window position before switching
                                const currentX = activeChatWindow.screenX;
                                const currentY = activeChatWindow.screenY;
                                const currentWidth = activeChatWindow.outerWidth;
                                const currentHeight = activeChatWindow.outerHeight;

                                // Store position restore function
                                const restorePosition = () => {
                                    try {
                                        activeChatWindow!.moveTo(currentX, currentY);
                                        activeChatWindow!.resizeTo(currentWidth, currentHeight);
                                    } catch (e) {
                                        // Ignore if moveTo/resizeTo fails
                                    }
                                };

                                // Re-initialize with new item and create new conversation
                                setTimeout(async () => {
                                    await this.initChatWindow(activeChatWindow!, item, alwaysRaised, true, true); // preservePosition = true
                                    // Note: Warning message will be automatically shown/hidden by checkSelection polling

                                    // Restore position immediately and multiple times to ensure it sticks
                                    restorePosition();
                                    setTimeout(restorePosition, 50);
                                    setTimeout(restorePosition, 200);
                                    setTimeout(restorePosition, 500);
                                }, 50);
                            }
                        }

                        return;
                    }
                } else {
                    // Window was closed, clear reference
                    activeChatWindow = null;
                }
            } catch (e) {
                // Window might be invalid, clear reference
                Zotero.debug("[AI for Science] Error checking existing window: " + e);
                activeChatWindow = null;
            }
        }

        // Create new window (only for new windows, not when switching)
        // If window already exists, we don't create a new one
        const windowFeatures = alwaysRaised
            ? "chrome,centerscreen,resizable=yes,width=400,height=800,alwaysRaised=yes"
            : "chrome,centerscreen,resizable=yes,width=400,height=800";

        const chatWin = win.openDialog(
            `chrome://${addon.data.config.addonRef}/content/chat.xhtml`,
            "ai-mcp-chat-window",
            windowFeatures
        );

        if (chatWin) {
            // Store reference to the window
            activeChatWindow = chatWin;

            // Wait for load event
            chatWin.addEventListener("load", () => {
                this.initChatWindow(chatWin, item, alwaysRaised);
            }, { once: true });

            // Clear reference when window is closed
            chatWin.addEventListener("unload", () => {
                if (activeChatWindow === chatWin) {
                    activeChatWindow = null;
                }
            }, { once: true });
        }
    }

    static async initChatWindow(win: Window, item: Zotero.Item | null, initialPinned: boolean = true, shouldCreateNewConversation: boolean = false, preservePosition: boolean = false) {
        // Store reference to this window
        activeChatWindow = win;

        // Normalize item - recursively get top-level parent if it's an attachment
        let normalizedItem = item;
        if (item) {
            const topLevelID = getTopLevelItemID(item);
            if (topLevelID !== item.id) {
                const topLevelItem = Zotero.Items.get(topLevelID);
                if (topLevelItem) {
                    normalizedItem = topLevelItem;
                }
            }
        }

        // Default to single-item mode when an item is provided.
        // This prevents residual group state from previous chats showing in the selector.
        if (normalizedItem) {
            currentPaperGroupID = null;
        }

        // Store current item ID on window for tracking (use normalized item)
        // @ts-ignore
        win.currentItemID = normalizedItem ? normalizedItem.id : null;

        // Clear any existing checkSelection interval before creating a new one
        // @ts-ignore
        if (win.checkSelectionIntervalId) {
            // @ts-ignore
            win.clearInterval(win.checkSelectionIntervalId);
            // @ts-ignore
            win.checkSelectionIntervalId = null;
        }

        // Store flag to preserve window position
        // @ts-ignore
        win.preservePosition = preservePosition;

        // Clear reference when window is closed
        win.addEventListener("unload", () => {
            if (activeChatWindow === win) {
                activeChatWindow = null;
            }
        }, { once: true });

        const doc = win.document;
        // Get elements. In sidebar iframe, they might not be loaded yet if we don't wait for DOMContentLoaded, 
        // but initChatWindow is called on iframe.onload, so it should be fine.
        const sendBtn = doc.getElementById("send-btn") as HTMLButtonElement | null;
        const input = doc.getElementById("chat-input") as HTMLTextAreaElement | null;
        const messagesArea = doc.getElementById("messages") as HTMLElement | null;

        if (!messagesArea || !sendBtn || !input) {
            Zotero.log("AI Chat: UI elements not found in chat window.");
            return;
        }

        // Clear messages area when switching items or creating new conversation
        if (shouldCreateNewConversation) {
            // Remove all warning messages before clearing
            const allWarnings = messagesArea.querySelectorAll("#selection-warning-message");
            allWarnings.forEach((warning: Element) => warning.remove());
            messagesArea.innerHTML = "";
        }

        // Fix: Ensure button type is 'button' to prevent form submission behavior
        sendBtn.type = "button";

        // Use normalized item for all operations
        if (!normalizedItem || (!normalizedItem.isRegularItem() && !normalizedItem.isAttachment())) {
            addMessage(messagesArea, "System", "No valid paper selected. Please select a paper or PDF attachment in Zotero first.", "error");
            input.disabled = true;
            sendBtn.disabled = true;
            return;
        }

        // Update item reference to use normalized item
        item = normalizedItem;

        // Initialize article selector, history, and new chat buttons
        // Remove existing article selector if it exists (to prevent duplicates on re-init)
        const existingArticleSelector = doc.getElementById("article-selector-custom");
        if (existingArticleSelector) {
            existingArticleSelector.remove();
        }
        const existingArticleSelect = doc.getElementById("article-selector");
        if (existingArticleSelect) {
            existingArticleSelect.remove();
        }

        const historyBtn = doc.getElementById("history-btn") as HTMLButtonElement | null;
        const newChatBtn = doc.getElementById("new-chat-btn") as HTMLButtonElement | null;

        // Update current conversation item ID (item is already normalized)
        currentConversationItemID = item.id;

        // Initialize conversation - try to load latest conversation for this item first, create new if none exists
        if (shouldCreateNewConversation) {
            // Create new conversation when explicitly requested
            const newConv = createNewConversation(item.id);
            currentConversationID = newConv.id;
        } else {
            // Try to load the latest conversation for this item first
            const conversations = await getConversations(item.id);
            if (conversations.length > 0) {
                // Load the most recent conversation for this item
                currentConversationID = conversations[0].id;
            } else {
                // No conversations, create new one
                const newConv = createNewConversation(item.id);
                currentConversationID = newConv.id;
            }
        }

        // Declare updateOptionsList and updateTriggerLabel in outer scope so they can be accessed by createConversationListDialog
        let updateOptionsListFunc: (() => Promise<void>) | null = null;
        let updateTriggerLabelFunc: (() => Promise<void>) | null = null;
        let setCurrentItemIDFunc: ((id: number | null) => void) | null = null;

        // Create custom article selector (same style as model selector)
        const createArticleSelector = () => {
            const articleSelector = doc.createElement("div") as any;
            articleSelector.id = "article-selector-custom";
            articleSelector.style.position = "relative";
            articleSelector.style.display = "inline-block";
            articleSelector.style.minWidth = "200px";
            articleSelector.style.flex = "1";

            let currentItemID: number | null = item.id;

            // Trigger Button
            const trigger = doc.createElement("div");
            trigger.style.padding = "8px 12px";
            trigger.style.border = "1px solid #d0d0d0";
            trigger.style.borderRadius = "6px";
            trigger.style.backgroundColor = "#ffffff";
            trigger.style.cursor = "pointer";
            trigger.style.display = "flex";
            trigger.style.alignItems = "center";
            trigger.style.justifyContent = "space-between";
            trigger.style.fontSize = "13px";
            trigger.style.color = "#444";
            trigger.style.fontWeight = "500";
            trigger.style.boxShadow = "0 1px 2px rgba(0,0,0,0.05)";
            trigger.style.transition = "all 0.2s ease";
            trigger.style.userSelect = "none";

            const triggerLabel = doc.createElement("span");
            triggerLabel.style.cssText = "overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0;";
            const updateTriggerLabel = async () => {
                if (currentPaperGroupID) {
                    const group = await getPaperGroup(currentPaperGroupID);
                    if (group) {
                        triggerLabel.textContent = `📚 ${group.name}`;
                        return;
                    }
                }
                if (currentItemID) {
                    const currentItem = Zotero.Items.get(currentItemID);
                    if (currentItem) {
                        const title = currentItem.getField('title') || 'Untitled';
                        triggerLabel.textContent = title;
                        return;
                    }
                }
                const title = item.getField('title') || 'Untitled';
                triggerLabel.textContent = title;
            };
            updateTriggerLabelFunc = updateTriggerLabel;
            updateTriggerLabel();

            const triggerArrow = doc.createElement("span");
            triggerArrow.innerHTML = `<svg width="10" height="10" viewBox="0 0 12 12" style="display:block; opacity:0.6;"><path fill="currentColor" d="M6 8.5L2 4.5h8z"/></svg>`;

            trigger.appendChild(triggerLabel);
            trigger.appendChild(triggerArrow);
            articleSelector.appendChild(trigger);

            // Options List
            const optionsList = doc.createElement("div");
            optionsList.style.position = "absolute";
            optionsList.style.top = "calc(100% + 4px)";
            optionsList.style.left = "0";
            optionsList.style.width = "100%";
            optionsList.style.maxHeight = "450px"; // Increased to accommodate management button
            optionsList.style.overflowY = "auto";
            optionsList.style.backgroundColor = "#ffffff";
            optionsList.style.border = "1px solid #d0d0d0";
            optionsList.style.borderRadius = "6px";
            optionsList.style.boxShadow = "0 4px 16px rgba(0,0,0,0.12)";
            optionsList.style.zIndex = "9999";
            optionsList.style.display = "none";
            optionsList.style.overflow = "visible";
            optionsList.style.flexDirection = "column";

            // Store scroll positions to restore after update
            let savedPapersScrollTop = 0;
            let savedGroupsScrollTop = 0;

            const updateOptionsList = async () => {
                // Save current scroll positions before clearing
                const existingPapersContainer = optionsList.querySelector("div[style*='max-height: 120px']") as HTMLElement;
                const existingGroupsContainer = optionsList.querySelector("div[style*='max-height: 100px']") as HTMLElement;
                if (existingPapersContainer) {
                    savedPapersScrollTop = existingPapersContainer.scrollTop;
                }
                if (existingGroupsContainer) {
                    savedGroupsScrollTop = existingGroupsContainer.scrollTop;
                }

                optionsList.innerHTML = "";
                const readers = await getAllOpenPDFReaders();
                const paperGroups = await getAllPaperGroups();

                // Add header for individual papers (put papers first)
                const paperHeader = doc.createElement("div");
                paperHeader.style.cssText = `
                    padding: 6px 12px;
                    font-size: 11px;
                    font-weight: 600;
                    color: #666;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    background-color: #f8f9fa;
                    border-bottom: 1px solid #e0e0e0;
                    flex-shrink: 0;
                `;
                paperHeader.textContent = "📄 单篇论文";
                optionsList.appendChild(paperHeader);

                // Create scrollable container for papers (max 3 items)
                const papersContainer = doc.createElement("div");
                papersContainer.style.cssText = `
                    max-height: 120px;
                    overflow-y: auto;
                    overflow-x: hidden;
                `;
                // Restore scroll position after a brief delay to ensure DOM is ready
                setTimeout(() => {
                    papersContainer.scrollTop = savedPapersScrollTop;
                }, 0);

                if (readers.length === 0) {
                    const emptyItem = doc.createElement("div");
                    emptyItem.textContent = "没有打开的PDF阅读器";
                    emptyItem.style.padding = "8px 12px";
                    emptyItem.style.fontSize = "13px";
                    emptyItem.style.color = "#999";
                    emptyItem.style.textAlign = "center";
                    emptyItem.style.fontStyle = "italic";
                    papersContainer.appendChild(emptyItem);
                } else {
                    readers.forEach(({ item: readerItem, title }) => {
                        const optionItem = doc.createElement("div");
                        optionItem.textContent = title;
                        optionItem.style.padding = "8px 12px";
                        optionItem.style.fontSize = "13px";
                        optionItem.style.color = "#333";
                        optionItem.style.cursor = "pointer";
                        optionItem.style.overflow = "hidden";
                        optionItem.style.textOverflow = "ellipsis";
                        optionItem.style.whiteSpace = "nowrap";
                        optionItem.style.transition = "background-color 0.1s";
                        optionItem.style.userSelect = "none";
                        optionItem.style.borderBottom = "1px solid #f5f5f5";

                        if (readerItem.id === currentItemID && !currentPaperGroupID) {
                            optionItem.style.backgroundColor = "#e3f2fd";
                            optionItem.style.fontWeight = "600";
                        }

                        optionItem.onmouseenter = () => {
                            if (readerItem.id !== currentItemID || currentPaperGroupID) {
                                optionItem.style.backgroundColor = "#f5f5f5";
                            }
                        };
                        optionItem.onmouseleave = () => {
                            if (readerItem.id !== currentItemID || currentPaperGroupID) {
                                optionItem.style.backgroundColor = "#ffffff";
                            }
                        };
                        optionItem.onclick = async (e: Event) => {
                            e.stopPropagation();
                            if (readerItem.id === currentItemID && !currentPaperGroupID) {
                                optionsList.style.display = "none";
                                return;
                            }

                            // Save current conversation before switching (only if it has user messages)
                            if (currentConversationID && currentConversationItemID) {
                                const currentMessages = collectMessagesFromDom(messagesArea);
                                // Only save if there are user messages
                                if (currentMessages.some(m => m.type === "user")) {
                                    await saveCurrentConversation(currentConversationItemID || undefined, currentConversationID, currentMessages, undefined, currentPaperGroupID || undefined);
                                }
                            }

                            // Save current window position before switching
                            const currentX = win.screenX;
                            const currentY = win.screenY;
                            const currentWidth = win.outerWidth;
                            const currentHeight = win.outerHeight;

                            // Store position restore function
                            const restorePosition = () => {
                                try {
                                    win.moveTo(currentX, currentY);
                                    win.resizeTo(currentWidth, currentHeight);
                                } catch (e) {
                                    // Ignore if moveTo/resizeTo fails
                                }
                            };

                            // Switch to new item - try to load latest conversation first, create new if none exists
                            currentItemID = readerItem.id;
                            currentPaperGroupID = null; // Clear group selection
                            updateTriggerLabel();
                            optionsList.style.display = "none";
                            // Try to load latest conversation first, create new if none exists
                            ChatFactory.initChatWindow(win, readerItem, initialPinned, false, true);
                            // Note: Warning message will be automatically shown/hidden by checkSelection polling
                            // Restore position immediately and multiple times to ensure it sticks
                            restorePosition();
                            setTimeout(restorePosition, 50);
                            setTimeout(restorePosition, 200);
                            setTimeout(restorePosition, 500);
                        };

                        papersContainer.appendChild(optionItem);
                    });
                }
                optionsList.appendChild(papersContainer);

                // Add separator before paper groups
                if (paperGroups.length > 0) {
                    const separator = doc.createElement("div");
                    separator.style.cssText = `
                        height: 1px;
                        background-color: #e0e0e0;
                        margin: 4px 0;
                    `;
                    optionsList.appendChild(separator);
                }

                // Add separator for paper groups if there are any (put groups after papers)
                if (paperGroups.length > 0) {
                    const groupHeader = doc.createElement("div");
                    groupHeader.style.cssText = `
                        padding: 6px 12px;
                        font-size: 11px;
                        font-weight: 600;
                        color: #666;
                        text-transform: uppercase;
                        letter-spacing: 0.5px;
                        background-color: #f8f9fa;
                        border-bottom: 1px solid #e0e0e0;
                        flex-shrink: 0;
                    `;
                    groupHeader.textContent = "📚 论文组";
                    optionsList.appendChild(groupHeader);

                    // Create scrollable container for groups (max 2 items)
                    const groupsContainer = doc.createElement("div");
                    groupsContainer.style.cssText = `
                        max-height: 100px;
                        overflow-y: auto;
                        overflow-x: hidden;
                    `;
                    // Restore scroll position after a brief delay to ensure DOM is ready
                    setTimeout(() => {
                        groupsContainer.scrollTop = savedGroupsScrollTop;
                    }, 0);

                    // Add paper groups
                    paperGroups.forEach((group) => {
                        const groupItem = doc.createElement("div");
                        groupItem.style.cssText = `
                            padding: 10px 12px;
                            font-size: 13px;
                            color: #333;
                            cursor: pointer;
                            transition: background-color 0.1s;
                            user-select: none;
                            border-bottom: 1px solid #f5f5f5;
                            display: flex;
                            align-items: center;
                            gap: 8px;
                        `;

                        const groupIcon = doc.createElement("span");
                        groupIcon.textContent = "📑";
                        groupIcon.style.fontSize = "14px";

                        const groupInfo = doc.createElement("div");
                        groupInfo.style.cssText = "flex: 1; min-width: 0;";

                        const groupName = doc.createElement("div");
                        groupName.textContent = group.name;
                        groupName.style.cssText = "font-weight: 500; margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";

                        const groupMeta = doc.createElement("div");
                        groupMeta.textContent = `${group.itemIDs.length} 篇论文`;
                        groupMeta.style.cssText = "font-size: 11px; color: #999;";

                        groupInfo.appendChild(groupName);
                        groupInfo.appendChild(groupMeta);
                        groupItem.appendChild(groupIcon);
                        groupItem.appendChild(groupInfo);

                        if (currentPaperGroupID === group.id) {
                            groupItem.style.backgroundColor = "#e3f2fd";
                            groupItem.style.fontWeight = "600";
                        }

                        groupItem.onmouseenter = () => {
                            if (currentPaperGroupID !== group.id) {
                                groupItem.style.backgroundColor = "#f5f5f5";
                            }
                        };
                        groupItem.onmouseleave = () => {
                            if (currentPaperGroupID !== group.id) {
                                groupItem.style.backgroundColor = "#ffffff";
                            }
                        };
                        groupItem.onclick = async (e: Event) => {
                            e.stopPropagation();
                            if (currentPaperGroupID === group.id) {
                                optionsList.style.display = "none";
                                return;
                            }

                            // Save current conversation before switching
                            if (currentConversationID && currentConversationItemID) {
                                const currentMessages = collectMessagesFromDom(messagesArea);
                                if (currentMessages.some(m => m.type === "user")) {
                                    await saveCurrentConversation(currentConversationItemID, currentConversationID, currentMessages);
                                }
                            }

                            // Save current conversation before switching (only if it has user messages)
                            if (currentConversationID && (currentConversationItemID || currentPaperGroupID)) {
                                const currentMessages = collectMessagesFromDom(messagesArea);
                                if (currentMessages.some(m => m.type === "user")) {
                                    await saveCurrentConversation(currentConversationItemID || undefined, currentConversationID, currentMessages, undefined, currentPaperGroupID || undefined);
                                }
                            }

                            // Switch to paper group mode
                            currentPaperGroupID = group.id;
                            currentItemID = null; // Clear single item selection
                            triggerLabel.textContent = `📚 ${group.name}`;
                            optionsList.style.display = "none";

                            // Try to load the latest conversation for this group first
                            const groupConversations = await getConversations(undefined, group.id);
                            if (groupConversations.length > 0) {
                                // Load the most recent conversation for this group
                                currentConversationID = groupConversations[0].id;
                                currentConversationItemID = null;

                                // Load conversation messages
                                messagesArea.innerHTML = "";
                                const conversation = await getConversation(undefined, currentConversationID, group.id);
                                if (conversation) {
                                    conversation.messages.forEach(msg => {
                                        addMessage(messagesArea, msg.sender, msg.text, msg.type);
                                    });
                                }
                            } else {
                                // No conversations, create new one and show greeting
                                const newConv = createNewConversation(undefined, undefined, group.id);
                                currentConversationID = newConv.id;
                                currentConversationItemID = null;

                                // Clear messages and show greeting
                                messagesArea.innerHTML = "";

                                // Get all paper titles and check which PDFs are not open
                                const paperTitles: string[] = [];
                                const papersWithoutPDF = await getPapersWithoutOpenPDF(group);

                                for (const itemID of group.itemIDs) {
                                    try {
                                        const paperItem = Zotero.Items.get(itemID);
                                        if (paperItem) {
                                            const title = paperItem.getField('title') || 'Untitled';
                                            paperTitles.push(title);
                                        }
                                    } catch (e) {
                                        Zotero.debug(`Error getting paper ${itemID}: ${e}`);
                                    }
                                }

                                // Create greeting message with all papers
                                let greetingMsg = `您好！我可以帮您处理以下 ${paperTitles.length} 篇论文：\n\n`;
                                paperTitles.forEach((title, index) => {
                                    greetingMsg += `${index + 1}. ${title}\n`;
                                });
                                greetingMsg += `\n您可以让我分析、比较或讨论这些论文中的任何内容。`;

                                addMessage(messagesArea, "AI", greetingMsg, "ai");
                            }

                            // Check which papers in the group are not in the single article list (opened PDFs)
                            // Show overlay warning after switching to the group
                            const papersNotInList = await getPapersNotInSingleArticleList(group);
                            if (papersNotInList.length > 0) {
                                showPapersNotInListWarning(doc, papersNotInList);
                            }
                        };

                        groupsContainer.appendChild(groupItem);
                    });

                    optionsList.appendChild(groupsContainer);
                }

                // Add management button (always show, fixed at bottom)
                const manageSection = doc.createElement("div");
                manageSection.style.cssText = `
                    padding: 4px;
                    border-top: 1px solid #e0e0e0;
                    background-color: #ffffff;
                    flex-shrink: 0;
                    position: sticky;
                    bottom: 0;
                `;

                const manageGroupBtn = doc.createElement("button");
                manageGroupBtn.textContent = "管理论文组";
                manageGroupBtn.style.cssText = `
                    width: 100%;
                    padding: 8px;
                    font-size: 12px;
                    border: 1px solid #d0d0d0;
                    border-radius: 4px;
                    background-color: #fff;
                    color: #333;
                    cursor: pointer;
                    transition: background-color 0.2s;
                `;
                manageGroupBtn.onmouseenter = () => {
                    manageGroupBtn.style.backgroundColor = "#f5f5f5";
                };
                manageGroupBtn.onmouseleave = () => {
                    manageGroupBtn.style.backgroundColor = "#fff";
                };
                manageGroupBtn.onclick = async (e: Event) => {
                    e.stopPropagation();
                    optionsList.style.display = "none";
                    await showPaperGroupManager(win, doc, messagesArea, updateOptionsListFunc!, updateTriggerLabelFunc!, (id: number | null) => {
                        currentItemID = id;
                    });
                };

                manageSection.appendChild(manageGroupBtn);
                optionsList.appendChild(manageSection);
            };

            // Toggle
            trigger.onclick = (e: Event) => {
                e.stopPropagation();
                const isVisible = optionsList.style.display !== "none";
                if (!isVisible) {
                    updateOptionsList();
                }
                optionsList.style.display = isVisible ? "none" : "flex";
                if (!isVisible) {
                    trigger.style.borderColor = "#007bff";
                    trigger.style.boxShadow = "0 0 0 2px rgba(0,123,255,0.1)";
                } else {
                    trigger.style.borderColor = "#d0d0d0";
                    trigger.style.boxShadow = "0 1px 2px rgba(0,0,0,0.05)";
                }
            };

            // Close on outside click
            const closeHandler = (e: Event) => {
                if (!articleSelector.isConnected) {
                    win.removeEventListener("click", closeHandler);
                    return;
                }
                if (!articleSelector.contains(e.target as Node)) {
                    optionsList.style.display = "none";
                    trigger.style.borderColor = "#d0d0d0";
                    trigger.style.boxShadow = "0 1px 2px rgba(0,0,0,0.05)";
                }
            };
            win.addEventListener("click", closeHandler);

            // Hover effects
            trigger.onmouseenter = () => {
                if (optionsList.style.display !== "block") trigger.style.borderColor = "#b0b0b0";
            };
            trigger.onmouseleave = () => {
                if (optionsList.style.display !== "block") trigger.style.borderColor = "#d0d0d0";
            };

            articleSelector.appendChild(optionsList);

            // Update selector periodically to catch newly opened readers
            // Only update when the list is not visible to avoid resetting scroll position
            const selectorUpdateInterval = setInterval(() => {
                if (optionsList.style.display === "none") {
                    // Only update when list is hidden to avoid resetting scroll position
                    // The list will be updated when opened anyway
                }
            }, 2000);

            // Clean up interval when window closes
            // Note: selectorUpdateInterval is cleaned up in createArticleSelector function

            // Store functions in outer scope
            updateOptionsListFunc = updateOptionsList;
            setCurrentItemIDFunc = (id: number | null) => {
                currentItemID = id;
            };

            return articleSelector;
        };

        const articleSelector = createArticleSelector();

        // Insert article selector into header
        const chatHeader = doc.getElementById("chat-header");
        if (chatHeader) {
            // Remove any existing article selector
            const existingCustom = chatHeader.querySelector("#article-selector-custom");
            if (existingCustom) {
                existingCustom.remove();
            }
            // Insert at the beginning of header
            chatHeader.insertBefore(articleSelector, chatHeader.firstChild);
        }

        // Create conversation list dialog
        const createConversationListDialog = async () => {
            // Remove existing dialog if any
            const existingDialog = doc.getElementById("conversation-list-dialog");
            if (existingDialog) {
                existingDialog.remove();
            }

            const allConversations = await getAllConversations();
            if (allConversations.length === 0) {
                addMessage(messagesArea, "System", "没有找到历史对话记录。", "system");
                return;
            }

            // Create dialog overlay
            const overlay = doc.createElement("div");
            overlay.id = "conversation-list-dialog";
            overlay.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background-color: rgba(0, 0, 0, 0.5);
                z-index: 10000;
                display: flex;
                align-items: center;
                justify-content: center;
            `;

            // Create dialog container
            const dialog = doc.createElement("div");
            dialog.style.cssText = `
                background: white;
                border-radius: 8px;
                box-shadow: 0 4px 20px rgba(0,0,0,0.3);
                width: 500px;
                max-height: 600px;
                display: flex;
                flex-direction: column;
            `;

            // Dialog header
            const header = doc.createElement("div");
            header.style.cssText = `
                padding: 16px 20px;
                border-bottom: 1px solid #eee;
                display: flex;
                justify-content: space-between;
                align-items: center;
            `;
            const title = doc.createElement("h3");
            title.textContent = "对话历史";
            title.style.cssText = "margin: 0; font-size: 16px; font-weight: 600;";
            const closeBtn = doc.createElement("button");
            closeBtn.textContent = "×";
            closeBtn.style.cssText = `
                background: none;
                border: none;
                font-size: 24px;
                cursor: pointer;
                color: #666;
                padding: 0;
                width: 30px;
                height: 30px;
            `;
            closeBtn.onclick = () => overlay.remove();
            header.appendChild(title);
            header.appendChild(closeBtn);

            // Dialog content
            const content = doc.createElement("div");
            content.style.cssText = `
                padding: 10px;
                overflow-y: auto;
                flex: 1;
            `;

            // Use for...of instead of forEach to support await
            for (const conv of allConversations) {
                const convItem = doc.createElement("div");
                convItem.style.cssText = `
                    padding: 12px;
                    border: 1px solid #e0e0e0;
                    border-radius: 6px;
                    margin-bottom: 8px;
                    cursor: pointer;
                    transition: background-color 0.2s;
                    position: relative;
                    ${conv.id === currentConversationID ? 'background-color: #e3f2fd; border-color: #007bff;' : ''}
                `;

                // Get item title or group name
                let itemTitle = 'Unknown';
                let isGroupConversation = false;
                if (conv.groupID) {
                    // Group conversation
                    isGroupConversation = true;
                    try {
                        const group = await getPaperGroup(conv.groupID);
                        if (group) {
                            itemTitle = `📚 ${group.name}`;
                        } else {
                            itemTitle = `📚 论文组 (已删除)`;
                        }
                    } catch (e) {
                        itemTitle = `📚 论文组`;
                    }
                } else if (conv.itemID) {
                    // Single item conversation
                    const convItemObj = Zotero.Items.get(conv.itemID);
                    itemTitle = convItemObj ? convItemObj.getField('title') || 'Untitled' : 'Unknown';
                }

                // Create content wrapper
                const contentWrapper = doc.createElement("div");
                contentWrapper.style.cssText = "flex: 1; padding-right: 30px;";

                const convTitle = doc.createElement("div");
                convTitle.textContent = conv.title;
                convTitle.style.cssText = "font-weight: 500; margin-bottom: 4px; font-size: 14px;";

                const convMeta = doc.createElement("div");
                const date = new Date(conv.updatedAt);
                convMeta.textContent = `${itemTitle} · ${conv.messages.length} 条消息 · ${date.toLocaleString('zh-CN')}`;
                convMeta.style.cssText = "font-size: 12px; color: #666;";

                contentWrapper.appendChild(convTitle);
                contentWrapper.appendChild(convMeta);

                // Create delete button
                const deleteBtn = doc.createElement("button");
                deleteBtn.innerHTML = "×";
                deleteBtn.style.cssText = `
                    position: absolute;
                    top: 8px;
                    right: 8px;
                    background: none;
                    border: none;
                    font-size: 20px;
                    cursor: pointer;
                    color: #999;
                    width: 24px;
                    height: 24px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: 4px;
                    transition: all 0.2s;
                    padding: 0;
                `;
                deleteBtn.onmouseenter = () => {
                    deleteBtn.style.color = "#dc3545";
                    deleteBtn.style.backgroundColor = "#f8f9fa";
                };
                deleteBtn.onmouseleave = () => {
                    deleteBtn.style.color = "#999";
                    deleteBtn.style.backgroundColor = "transparent";
                };
                deleteBtn.onclick = async (e) => {
                    e.stopPropagation(); // Prevent triggering convItem.onclick
                    await deleteConversation(conv.itemID, conv.id, conv.groupID);
                    // If deleted conversation is the current one, clear messages and create new conversation
                    if (conv.id === currentConversationID) {
                        currentConversationID = null;
                        messagesArea.innerHTML = "";
                        if (conv.groupID) {
                            const newConv = createNewConversation(undefined, undefined, conv.groupID);
                            currentConversationID = newConv.id;
                            currentPaperGroupID = conv.groupID;
                            currentConversationItemID = null;
                        } else if (conv.itemID) {
                            const newConv = createNewConversation(conv.itemID);
                            currentConversationID = newConv.id;
                            currentConversationItemID = conv.itemID;
                        }
                    }
                    // Refresh the dialog
                    overlay.remove();
                    await createConversationListDialog();
                };

                convItem.appendChild(contentWrapper);
                convItem.appendChild(deleteBtn);

                convItem.onmouseenter = () => {
                    if (conv.id !== currentConversationID) {
                        convItem.style.backgroundColor = "#f5f5f5";
                    }
                };
                convItem.onmouseleave = () => {
                    if (conv.id !== currentConversationID) {
                        convItem.style.backgroundColor = conv.id === currentConversationID ? "#e3f2fd" : "white";
                    }
                };

                convItem.onclick = async () => {
                    if (conv.id === currentConversationID) {
                        overlay.remove();
                        return;
                    }

                    // Save current conversation before switching (only if it has user messages)
                    if (currentConversationID && (currentConversationItemID || currentPaperGroupID)) {
                        const currentMessages = collectMessagesFromDom(messagesArea);
                        // Only save if there are user messages
                        if (currentMessages.some(m => m.type === "user")) {
                            await saveCurrentConversation(currentConversationItemID || undefined, currentConversationID, currentMessages, undefined, currentPaperGroupID || undefined);
                        }
                    }

                    // Load the selected conversation
                    currentConversationID = conv.id;

                    if (conv.groupID) {
                        // Group conversation
                        currentPaperGroupID = conv.groupID;
                        currentConversationItemID = null;

                        // Update trigger label and options list
                        if (updateTriggerLabelFunc) {
                            await updateTriggerLabelFunc();
                        }
                        if (updateOptionsListFunc) {
                            await updateOptionsListFunc();
                        }

                        // Load conversation messages
                        messagesArea.innerHTML = "";
                        const conversation = await getConversation(undefined, conv.id, conv.groupID);
                        if (conversation) {
                            conversation.messages.forEach(msg => {
                                addMessage(messagesArea, msg.sender, msg.text, msg.type);
                            });
                        }

                        // Check which papers in the group have PDFs not opened
                        const group = await getPaperGroup(conv.groupID);
                        if (group) {
                            const papersWithoutPDF = await getPapersWithoutOpenPDF(group);
                            if (papersWithoutPDF.length > 0) {
                                const warningMsg = `⚠️ 提示：以下 ${papersWithoutPDF.length} 篇论文的PDF尚未打开，可能影响分析效果：\n${papersWithoutPDF.map((paper, index) => `${index + 1}. ${paper.title}`).join('\n')}\n\n建议先打开这些论文的PDF以获得更好的分析效果。`;
                                win.alert(warningMsg);
                            }
                        }

                        overlay.remove();
                    } else if (conv.itemID) {
                        // Single item conversation
                        const convItem = Zotero.Items.get(conv.itemID);
                        if (convItem) {
                            // Clear group mode
                            currentPaperGroupID = null;
                            currentConversationItemID = convItem.id;

                            // Update currentItemID in article selector
                            if (setCurrentItemIDFunc) {
                                setCurrentItemIDFunc(convItem.id);
                            }

                            // Update trigger label and options list to reflect the switch
                            if (updateTriggerLabelFunc) {
                                await updateTriggerLabelFunc();
                            }
                            if (updateOptionsListFunc) {
                                await updateOptionsListFunc();
                            }

                            // Save current window position before switching
                            const currentX = win.screenX;
                            const currentY = win.screenY;
                            const currentWidth = win.outerWidth;
                            const currentHeight = win.outerHeight;

                            // Switch to the conversation's item if different
                            if (convItem.id !== item.id) {
                                overlay.remove();

                                // Store position restore function
                                const restorePosition = () => {
                                    try {
                                        win.moveTo(currentX, currentY);
                                        win.resizeTo(currentWidth, currentHeight);
                                    } catch (e) {
                                        // Ignore if moveTo/resizeTo fails
                                    }
                                };

                                ChatFactory.initChatWindow(win, convItem, initialPinned, false, true);
                                // Note: Warning message will be automatically shown/hidden by checkSelection polling // preservePosition = true
                                // Restore position immediately and multiple times to ensure it sticks
                                restorePosition();
                                setTimeout(restorePosition, 50);
                                setTimeout(restorePosition, 200);
                                setTimeout(restorePosition, 500);
                            } else {
                                // Same item, just load messages
                                messagesArea.innerHTML = "";
                                const conversation = await getConversation(convItem.id, conv.id);
                                if (conversation) {
                                    conversation.messages.forEach(({ sender, text, type }) => {
                                        addMessage(messagesArea, sender, text, type);
                                    });
                                }
                                overlay.remove();
                            }
                        }
                    }
                };

                content.appendChild(convItem);
            }

            dialog.appendChild(header);
            dialog.appendChild(content);
            overlay.appendChild(dialog);
            overlay.onclick = (e) => {
                if (e.target === overlay) {
                    overlay.remove();
                }
            };
            if (doc.body) {
                doc.body.appendChild(overlay);
            }
        };

        // Paper Group Management Dialog
        const showPaperGroupManager = async (
            win: Window,
            doc: Document,
            messagesArea: HTMLElement,
            updateOptionsList: () => Promise<void>,
            updateTriggerLabel: () => Promise<void>,
            setCurrentItemID?: (id: number | null) => void
        ) => {
            // Remove existing dialog if any
            const existingDialog = doc.getElementById("paper-group-manager-dialog");
            if (existingDialog) {
                existingDialog.remove();
            }

            const allGroups = await getAllPaperGroups();
            const readers = await getAllOpenPDFReaders();

            // Create dialog overlay
            const overlay = doc.createElement("div");
            overlay.id = "paper-group-manager-dialog";
            overlay.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background-color: rgba(0, 0, 0, 0.5);
                z-index: 10000;
                display: flex;
                align-items: center;
                justify-content: center;
            `;

            // Create dialog container
            const dialog = doc.createElement("div");
            dialog.style.cssText = `
                background: white;
                border-radius: 12px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.2);
                width: min(600px, 90vw);
                max-height: min(600px, 85vh);
                display: flex;
                flex-direction: column;
            `;

            // Dialog header
            const header = doc.createElement("div");
            header.style.cssText = `
                padding: 20px 24px;
                border-bottom: 1px solid #eee;
                display: flex;
                justify-content: space-between;
                align-items: center;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                border-radius: 12px 12px 0 0;
            `;
            const title = doc.createElement("h3");
            title.textContent = "📚 论文组管理";
            title.style.cssText = "margin: 0; font-size: 18px; font-weight: 600; color: white;";
            const closeBtn = doc.createElement("button");
            closeBtn.textContent = "×";
            closeBtn.style.cssText = `
                background: rgba(255,255,255,0.2);
                border: none;
                font-size: 24px;
                cursor: pointer;
                color: white;
                padding: 0;
                width: 32px;
                height: 32px;
                border-radius: 50%;
                transition: background-color 0.2s;
            `;
            closeBtn.onmouseenter = () => {
                closeBtn.style.backgroundColor = "rgba(255,255,255,0.3)";
            };
            closeBtn.onmouseleave = () => {
                closeBtn.style.backgroundColor = "rgba(255,255,255,0.2)";
            };
            closeBtn.onclick = () => overlay.remove();
            header.appendChild(title);
            header.appendChild(closeBtn);

            // Dialog content
            const content = doc.createElement("div");
            content.style.cssText = `
                padding: 16px 20px;
                overflow-y: auto;
                flex: 1;
                display: flex;
                flex-direction: column;
                min-height: 0;
            `;

            // Create new group section (collapsible)
            let createSectionExpanded = false;
            const createSection = doc.createElement("div");
            createSection.style.cssText = `
                margin-bottom: 16px;
                border: 1px solid #e0e0e0;
                border-radius: 8px;
                background: white;
                overflow: hidden;
                flex-shrink: 0;
                position: sticky;
                top: 0;
                z-index: 10;
                background-color: white;
            `;

            const createHeader = doc.createElement("div");
            createHeader.style.cssText = `
                padding: 12px 16px;
                background: #f8f9fa;
                cursor: pointer;
                display: flex;
                justify-content: space-between;
                align-items: center;
                user-select: none;
            `;
            const createTitle = doc.createElement("div");
            createTitle.textContent = "➕ 创建新论文组";
            createTitle.style.cssText = "font-weight: 600; font-size: 14px; color: #495057;";
            const expandIcon = doc.createElement("span");
            expandIcon.textContent = "▼";
            expandIcon.style.cssText = "font-size: 12px; color: #666; transition: transform 0.2s;";
            createHeader.appendChild(createTitle);
            createHeader.appendChild(expandIcon);

            const createContent = doc.createElement("div");
            createContent.style.cssText = `
                padding: 16px;
                display: none;
                flex-direction: column;
                max-height: 280px;
                overflow-y: auto;
            `;

            const createScrollable = doc.createElement("div");
            createScrollable.style.cssText = `
                display: flex;
                flex-direction: column;
                overflow: visible;
                min-height: 0;
                margin-bottom: 10px;
            `;

            const nameInput = doc.createElement("input");
            nameInput.type = "text";
            nameInput.placeholder = "输入论文组名称...";
            nameInput.style.cssText = `
                width: 100%;
                padding: 8px 10px;
                border: 1px solid #dee2e6;
                border-radius: 6px;
                font-size: 13px;
                margin-bottom: 10px;
                box-sizing: border-box;
            `;

            const papersSelect = doc.createElement("div");
            papersSelect.style.cssText = `
                max-height: 90px;
                overflow-y: auto;
                overflow-x: hidden;
                border: 1px solid #dee2e6;
                border-radius: 6px;
                padding: 6px;
                background: white;
                margin-bottom: 10px;
            `;

            if (readers.length === 0) {
                const emptyMsg = doc.createElement("div");
                emptyMsg.textContent = "没有打开的PDF阅读器";
                emptyMsg.style.cssText = "padding: 12px; text-align: center; color: #999; font-style: italic;";
                papersSelect.appendChild(emptyMsg);
            } else {
                const selectedItemIDs: number[] = [];
                readers.forEach(({ item: readerItem, title }) => {
                    const checkboxContainer = doc.createElement("div");
                    checkboxContainer.style.cssText = `
                        padding: 8px;
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        border-radius: 4px;
                        transition: background-color 0.2s;
                    `;

                    const checkbox = doc.createElement("input");
                    checkbox.type = "checkbox";
                    checkbox.value = readerItem.id.toString();
                    checkbox.style.cssText = "cursor: pointer;";

                    const label = doc.createElement("label");
                    label.textContent = title;
                    label.style.cssText = "flex: 1; cursor: pointer; font-size: 13px; color: #333; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;";
                    label.onclick = (e) => {
                        e.preventDefault();
                        checkbox.checked = !checkbox.checked;
                        if (checkbox.checked) {
                            selectedItemIDs.push(readerItem.id);
                        } else {
                            const index = selectedItemIDs.indexOf(readerItem.id);
                            if (index > -1) selectedItemIDs.splice(index, 1);
                        }
                    };

                    checkbox.onchange = () => {
                        if (checkbox.checked) {
                            if (!selectedItemIDs.includes(readerItem.id)) {
                                selectedItemIDs.push(readerItem.id);
                            }
                        } else {
                            const index = selectedItemIDs.indexOf(readerItem.id);
                            if (index > -1) selectedItemIDs.splice(index, 1);
                        }
                    };

                    checkboxContainer.onmouseenter = () => {
                        checkboxContainer.style.backgroundColor = "#f0f0f0";
                    };
                    checkboxContainer.onmouseleave = () => {
                        checkboxContainer.style.backgroundColor = "transparent";
                    };

                    checkboxContainer.appendChild(checkbox);
                    checkboxContainer.appendChild(label);
                    papersSelect.appendChild(checkboxContainer);
                });
            }

            const createBtn = doc.createElement("button");
            createBtn.textContent = "创建论文组";
            createBtn.style.cssText = `
                width: 100%;
                padding: 10px;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                border: none;
                border-radius: 6px;
                font-size: 14px;
                font-weight: 600;
                cursor: pointer;
                transition: transform 0.2s, box-shadow 0.2s;
            `;
            createBtn.onmouseenter = () => {
                createBtn.style.transform = "translateY(-1px)";
                createBtn.style.boxShadow = "0 4px 12px rgba(102, 126, 234, 0.4)";
            };
            createBtn.onmouseleave = () => {
                createBtn.style.transform = "translateY(0)";
                createBtn.style.boxShadow = "none";
            };
            createBtn.onclick = async () => {
                const groupName = nameInput.value.trim();
                if (!groupName) {
                    win.alert("请输入论文组名称");
                    return;
                }
                const checkboxes = papersSelect.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked');
                const selectedIDs: number[] = [];
                checkboxes.forEach((cb: HTMLInputElement) => {
                    selectedIDs.push(parseInt(cb.value));
                });
                if (selectedIDs.length === 0) {
                    win.alert("请至少选择一篇论文");
                    return;
                }
                await createPaperGroup(groupName, selectedIDs);
                overlay.remove();
                await updateOptionsList();
            };

            createHeader.onclick = () => {
                createSectionExpanded = !createSectionExpanded;
                if (createSectionExpanded) {
                    createContent.style.display = "flex";
                    expandIcon.style.transform = "rotate(180deg)";
                } else {
                    createContent.style.display = "none";
                    expandIcon.style.transform = "rotate(0deg)";
                }
            };

            createScrollable.appendChild(nameInput);
            createScrollable.appendChild(papersSelect);
            // Create button container to ensure it's always visible
            const createBtnContainer = doc.createElement("div");
            createBtnContainer.style.cssText = `
                flex-shrink: 0;
                margin-top: 10px;
            `;
            createBtnContainer.appendChild(createBtn);
            createScrollable.appendChild(createBtnContainer);
            createContent.appendChild(createScrollable);
            createSection.appendChild(createHeader);
            createSection.appendChild(createContent);

            // Existing groups section
            const groupsTitleWrapper = doc.createElement("div");
            groupsTitleWrapper.style.cssText = "flex-shrink: 0;";
            const groupsTitle = doc.createElement("div");
            groupsTitle.textContent = "现有论文组";
            groupsTitle.style.cssText = "font-weight: 600; margin-bottom: 10px; font-size: 14px; color: #495057;";
            groupsTitleWrapper.appendChild(groupsTitle);

            const groupsSection = doc.createElement("div");
            groupsSection.style.cssText = `
                flex: 1;
                overflow-y: auto;
                min-height: 0;
                max-height: 300px;
            `;
            if (allGroups.length > 0) {
                // Use for...of to support await
                for (const group of allGroups) {
                    const groupItem = doc.createElement("div");
                    groupItem.style.cssText = `
                        padding: 12px;
                        border: 1px solid #e0e0e0;
                        border-radius: 6px;
                        margin-bottom: 8px;
                        background: white;
                        transition: box-shadow 0.2s, border-color 0.2s;
                    `;

                    groupItem.onmouseenter = () => {
                        groupItem.style.boxShadow = "0 2px 8px rgba(0,0,0,0.1)";
                        groupItem.style.borderColor = "#667eea";
                    };
                    groupItem.onmouseleave = () => {
                        groupItem.style.boxShadow = "none";
                        groupItem.style.borderColor = "#e0e0e0";
                    };

                    const groupHeader = doc.createElement("div");
                    groupHeader.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;";

                    const groupNameDiv = doc.createElement("div");
                    groupNameDiv.style.cssText = "flex: 1;";
                    const nameSpan = doc.createElement("div");
                    nameSpan.textContent = `📚 ${group.name}`;
                    nameSpan.style.cssText = "font-weight: 600; font-size: 15px; color: #333; margin-bottom: 4px;";
                    const metaSpan = doc.createElement("div");
                    metaSpan.textContent = `${group.itemIDs.length} 篇论文`;
                    metaSpan.style.cssText = "font-size: 12px; color: #666;";
                    groupNameDiv.appendChild(nameSpan);
                    groupNameDiv.appendChild(metaSpan);

                    const actionsDiv = doc.createElement("div");
                    actionsDiv.style.cssText = "display: flex; gap: 8px; position: relative; z-index: 10;";

                    const editBtn = doc.createElement("button");
                    editBtn.textContent = "编辑";
                    editBtn.style.cssText = `
                        padding: 6px 12px;
                        border: 1px solid #667eea;
                        background: white;
                        color: #667eea;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 12px;
                        transition: all 0.2s;
                        position: relative;
                        z-index: 11;
                    `;
                    editBtn.onmouseenter = () => {
                        editBtn.style.backgroundColor = "#667eea";
                        editBtn.style.color = "white";
                    };
                    editBtn.onmouseleave = () => {
                        editBtn.style.backgroundColor = "white";
                        editBtn.style.color = "#667eea";
                    };
                    editBtn.onclick = async (e: Event) => {
                        e.preventDefault();
                        e.stopPropagation();
                        // Simple edit: prompt for new name
                        const newName = win.prompt("输入新的论文组名称:", group.name);
                        if (newName && newName.trim()) {
                            await updatePaperGroup(group.id, newName.trim());
                            overlay.remove();
                            await showPaperGroupManager(win, doc, messagesArea, updateOptionsList, updateTriggerLabel);
                        }
                    };

                    const deleteBtn = doc.createElement("button");
                    deleteBtn.textContent = "删除";
                    deleteBtn.style.cssText = `
                        padding: 6px 12px;
                        border: 1px solid #dc3545;
                        background: white;
                        color: #dc3545;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 12px;
                        transition: all 0.2s;
                        position: relative;
                        z-index: 11;
                    `;
                    deleteBtn.onmouseenter = () => {
                        deleteBtn.style.backgroundColor = "#dc3545";
                        deleteBtn.style.color = "white";
                    };
                    deleteBtn.onmouseleave = () => {
                        deleteBtn.style.backgroundColor = "white";
                        deleteBtn.style.color = "#dc3545";
                    };
                    deleteBtn.onclick = async (e: Event) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (win.confirm(`确定要删除论文组 "${group.name}" 吗？`)) {
                            await deletePaperGroup(group.id);
                            if (currentPaperGroupID === group.id) {
                                currentPaperGroupID = null;
                                await updateTriggerLabel();
                            }
                            overlay.remove();
                            await showPaperGroupManager(win, doc, messagesArea, updateOptionsList, updateTriggerLabel);
                        }
                    };

                    const useBtn = doc.createElement("button");
                    useBtn.textContent = "使用";
                    useBtn.style.cssText = `
                        padding: 6px 12px;
                        border: none;
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        color: white;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 12px;
                        font-weight: 600;
                        transition: transform 0.2s;
                        position: relative;
                        z-index: 11;
                    `;
                    useBtn.onmouseenter = () => {
                        useBtn.style.transform = "translateY(-1px)";
                    };
                    useBtn.onmouseleave = () => {
                        useBtn.style.transform = "translateY(0)";
                    };
                    useBtn.onclick = async (e: Event) => {
                        e.preventDefault();
                        e.stopPropagation();
                        currentPaperGroupID = group.id;
                        // Clear currentItemID using the setter if provided
                        if (setCurrentItemID) {
                            setCurrentItemID(null);
                        }
                        await updateTriggerLabel();
                        messagesArea.innerHTML = "";

                        // Check for existing conversation
                        const allConversations = await getAllConversations();
                        const existingConv = allConversations.find(c => c.groupID === group.id);

                        if (existingConv && existingConv.messages.length > 0) {
                            // Load existing conversation
                            currentConversationID = existingConv.id;
                            existingConv.messages.forEach(({ sender, text, type }) => {
                                addMessage(messagesArea, sender, text, type);
                            });
                        } else {
                            // No history, create new conversation and show greeting
                            const newConv = createNewConversation(undefined, undefined, group.id);
                            currentConversationID = newConv.id;

                            // Get all paper titles and check which PDFs are not open
                            const paperTitles: string[] = [];
                            const papersWithoutPDF = await getPapersWithoutOpenPDF(group);

                            for (const itemID of group.itemIDs) {
                                try {
                                    const paperItem = Zotero.Items.get(itemID);
                                    if (paperItem) {
                                        const title = paperItem.getField('title') || 'Untitled';
                                        paperTitles.push(title);
                                    }
                                } catch (e) {
                                    Zotero.debug(`Error getting paper ${itemID}: ${e}`);
                                }
                            }

                            // Create greeting message with all papers
                            let greetingMsg = `您好！我可以帮您处理以下 ${paperTitles.length} 篇论文：\n\n`;
                            paperTitles.forEach((title, index) => {
                                greetingMsg += `${index + 1}. ${title}\n`;
                            });
                            greetingMsg += `\n您可以让我分析、比较或讨论这些论文中的任何内容。`;
                            addMessage(messagesArea, "AI", greetingMsg, "ai");
                        }

                        // Check which papers in the group are not in the single article list (opened PDFs)
                        // Show overlay warning after switching to the group
                        const papersNotInList = await getPapersNotInSingleArticleList(group);
                        if (papersNotInList.length > 0) {
                            showPapersNotInListWarning(doc, papersNotInList);
                        }

                        currentConversationItemID = null;
                        overlay.remove();
                        await updateOptionsList();
                    };

                    actionsDiv.appendChild(useBtn);
                    actionsDiv.appendChild(editBtn);
                    actionsDiv.appendChild(deleteBtn);

                    groupHeader.appendChild(groupNameDiv);
                    groupHeader.appendChild(actionsDiv);

                    // Paper list in group (collapsible)
                    let papersExpanded = false;
                    const papersList = doc.createElement("div");
                    papersList.style.cssText = "margin-top: 8px; padding-top: 8px; border-top: 1px solid #f0f0f0;";
                    const papersHeader = doc.createElement("div");
                    papersHeader.style.cssText = "display: flex; justify-content: space-between; align-items: center; cursor: pointer; user-select: none;";
                    const papersTitle = doc.createElement("div");
                    papersTitle.textContent = `包含的论文 (${group.itemIDs.length})`;
                    papersTitle.style.cssText = "font-size: 12px; color: #666; font-weight: 500;";
                    const papersExpandIcon = doc.createElement("span");
                    papersExpandIcon.textContent = "▼";
                    papersExpandIcon.style.cssText = "font-size: 10px; color: #999; transition: transform 0.2s;";
                    papersHeader.appendChild(papersTitle);
                    papersHeader.appendChild(papersExpandIcon);

                    const papersContainer = doc.createElement("div");
                    papersContainer.style.cssText = "display: none; margin-top: 6px; max-height: 80px; overflow-y: auto; overflow-x: hidden;";
                    // Use for...of to support await
                    for (const itemID of group.itemIDs) {
                        try {
                            const paperItem = Zotero.Items.get(itemID);
                            if (paperItem) {
                                const title = paperItem.getField('title') || 'Untitled';
                                const paperDiv = doc.createElement("div");
                                paperDiv.textContent = `• ${title}`;
                                paperDiv.style.cssText = "font-size: 11px; color: #888; padding: 2px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
                                papersContainer.appendChild(paperDiv);
                            }
                        } catch (e) {
                            // Item might not exist
                        }
                    }

                    papersHeader.onclick = () => {
                        papersExpanded = !papersExpanded;
                        if (papersExpanded) {
                            papersContainer.style.display = "block";
                            papersExpandIcon.style.transform = "rotate(180deg)";
                        } else {
                            papersContainer.style.display = "none";
                            papersExpandIcon.style.transform = "rotate(0deg)";
                        }
                    };

                    papersList.appendChild(papersHeader);
                    papersList.appendChild(papersContainer);

                    groupItem.appendChild(groupHeader);
                    groupItem.appendChild(papersList);
                    groupsSection.appendChild(groupItem);
                }
            } else {
                const emptyMsg = doc.createElement("div");
                emptyMsg.textContent = "还没有创建任何论文组";
                emptyMsg.style.cssText = "text-align: center; color: #999; padding: 20px; font-style: italic;";
                groupsSection.appendChild(emptyMsg);
            }

            content.appendChild(createSection);
            content.appendChild(groupsTitleWrapper);
            content.appendChild(groupsSection);

            dialog.appendChild(header);
            dialog.appendChild(content);
            overlay.appendChild(dialog);
            overlay.onclick = (e) => {
                if (e.target === overlay) {
                    overlay.remove();
                }
            };
            if (doc.body) {
                doc.body.appendChild(overlay);
            }
        };

        // Handle history button
        if (historyBtn) {
            historyBtn.onclick = async () => {
                await createConversationListDialog();
            };
        }

        // Handle new chat button
        if (newChatBtn) {
            newChatBtn.onclick = async () => {
                // Save current conversation before creating new one (only if it has user messages)
                if (currentConversationID && currentConversationItemID) {
                    const currentMessages = collectMessagesFromDom(messagesArea);
                    // Only save if there are user messages
                    if (currentMessages.some(m => m.type === "user")) {
                        await saveCurrentConversation(currentConversationItemID || undefined, currentConversationID, currentMessages, undefined, currentPaperGroupID || undefined);
                    }
                }

                // Create new conversation
                let newConv: Conversation;
                if (currentPaperGroupID) {
                    newConv = createNewConversation(undefined, undefined, currentPaperGroupID);
                    currentConversationID = newConv.id;
                    // Clear current messages
                    messagesArea.innerHTML = "";
                    // Get group info and greet all papers
                    const group = await getPaperGroup(currentPaperGroupID);
                    if (group) {
                        // Get all paper titles
                        const paperTitles: string[] = [];
                        for (const itemID of group.itemIDs) {
                            try {
                                const paperItem = Zotero.Items.get(itemID);
                                if (paperItem) {
                                    const title = paperItem.getField('title') || 'Untitled';
                                    paperTitles.push(title);
                                }
                            } catch (e) {
                                Zotero.debug(`Error getting paper ${itemID}: ${e}`);
                            }
                        }
                        // Create greeting message with all papers
                        let greetingMsg = `您好！我可以帮您处理以下 ${paperTitles.length} 篇论文：\n\n`;
                        paperTitles.forEach((title, index) => {
                            greetingMsg += `${index + 1}. ${title}\n`;
                        });
                        greetingMsg += `\n您可以让我分析、比较或讨论这些论文中的任何内容。`;
                        addMessage(messagesArea, "AI", greetingMsg, "ai");
                    } else {
                        addMessage(messagesArea, "System", "已选择论文组（论文组不存在或已删除）", "system");
                    }
                } else if (item) {
                    newConv = createNewConversation(item.id);
                    currentConversationID = newConv.id;
                    // Clear current messages
                    messagesArea.innerHTML = "";
                    // Start fresh conversation
                    const itemTitle = item.getField('title') || 'Untitled';
                    addMessage(messagesArea, "AI", `Hello! I can help you with "${itemTitle}". Ask me anything.`, "ai");
                } else {
                    return; // No item or group selected
                }
            };
        }

        // Clean up interval when window closes
        // Note: selectorUpdateInterval is cleaned up in createArticleSelector function

        // ... (Selection area logic) ...
        let selectionArea = doc.getElementById("selection-area") as HTMLElement | null;
        let selectionContent: HTMLElement | null = null;
        // let closeButton: HTMLButtonElement | null = null;

        if (!selectionArea) {
            selectionArea = doc.createElement("div");
            selectionArea.id = "selection-area";
            selectionArea.style.display = "none";
            selectionArea.title = "Selected text";

            // Create content container
            selectionContent = doc.createElement("span");
            selectionContent.id = "selection-area-content";
            selectionArea.appendChild(selectionContent);

            // Create close button - COMMENTED OUT
            // closeButton = doc.createElement("button");
            // closeButton.id = "selection-area-close";
            // closeButton.title = "取消选中";
            // closeButton.setAttribute("aria-label", "取消选中");

            // Create close icon (X) - COMMENTED OUT
            // const closeIcon = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
            // closeIcon.setAttribute("viewBox", "0 0 24 24");
            // closeIcon.setAttribute("width", "16");
            // closeIcon.setAttribute("height", "16");
            // const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
            // path.setAttribute("d", "M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z");
            // closeIcon.appendChild(path);
            // closeButton.appendChild(closeIcon);

            // selectionArea.appendChild(closeButton);

            if (messagesArea && messagesArea.nextSibling) {
                messagesArea.parentNode?.insertBefore(selectionArea, messagesArea.nextSibling);
            } else if (messagesArea) {
                messagesArea.parentNode?.appendChild(selectionArea);
            }
        } else {
            // If selection area already exists, get references to its children
            selectionContent = doc.getElementById("selection-area-content") as HTMLElement;
            // closeButton = doc.getElementById("selection-area-close") as HTMLButtonElement;
        }

        let currentSelection = "";
        let warningMessageState: { shouldShow: boolean, messageElement: HTMLElement | null } = { shouldShow: false, messageElement: null };

        // Clear selection function
        const clearSelection = () => {
            // Clear PDF reader selection
            clearPDFSelection();
            // Clear local selection state
            currentSelection = "";
            if (selectionArea) selectionArea.style.display = "none";
        };

        if (selectionArea) {
            // Keep the click on the area itself for backward compatibility
            selectionArea.onclick = (e) => {
                // Don't clear if clicking the close button (it has its own handler) - COMMENTED OUT
                // const closeButton = doc.getElementById("selection-area-close") as HTMLButtonElement;
                // if (closeButton && e.target !== closeButton && !closeButton.contains(e.target as Node)) {
                clearSelection();
                // }
            };
        }

        // Close button click handler - COMMENTED OUT
        // const closeButton = doc.getElementById("selection-area-close") as HTMLButtonElement;
        // if (closeButton) {
        //     closeButton.onclick = (e) => {
        //         e.stopPropagation(); // Prevent triggering selectionArea.onclick
        //         clearSelection();
        //     };
        // }

        // Polling for selection using getSelectedText helper
        // Note: item is already normalized at this point (attachment -> parent item)
        const checkSelection = async () => {
            const text = getSelectedText();

            // Get the title and item ID of the PDF that contains the selected text
            // Only check if there's actually selected text
            let selectedTextTitle: string | null = null;
            let selectedTextItemID: number | null = null;
            if (text && text.trim()) {
                try {
                    const win = Zotero.getMainWindow();
                    if (win && win.Zotero_Tabs) {
                        const selectedTabID = win.Zotero_Tabs.selectedID;
                        const reader = win.Zotero.Reader.getByTabID(selectedTabID);
                        if (reader && reader.itemID) {
                            const readerItem = Zotero.Items.get(reader.itemID);
                            if (readerItem) {
                                // Get the top-level item (parent if attachment)
                                const topLevelID = getTopLevelItemID(readerItem);
                                const topLevelItem = Zotero.Items.get(topLevelID);
                                if (topLevelItem) {
                                    selectedTextTitle = topLevelItem.getField('title') || null;
                                    selectedTextItemID = topLevelID;
                                } else {
                                    Zotero.debug(`[AI for Science] checkSelection: Could not get topLevelItem for ID ${topLevelID}`);
                                }
                            } else {
                                Zotero.debug(`[AI for Science] checkSelection: Could not get readerItem for ID ${reader.itemID}`);
                            }
                        } else {
                            // No reader or no itemID - selected text might be from a different source
                            // Don't show warning if we can't determine the source
                            selectedTextTitle = null;
                            selectedTextItemID = null;
                        }
                    }
                } catch (e) {
                    Zotero.debug(`[AI for Science] Error getting selected text title: ${e}`);
                }
            }

            // Get the title of the current conversation item
            // Read from win.currentItemID instead of closure's item to always use the latest item
            // @ts-ignore
            const currentItemID = win.currentItemID;
            const currentItem = currentItemID ? Zotero.Items.get(currentItemID) : null;
            const currentItemTitle = currentItem ? (currentItem.getField('title') || null) : null;

            // Check if we're in paper group mode and if selected text belongs to the group
            let isSelectedTextInGroup = false;
            if (currentPaperGroupID && selectedTextItemID !== null) {
                try {
                    const group = await getPaperGroup(currentPaperGroupID);
                    if (group && group.itemIDs.includes(selectedTextItemID)) {
                        isSelectedTextInGroup = true;
                    }
                } catch (e) {
                    Zotero.debug(`[AI for Science] Error checking if selected text is in group: ${e}`);
                }
            }

            // Determine if warning should be shown
            // Only show warning if:
            // 1. There is selected text (non-empty)
            // 2. We can determine the title of the selected text's PDF
            // 3. We have a current item title
            // 4. The titles are different (case-insensitive comparison)
            // 5. AND we're NOT in paper group mode OR the selected text is NOT in the group
            const hasText = Boolean(text && text.trim());
            const hasSelectedTitle = selectedTextTitle !== null && selectedTextTitle.trim() !== '';
            const hasCurrentTitle = currentItemTitle !== null && currentItemTitle.trim() !== '';

            // Compare titles (case-insensitive, trim whitespace)
            const selectedTitleNormalized = hasSelectedTitle ? selectedTextTitle!.trim().toLowerCase() : '';
            const currentTitleNormalized = hasCurrentTitle ? currentItemTitle!.trim().toLowerCase() : '';
            const titlesMatch = hasSelectedTitle && hasCurrentTitle && selectedTitleNormalized === currentTitleNormalized;

            // Only show warning if we have both titles and they don't match
            // If we can't determine the selected text's title, don't show warning (to avoid false positives)
            // In paper group mode, don't show warning if selected text belongs to any paper in the group
            const shouldShowWarning = hasText && hasSelectedTitle && hasCurrentTitle && !titlesMatch && !isSelectedTextInGroup;

            // Debug logging when there's text selected (only log when state might change or when debugging)
            if (hasText && (shouldShowWarning !== warningMessageState.shouldShow)) {
                Zotero.debug(`[AI for Science] checkSelection: hasText=${hasText}, selectedTextTitle="${selectedTextTitle}", currentItemTitle="${currentItemTitle}", selectedTitleNormalized="${selectedTitleNormalized}", currentTitleNormalized="${currentTitleNormalized}", titlesMatch=${titlesMatch}, isSelectedTextInGroup=${isSelectedTextInGroup}, currentPaperGroupID=${currentPaperGroupID || 'null'}, shouldShowWarning=${shouldShowWarning}, readerTabID=${win?.Zotero_Tabs?.selectedID || 'N/A'}`);
            }

            // Only update warning message if state changed
            if (shouldShowWarning !== warningMessageState.shouldShow) {
                warningMessageState.shouldShow = shouldShowWarning;

                if (shouldShowWarning) {
                    // Need to show warning - check if overlay already exists
                    let existingOverlay = doc.getElementById("selection-warning-overlay") as HTMLElement | null;
                    if (existingOverlay) {
                        // Overlay already exists, just show it
                        existingOverlay.style.display = "flex";
                        warningMessageState.messageElement = existingOverlay;
                    } else {
                        // Create overlay and modal dialog (same style as history dialog)
                        // Cover the entire AI chat window
                        const overlay = doc.createElement("div");
                        overlay.id = "selection-warning-overlay";
                        overlay.style.cssText = `
                            position: fixed;
                            top: 0;
                            left: 0;
                            right: 0;
                            bottom: 0;
                            background-color: rgba(0, 0, 0, 0.5);
                            z-index: 10000;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                        `;

                        // Create dialog container (same style as history dialog)
                        const dialog = doc.createElement("div");
                        dialog.style.cssText = `
                            background: white;
                            border-radius: 8px;
                            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
                            width: 400px;
                            display: flex;
                            flex-direction: column;
                        `;

                        // Dialog header (same style as history dialog)
                        const header = doc.createElement("div");
                        header.style.cssText = `
                            padding: 16px 20px;
                            border-bottom: 1px solid #eee;
                            display: flex;
                            justify-content: space-between;
                            align-items: center;
                        `;
                        const title = doc.createElement("h3");
                        title.textContent = "提示";
                        title.style.cssText = "margin: 0; font-size: 16px; font-weight: 600;";
                        const closeBtn = doc.createElement("button");
                        closeBtn.textContent = "×";
                        closeBtn.style.cssText = `
                            background: none;
                            border: none;
                            font-size: 24px;
                            cursor: pointer;
                            color: #666;
                            padding: 0;
                            width: 30px;
                            height: 30px;
                        `;
                        closeBtn.onclick = () => overlay.remove();
                        header.appendChild(title);
                        header.appendChild(closeBtn);

                        // Dialog content
                        const content = doc.createElement("div");
                        content.style.cssText = `
                            padding: 20px;
                        `;
                        const message = doc.createElement("div");
                        message.textContent = "当前在PDF中选中的文本属于另一篇文章，请在上方文章列表切换。";
                        message.style.cssText = "font-size: 14px; color: #333; line-height: 1.6;";
                        content.appendChild(message);

                        dialog.appendChild(header);
                        dialog.appendChild(content);
                        overlay.appendChild(dialog);

                        // Close on overlay click (outside dialog)
                        overlay.onclick = (e) => {
                            if (e.target === overlay) {
                                overlay.remove();
                            }
                        };

                        if (doc.body) {
                            doc.body.appendChild(overlay);
                        }
                        warningMessageState.messageElement = overlay;
                    }
                } else {
                    // Need to hide warning - hide overlay
                    const overlay = doc.getElementById("selection-warning-overlay") as HTMLElement | null;
                    if (overlay) {
                        overlay.style.display = "none";
                    }
                    if (warningMessageState.messageElement && warningMessageState.messageElement.isConnected) {
                        warningMessageState.messageElement.style.display = "none";
                    }
                    warningMessageState.messageElement = null;
                }
            }

            if (text && text !== currentSelection) {
                currentSelection = text;
                if (selectionArea && selectionContent) {
                    selectionArea.style.display = "flex";
                    selectionArea.style.alignItems = "center";
                    // Show full text (CSS handles ellipsis)
                    const cleanText = text.replace(/\s+/g, " ");
                    selectionContent.textContent = "Selected: " + cleanText;
                    selectionArea.title = "Selected text: " + text;
                }
            } else if (!text && currentSelection) {
                currentSelection = "";
                if (selectionArea) selectionArea.style.display = "none";
            }
        };

        const intervalId = win.setInterval(checkSelection, 1000);
        // Store interval ID on window so we can clear it when re-initializing
        // @ts-ignore
        win.checkSelectionIntervalId = intervalId;
        win.addEventListener("unload", () => {
            win.clearInterval(intervalId);
            // @ts-ignore
            win.checkSelectionIntervalId = null;
            // Clean up warning overlay if exists
            const overlay = doc.getElementById("selection-warning-overlay");
            if (overlay) {
                overlay.remove();
            }
        });

        // Setup "段落解释" button functionality
        const explainBtn = doc.getElementById("explain-selection-btn") as HTMLButtonElement | null;
        if (explainBtn) {
            // Override the explainSelection function to access currentSelection
            (win as any).explainSelection = () => {
                if (currentSelection && currentSelection.trim()) {
                    // If there's selected text, put the prompt in input box (user can edit before sending)
                    input.value = "这一段讲了什么";
                    input.focus();
                } else {
                    // If no selection, prompt user to select text first
                    input.value = "这一段讲了什么";
                    input.focus();
                    // Show a brief message
                    addMessage(messagesArea, "System", "请先在PDF阅读器中选中要解释的文字段落。", "system");
                }
            };
        }

        // Get current mode (ask or agent)
        const getCurrentMode = (): "ask" | "agent" => {
            const modeSelector = doc.getElementById("mode-selector") as any;
            return modeSelector?.value === "agent" ? "agent" : "ask";
        };

        // Model Selector Logic
        const prefsPrefix = addon.data.config.prefsPrefix;
        const providers = ["OpenAI", "DeepSeek", "Gemini", "Custom"];

        // Function to get configured model name for a provider
        const getModelForProvider = (provider: string): string => {
            const keyMap: { [key: string]: string } = {
                "OpenAI": "openaiModel",
                "DeepSeek": "deepseekModel",
                "Gemini": "geminiModel",
                "Custom": "customModel"
            };
            const key = keyMap[provider];
            return (Zotero.Prefs.get(`${prefsPrefix}.${key}`) as string) || "";
        };

        // Helper function to fetch available models from API
        const fetchAvailableModels = async (provider: string): Promise<string[]> => {
            const prefsPrefix = addon.data.config.prefsPrefix;
            let baseUrl = "";
            let apiKey = "";

            try {
                if (provider === "OpenAI") {
                    baseUrl = Zotero.Prefs.get(`${prefsPrefix}.openaiBaseUrl`) as string || "https://api.openai.com/v1";
                    apiKey = Zotero.Prefs.get(`${prefsPrefix}.openaiApiKey`) as string;
                } else if (provider === "DeepSeek") {
                    baseUrl = Zotero.Prefs.get(`${prefsPrefix}.deepseekBaseUrl`) as string || "https://api.deepseek.com/v1";
                    apiKey = Zotero.Prefs.get(`${prefsPrefix}.deepseekApiKey`) as string;
                } else if (provider === "Gemini") {
                    // Gemini uses a different API structure, try to get models list
                    apiKey = Zotero.Prefs.get(`${prefsPrefix}.geminiApiKey`) as string;
                    if (!apiKey) return [];

                    // Try Gemini's models endpoint (may not be available)
                    const geminiBaseUrl = "https://generativelanguage.googleapis.com/v1beta";
                    const endpoint = `${geminiBaseUrl}/models?key=${apiKey}`;
                    try {
                        const response = await Zotero.HTTP.request("GET", endpoint, {
                            headers: {
                                "Content-Type": "application/json"
                            },
                            responseType: "json",
                            timeout: 10000
                        });

                        if (response.status === 200 && response.response && response.response.models) {
                            return response.response.models.map((m: any) => m.name?.split("/").pop() || m.name || "").filter((id: string) => id);
                        }
                    } catch (e) {
                        // Gemini models endpoint may not be available, return empty
                        Zotero.debug(`[Model Selector] Gemini models endpoint not available: ${e}`);
                        return [];
                    }
                    return [];
                } else if (provider === "Claude") {
                    baseUrl = Zotero.Prefs.get(`${prefsPrefix}.claudeBaseUrl`) as string || "https://api.anthropic.com/v1";
                    apiKey = Zotero.Prefs.get(`${prefsPrefix}.claudeApiKey`) as string;
                    // Claude doesn't have a standard /v1/models endpoint, return empty to use predefined models
                    return [];
                } else if (provider === "Custom") {
                    baseUrl = Zotero.Prefs.get(`${prefsPrefix}.customBaseUrl`) as string;
                    apiKey = Zotero.Prefs.get(`${prefsPrefix}.customApiKey`) as string;
                } else {
                    return [];
                }

                // For OpenAI, DeepSeek, and Custom providers, use OpenAI-compatible /v1/models endpoint
                if (provider === "OpenAI" || provider === "DeepSeek" || provider === "Custom") {
                    if (!apiKey || !baseUrl) {
                        return [];
                    }

                    // Try to fetch models from /v1/models endpoint (OpenAI compatible)
                    const endpoint = `${baseUrl}/models`.replace(/([^:]\/)\/+/g, "$1");
                    const response = await Zotero.HTTP.request("GET", endpoint, {
                        headers: {
                            "Authorization": `Bearer ${apiKey}`,
                            "Content-Type": "application/json"
                        },
                        responseType: "json",
                        timeout: 10000 // 10 second timeout
                    });

                    if (response.status === 200 && response.response && response.response.data) {
                        return response.response.data.map((m: any) => m.id || m.model || "").filter((id: string) => id);
                    }
                }
            } catch (e) {
                Zotero.debug(`[Model Selector] Failed to fetch models for ${provider}: ${e}`);
            }

            return [];
        };

        const createModelSelector = () => {
            // --- 1. Custom Dropdown Wrapper ---
            const modeSelector = doc.createElement("div") as any;
            modeSelector.id = "model-selector-custom";
            modeSelector.style.position = "relative";
            modeSelector.style.display = "inline-block";
            modeSelector.style.minWidth = "100px"; // Compact

            // --- 2. State & Data ---
            const prefsPrefix = addon.data.config.prefsPrefix;

            // Cache for available models from API
            const availableModelsCache: { [provider: string]: string[] } = {};

            // Helper function to check if a provider is configured
            const isProviderConfigured = (provider: string): boolean => {
                switch (provider) {
                    case "OpenAI":
                        const openaiApiKey = Zotero.Prefs.get(`${prefsPrefix}.openaiApiKey`) as string;
                        return !!openaiApiKey && openaiApiKey.trim() !== "";
                    case "DeepSeek":
                        const deepseekApiKey = Zotero.Prefs.get(`${prefsPrefix}.deepseekApiKey`) as string;
                        return !!deepseekApiKey && deepseekApiKey.trim() !== "";
                    case "Gemini":
                        const geminiApiKey = Zotero.Prefs.get(`${prefsPrefix}.geminiApiKey`) as string;
                        return !!geminiApiKey && geminiApiKey.trim() !== "";
                    case "Claude":
                        const claudeApiKey = Zotero.Prefs.get(`${prefsPrefix}.claudeApiKey`) as string;
                        const claudeBaseUrl = Zotero.Prefs.get(`${prefsPrefix}.claudeBaseUrl`) as string;
                        return !!(claudeApiKey && claudeApiKey.trim() !== "" && claudeBaseUrl && claudeBaseUrl.trim() !== "");
                    case "Custom":
                        const customApiKey = Zotero.Prefs.get(`${prefsPrefix}.customApiKey`) as string;
                        const customBaseUrl = Zotero.Prefs.get(`${prefsPrefix}.customBaseUrl`) as string;
                        return !!(customApiKey && customApiKey.trim() !== "" && customBaseUrl && customBaseUrl.trim() !== "");
                    default:
                        return false;
                }
            };

            // Helper function to check if a specific model is available/configured
            const isModelAvailable = (provider: string, model: string, availableModels?: string[]): boolean => {
                // First check if provider is configured
                if (!isProviderConfigured(provider)) {
                    return false;
                }

                // For Custom provider, check if model matches configured customModel
                if (provider === "Custom") {
                    const customModel = Zotero.Prefs.get(`${prefsPrefix}.customModel`) as string;
                    // If customModel is "custom" or empty, show all Custom models (user can configure any)
                    if (customModel === "custom" || !customModel || customModel.trim() === "") {
                        return true; // Allow all custom models if generic custom is set
                    }
                    // Otherwise, only show the exact model that's configured
                    return model === customModel;
                }

                // For Gemini and Claude, show all models if API Key is configured
                if (provider === "Gemini" || provider === "Claude") {
                    return true;
                }

                // For OpenAI and DeepSeek, if we have available models from API, filter by them
                if ((provider === "OpenAI" || provider === "DeepSeek") && availableModels && availableModels.length > 0) {
                    return availableModels.includes(model);
                }

                // Default: show all models if provider is configured (fallback if API fetch fails or not yet fetched)
                return true;
            };

            // Define available models
            const allModelOptions = [
                // OpenAI 系列
                { provider: "OpenAI", model: "gpt-5.1", label: "GPT-5.1" },
                { provider: "OpenAI", model: "gpt-4o", label: "GPT-4o" },
                { provider: "OpenAI", model: "gpt-4o-mini", label: "GPT-4o Mini" },
                { provider: "OpenAI", model: "o3-mini", label: "o3-mini" },
                { provider: "OpenAI", model: "o3", label: "o3" },
                { provider: "OpenAI", model: "o1-mini", label: "o1-mini" },
                { provider: "OpenAI", model: "o1-preview", label: "o1-preview" },
                { provider: "OpenAI", model: "gpt-4-turbo", label: "GPT-4 Turbo" },
                // DeepSeek 系列
                { provider: "DeepSeek", model: "deepseek-v3", label: "DeepSeek-V3" },
                { provider: "DeepSeek", model: "deepseek-r1", label: "DeepSeek-R1" },
                { provider: "DeepSeek", model: "deepseek-chat", label: "DeepSeek Chat" },
                { provider: "DeepSeek", model: "deepseek-reasoner", label: "DeepSeek Reasoner" },
                { provider: "DeepSeek", model: "deepseek-coder", label: "DeepSeek Coder" },
                // Gemini 系列
                { provider: "Gemini", model: "gemini-3", label: "Gemini 3" },
                { provider: "Gemini", model: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
                { provider: "Gemini", model: "gemini-1.5-flash", label: "Gemini 1.5 Flash" },
                // Claude 系列
                { provider: "Claude", model: "claude-3-7-sonnet-20250219", label: "Claude 3.7 Sonnet" },
                { provider: "Claude", model: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet" },
                { provider: "Claude", model: "claude-3-opus-20240229", label: "Claude 3 Opus" },
                { provider: "Claude", model: "claude-3-sonnet-20240229", label: "Claude 3 Sonnet" },
                { provider: "Claude", model: "claude-3-haiku-20240307", label: "Claude 3 Haiku" },
                // 国产大模型 (通过 Custom provider)
                { provider: "Custom", model: "kimi-k2", label: "Kimi K2" },
                { provider: "Custom", model: "glm-4.6", label: "GLM-4.6" },
                { provider: "Custom", model: "doubao-pro", label: "豆包 Pro" },
                { provider: "Custom", model: "doubao-lite", label: "豆包 Lite" },
                // 通用自定义模型
                { provider: "Custom", model: "custom", label: "Custom Model" }
            ];

            // Helper function to format model name for display
            const formatModelLabel = (modelId: string): string => {
                // Convert model ID to readable label
                // e.g., "deepseek-chat" -> "DeepSeek Chat", "gpt-4o" -> "GPT-4o"
                return modelId
                    .split("-")
                    .map((word, index) => {
                        // Keep common abbreviations uppercase
                        if (word === "gpt" || word === "api" || word === "v1" || word === "v2" || word === "v3") {
                            return word.toUpperCase();
                        }
                        // Capitalize first letter
                        return word.charAt(0).toUpperCase() + word.slice(1);
                    })
                    .join(" ");
            };

            // Function to filter and update model options based on available models from API
            // Only show up to 3 models: the configured model + 2 others
            const getFilteredModelOptions = (availableModels?: { [provider: string]: string[] }) => {
                const filtered: any[] = [];
                const addedModels = new Set<string>(); // Track added models to avoid duplicates

                // Get current configured model
                const currentProvider = Zotero.Prefs.get(`${prefsPrefix}.provider`) as string;
                let currentModelOption: any = null;

                // Find the currently configured model
                if (currentProvider === "Custom") {
                    const customModel = Zotero.Prefs.get(`${prefsPrefix}.customModel`) as string;
                    if (customModel) {
                        currentModelOption = allModelOptions.find(o => o.provider === "Custom" && o.model === customModel);
                        if (!currentModelOption && isProviderConfigured("Custom")) {
                            currentModelOption = {
                                provider: "Custom",
                                model: customModel,
                                label: customModel || "Custom Model"
                            };
                        }
                    }
                } else {
                    const keyMap: { [key: string]: string } = {
                        "OpenAI": "openaiModel",
                        "DeepSeek": "deepseekModel",
                        "Gemini": "geminiModel",
                        "Claude": "claudeModel"
                    };
                    const modelKey = keyMap[currentProvider];
                    if (modelKey) {
                        const currentModel = Zotero.Prefs.get(`${prefsPrefix}.${modelKey}`) as string;
                        if (currentModel) {
                            currentModelOption = allModelOptions.find(o => o.provider === currentProvider && o.model === currentModel);
                            if (!currentModelOption && isProviderConfigured(currentProvider)) {
                                currentModelOption = {
                                    provider: currentProvider,
                                    model: currentModel,
                                    label: formatModelLabel(currentModel)
                                };
                            }
                        }
                    }
                }

                // 1. Add the currently configured model first (if available)
                if (currentModelOption) {
                    const providerModels = availableModels?.[currentModelOption.provider];
                    if (isModelAvailable(currentModelOption.provider, currentModelOption.model, providerModels)) {
                        filtered.push(currentModelOption);
                        addedModels.add(`${currentModelOption.provider}:${currentModelOption.model}`);
                    }
                }

                // 2. Add up to 2 more models from the same provider (if configured)
                if (currentProvider && isProviderConfigured(currentProvider) && filtered.length < 3) {
                    const providerModels = availableModels?.[currentProvider];

                    // First try predefined models for this provider
                    for (const opt of allModelOptions) {
                        if (filtered.length >= 3) break;
                        if (opt.provider === currentProvider && !addedModels.has(`${opt.provider}:${opt.model}`)) {
                            if (isModelAvailable(opt.provider, opt.model, providerModels)) {
                                filtered.push(opt);
                                addedModels.add(`${opt.provider}:${opt.model}`);
                            }
                        }
                    }

                    // If still need more models and have API models, add them
                    if (filtered.length < 3 && providerModels && providerModels.length > 0) {
                        for (const modelId of providerModels) {
                            if (filtered.length >= 3) break;
                            const modelKey = `${currentProvider}:${modelId}`;
                            if (!addedModels.has(modelKey)) {
                                filtered.push({
                                    provider: currentProvider,
                                    model: modelId,
                                    label: formatModelLabel(modelId)
                                });
                                addedModels.add(modelKey);
                            }
                        }
                    }
                }

                // If we still don't have 3 models and no provider is configured, show first available
                if (filtered.length === 0) {
                    for (const opt of allModelOptions) {
                        if (filtered.length >= 3) break;
                        if (isModelAvailable(opt.provider, opt.model, availableModels?.[opt.provider])) {
                            filtered.push(opt);
                            addedModels.add(`${opt.provider}:${opt.model}`);
                        }
                    }
                }

                // Sort by provider, then by label for better UX
                filtered.sort((a, b) => {
                    if (a.provider !== b.provider) {
                        const providerOrder = ["OpenAI", "DeepSeek", "Gemini", "Claude", "Custom"];
                        return providerOrder.indexOf(a.provider) - providerOrder.indexOf(b.provider);
                    }
                    return a.label.localeCompare(b.label);
                });

                // Limit to maximum 3 models
                return filtered.slice(0, 3);
            };

            // Initially filter models (will update when API results come in)
            let modelOptions = getFilteredModelOptions(availableModelsCache);

            // Fetch models in background (will be called after optionsList is created)

            // Get current state
            let currentProvider = Zotero.Prefs.get(`${prefsPrefix}.provider`) as string;

            // Determine current label
            let currentLabel = "未配置模型"; // Default fallback
            let currentModel = "";

            // If no models are configured, show default message
            if (modelOptions.length === 0) {
                currentLabel = "请配置模型";
            } else {
                // Try to match current provider + model to our list
                if (currentProvider === "Custom") {
                    const customModel = Zotero.Prefs.get(`${prefsPrefix}.customModel`) as string;
                    const match = modelOptions.find(o => o.provider === "Custom" && o.model === customModel);
                    if (match) {
                        currentLabel = match.label;
                    } else if (isProviderConfigured("Custom")) {
                        // If Custom is configured but model not in list, show model name
                        currentLabel = customModel || "Custom Model";
                    } else {
                        // If current provider is not configured, use first available model
                        currentLabel = modelOptions[0].label;
                    }
                } else {
                    // Get the model for this provider
                    const keyMap: { [key: string]: string } = {
                        "OpenAI": "openaiModel",
                        "DeepSeek": "deepseekModel",
                        "Gemini": "geminiModel",
                        "Claude": "claudeModel"
                    };
                    const modelKey = keyMap[currentProvider];
                    if (modelKey) {
                        currentModel = Zotero.Prefs.get(`${prefsPrefix}.${modelKey}`) as string;
                        const match = modelOptions.find(o => o.provider === currentProvider && o.model === currentModel);
                        if (match) {
                            currentLabel = match.label;
                        } else if (isProviderConfigured(currentProvider)) {
                            // If provider is configured but model not in list, show model name
                            currentLabel = currentModel || currentProvider;
                        } else {
                            // If current provider is not configured, use first available model
                            currentLabel = modelOptions[0].label;
                        }
                    }
                }
            }

            // --- 3. Trigger Button ---
            const trigger = doc.createElement("div");
            trigger.style.padding = "8px 12px";
            trigger.style.border = "1px solid #d0d0d0";
            trigger.style.borderRadius = "6px";
            trigger.style.backgroundColor = "#ffffff";
            trigger.style.cursor = "pointer";
            trigger.style.display = "flex";
            trigger.style.alignItems = "center";
            trigger.style.justifyContent = "space-between";
            trigger.style.fontSize = "13px";
            trigger.style.color = "#444";
            trigger.style.fontWeight = "600";
            trigger.style.boxShadow = "0 1px 2px rgba(0,0,0,0.05)";
            trigger.style.transition = "all 0.2s ease";
            trigger.style.userSelect = "none";

            const triggerLabel = doc.createElement("span");
            triggerLabel.textContent = currentLabel;
            triggerLabel.style.whiteSpace = "nowrap";
            triggerLabel.style.overflow = "hidden";
            triggerLabel.style.textOverflow = "ellipsis";
            triggerLabel.style.maxWidth = "110px";

            const triggerArrow = doc.createElement("span");
            triggerArrow.innerHTML = `<svg width="10" height="10" viewBox="0 0 12 12" style="display:block; opacity:0.6;"><path fill="currentColor" d="M6 8.5L2 4.5h8z"/></svg>`;
            triggerArrow.style.marginLeft = "6px";

            trigger.appendChild(triggerLabel);
            trigger.appendChild(triggerArrow);
            modeSelector.appendChild(trigger);

            // --- 4. Options List ---
            const optionsList = doc.createElement("div");
            optionsList.style.position = "absolute";
            optionsList.style.top = "calc(100% + 4px)";
            optionsList.style.left = "0";
            optionsList.style.width = "100%"; // Match trigger width exactly as requested
            optionsList.style.backgroundColor = "#ffffff";
            optionsList.style.border = "1px solid #d0d0d0";
            optionsList.style.borderRadius = "6px";
            optionsList.style.boxShadow = "0 4px 16px rgba(0,0,0,0.12)";
            optionsList.style.zIndex = "9999";
            optionsList.style.display = "none";
            // Limit height to stay within window, use scrollbar for overflow
            optionsList.style.overflowY = "auto";
            optionsList.style.overflowX = "hidden"; // Prevent horizontal scroll


            // Helper to update selection
            const updateSelection = (opt: any) => {
                currentProvider = opt.provider;
                triggerLabel.textContent = opt.label;
                optionsList.style.display = "none";
                trigger.style.borderColor = "#d0d0d0";
                trigger.style.boxShadow = "0 1px 2px rgba(0,0,0,0.05)";

                // 1. Set Provider
                Zotero.Prefs.set(`${prefsPrefix}.provider`, opt.provider);

                // 2. Set Model (if not custom generic)
                if (opt.provider === "Custom") {
                    // If it's a specific custom model preset (like Claude), set it
                    if (opt.model && opt.model !== "custom") {
                        Zotero.Prefs.set(`${prefsPrefix}.customModel`, opt.model);
                    }
                } else {
                    const keyMap: { [key: string]: string } = {
                        "OpenAI": "openaiModel",
                        "DeepSeek": "deepseekModel",
                        "Gemini": "geminiModel",
                        "Claude": "claudeModel"
                    };
                    const modelKey = keyMap[opt.provider];
                    if (modelKey && opt.model) {
                        Zotero.Prefs.set(`${prefsPrefix}.${modelKey}`, opt.model);
                    }
                }
            };

            // Render Options
            if (modelOptions.length === 0) {
                const item = doc.createElement("div");
                item.style.padding = "8px 12px";
                item.style.fontSize = "12px";
                item.style.color = "#999";
                item.style.textAlign = "center";
                item.style.fontStyle = "italic";
                item.textContent = "请在偏好设置中配置模型";
                optionsList.appendChild(item);
            } else {
                modelOptions.forEach(opt => {
                    const item = doc.createElement("div");
                    item.style.padding = "8px 12px";
                    item.style.fontSize = "13px";
                    item.style.color = "#333";
                    item.style.cursor = "pointer";
                    item.style.borderBottom = "1px solid #f5f5f5";
                    item.style.display = "flex";
                    item.style.justifyContent = "space-between";
                    item.style.alignItems = "center";

                    const name = doc.createElement("span");
                    name.textContent = opt.label;
                    name.style.fontWeight = "500";

                    // Removed provider tag as requested

                    item.appendChild(name);

                    item.onmouseenter = () => item.style.backgroundColor = "#f5f5f5";
                    item.onmouseleave = () => item.style.backgroundColor = "#ffffff";
                    item.onclick = (e) => {
                        e.stopPropagation();
                        updateSelection(opt);
                    };

                    optionsList.appendChild(item);
                });
            }

            modeSelector.appendChild(optionsList);

            // Function to update the options list UI (defined after optionsList is created)
            const updateModelOptionsList = () => {
                // Re-filter models with latest cache
                modelOptions = getFilteredModelOptions(availableModelsCache);

                // Clear existing options
                optionsList.innerHTML = "";

                // Re-render options
                if (modelOptions.length === 0) {
                    const item = doc.createElement("div");
                    item.style.padding = "8px 12px";
                    item.style.fontSize = "12px";
                    item.style.color = "#999";
                    item.style.textAlign = "center";
                    item.style.fontStyle = "italic";
                    item.textContent = "请在偏好设置中配置模型";
                    optionsList.appendChild(item);
                } else {
                    modelOptions.forEach(opt => {
                        const item = doc.createElement("div");
                        item.style.padding = "8px 12px";
                        item.style.fontSize = "13px";
                        item.style.color = "#333";
                        item.style.cursor = "pointer";
                        item.style.borderBottom = "1px solid #f5f5f5";
                        item.style.display = "flex";
                        item.style.justifyContent = "space-between";
                        item.style.alignItems = "center";

                        const name = doc.createElement("span");
                        name.textContent = opt.label;
                        name.style.fontWeight = "500";

                        item.appendChild(name);

                        item.onmouseenter = () => item.style.backgroundColor = "#f5f5f5";
                        item.onmouseleave = () => item.style.backgroundColor = "#ffffff";
                        item.onclick = (e) => {
                            e.stopPropagation();
                            updateSelection(opt);
                        };

                        optionsList.appendChild(item);
                    });
                }
            };

            // Try to fetch available models from API for configured providers
            // Only fetch for the current provider to limit API calls
            const fetchModelsForProviders = async () => {
                const currentProvider = Zotero.Prefs.get(`${prefsPrefix}.provider`) as string;
                if (currentProvider && isProviderConfigured(currentProvider)) {
                    try {
                        const models = await fetchAvailableModels(currentProvider);
                        if (models.length > 0) {
                            // Only store models for the current provider
                            availableModelsCache[currentProvider] = models;
                            Zotero.debug(`[Model Selector] Fetched ${models.length} models for ${currentProvider}: ${models.join(", ")}`);
                            // Update UI with fetched models (will be limited to 3 in getFilteredModelOptions)
                            updateModelOptionsList();
                        } else {
                            // If API fetch returns empty but provider is configured, 
                            // it means API doesn't support model listing or fetch failed
                            // We'll fall back to showing predefined models
                            Zotero.debug(`[Model Selector] No models fetched for ${currentProvider}, using predefined models`);
                        }
                    } catch (e) {
                        Zotero.debug(`[Model Selector] Failed to fetch models for ${currentProvider}: ${e}`);
                        // On error, we'll still show predefined models as fallback
                    }
                }
            };

            // Fetch models in background (don't block UI)
            fetchModelsForProviders();

            // --- 5. Toggle Logic ---
            trigger.onclick = (e) => {
                e.stopPropagation();
                const isVisible = optionsList.style.display === "block";
                if (!isVisible) {
                    // Calculate max height to stay within window
                    const triggerRect = trigger.getBoundingClientRect();
                    const windowHeight = win.innerHeight || (doc.documentElement ? doc.documentElement.clientHeight : 0);
                    const spaceBelow = windowHeight - triggerRect.bottom - 8; // 8px for gap
                    const maxHeight = Math.min(150, Math.max(100, spaceBelow)); // At least 100px, max 150px
                    optionsList.style.maxHeight = `${maxHeight}px`;
                    optionsList.style.display = "block";
                    trigger.style.borderColor = "#007bff";
                    trigger.style.boxShadow = "0 0 0 2px rgba(0,123,255,0.1)";
                } else {
                    optionsList.style.display = "none";
                    trigger.style.borderColor = "#d0d0d0";
                    trigger.style.boxShadow = "0 1px 2px rgba(0,0,0,0.05)";
                }
            };

            // --- 6. Close on Outside Click ---
            const closeHandler = (e: Event) => {
                if (!modeSelector.isConnected) {
                    win.removeEventListener("click", closeHandler);
                    return;
                }
                if (!modeSelector.contains(e.target as Node)) {
                    optionsList.style.display = "none";
                    trigger.style.borderColor = "#d0d0d0";
                    trigger.style.boxShadow = "0 1px 2px rgba(0,0,0,0.05)";
                }
            };
            win.addEventListener("click", closeHandler);

            // --- 7. Hover Effects ---
            trigger.onmouseenter = () => {
                if (optionsList.style.display !== "block") trigger.style.borderColor = "#b0b0b0";
            };
            trigger.onmouseleave = () => {
                if (optionsList.style.display !== "block") trigger.style.borderColor = "#d0d0d0";
            };

            return modeSelector;
        };




        // Abort controller for stopping requests (polyfill for environments without AbortController)
        const AbortControllerCtor: any = (win as any).AbortController || (typeof AbortController !== "undefined" ? AbortController : null);
        const createAbortController = (): any => {
            if (AbortControllerCtor) return new AbortControllerCtor();
            // Minimal fallback to avoid ReferenceError and still support "aborted" checks
            return {
                aborted: false,
                signal: {
                    aborted: false,
                    onabort: null as any
                },
                abort() {
                    this.aborted = true;
                    this.signal.aborted = true;
                    if (typeof this.signal.onabort === "function") {
                        try { this.signal.onabort(); } catch { /* ignore */ }
                    }
                }
            };
        };
        let currentAbortController: any = null;
        let isStreaming = false;

        const handleSend = async () => {
            // If already streaming, treat button as "stop" regardless of input content
            if (isStreaming && currentAbortController) {
                currentAbortController.abort();
                // Keep controller instance so catch/finally can detect abort correctly
                sendBtn.textContent = "Send";
                sendBtn.disabled = true; // Prevent rapid double-clicks while abort propagates
                input.disabled = false;  // Let user resume typing immediately
                return;
            }

            const text = input.value.trim();
            if (!text) return;

            addMessage(messagesArea, "User", text, "user");
            input.value = "";
            input.disabled = true;
            sendBtn.disabled = false; // Keep enabled so user can click to stop
            sendBtn.textContent = "停止";
            isStreaming = true;

            // Create abort controller for this request
            currentAbortController = createAbortController();

            const mode = getCurrentMode();
            const aiMsg = addMessage(messagesArea, "AI", "", "ai");
            const contentDiv = aiMsg?.querySelector(".message-content") as HTMLElement;
            if (!contentDiv) {
                input.disabled = false;
                sendBtn.disabled = false;
                sendBtn.textContent = "Send";
                isStreaming = false;
                currentAbortController = null;
                return;
            }

            // Maintain a text buffer for streaming
            let streamBuffer = "";
            let updateTimer: any = null;
            let pendingUpdate = false;
            let finalRendered = false;

            try {
                // Check if paper group is selected
                let itemsToAnalyze: Zotero.Item[] = [];
                if (currentPaperGroupID) {
                    const group = await getPaperGroup(currentPaperGroupID);
                    if (group) {
                        for (const itemID of group.itemIDs) {
                            try {
                                const paperItem = Zotero.Items.get(itemID);
                                if (paperItem) {
                                    itemsToAnalyze.push(paperItem);
                                }
                            } catch (e) {
                                // Item might not exist, skip it
                            }
                        }
                    }
                } else if (item) {
                    itemsToAnalyze = [item];
                }

                if (itemsToAnalyze.length === 0) {
                    if (aiMsg && aiMsg.parentNode) messagesArea.removeChild(aiMsg);
                    addMessage(messagesArea, "System", "错误：没有选择论文或论文组。", "error");
                    return;
                }

                // Use streaming call with abort signal
                // For single paper, we can still use callLLMStreamForGroup (it handles both cases)
                await callLLMStreamForGroup(text, itemsToAnalyze, currentSelection, mode, (chunk: string) => {
                    if (!contentDiv) return;

                    // Add chunk to buffer regardless of abort state
                    if (chunk) {
                        streamBuffer += chunk;
                        pendingUpdate = true;
                    }

                    // Throttle updates to reduce flickering
                    if (!updateTimer) {
                        updateTimer = win.requestAnimationFrame(() => {
                            // Always try to update if we have pending data
                            if (finalRendered || !pendingUpdate || !contentDiv) {
                                updateTimer = null;
                                return;
                            }
                            if (pendingUpdate && contentDiv) {
                                // Check if we should auto-scroll (user is near bottom)
                                let shouldScroll = true;
                                if (messagesArea) {
                                    const threshold = 50; // pixels from bottom
                                    const distanceToBottom = messagesArea.scrollHeight - messagesArea.scrollTop - messagesArea.clientHeight;
                                    shouldScroll = distanceToBottom < threshold;
                                }

                                // Update content
                                try {
                                    if (streamBuffer) {
                                        renderAIContent(contentDiv, streamBuffer, false);
                                    }
                                } catch (e) {
                                    // If parsing fails, fallback to text content
                                    Zotero.debug("[AI for Science] Markdown parsing error: " + e);
                                    contentDiv.textContent = streamBuffer;
                                }

                                // Auto scroll
                                if (messagesArea && shouldScroll) {
                                    messagesArea.scrollTop = messagesArea.scrollHeight;
                                }

                                pendingUpdate = false;
                                updateTimer = null;
                            }
                        });
                    }
                }, currentAbortController?.signal);

                // Final update after streaming completes
                if (contentDiv && streamBuffer) {
                    if (updateTimer) {
                        win.cancelAnimationFrame(updateTimer);
                        updateTimer = null;
                    }
                    pendingUpdate = false;
                    finalRendered = true;
                    try {
                        renderAIContent(contentDiv, streamBuffer, true);
                        // Store original markdown text in data attribute for history saving
                        if (aiMsg) {
                            aiMsg.setAttribute("data-original-markdown", streamBuffer);
                        }
                    } catch (e) {
                        contentDiv.textContent = streamBuffer;
                        // Store original text even if markdown parsing fails
                        if (aiMsg) {
                            aiMsg.setAttribute("data-original-markdown", streamBuffer);
                        }
                    }
                    if (messagesArea) {
                        messagesArea.scrollTop = messagesArea.scrollHeight;
                    }
                }
            } catch (e: any) {
                if (currentAbortController?.signal.aborted) {
                    // Request was aborted by user
                    if (contentDiv) {
                        contentDiv.textContent = streamBuffer || "(已停止)";
                    }
                } else {
                    if (aiMsg && aiMsg.parentNode) messagesArea.removeChild(aiMsg);
                    addMessage(messagesArea, "System", "Error: " + e.message, "error");
                }
            } finally {
                input.disabled = false;
                sendBtn.disabled = false;
                sendBtn.textContent = "Send";
                isStreaming = false;
                currentAbortController = null;

                // Save chat history after each message exchange
                // Save for both single item conversations and group conversations
                if (currentConversationID && (currentConversationItemID || currentPaperGroupID)) {
                    const currentMessages: Array<{ sender: string, text: string, type: string }> = [];
                    const messageElements = messagesArea.querySelectorAll(".message");
                    messageElements.forEach((msgEl: Element) => {
                        const sender = msgEl.classList.contains("user") ? "User" :
                            msgEl.classList.contains("ai") ? "AI" : "System";
                        const contentEl = msgEl.querySelector(".message-content");
                        const type = msgEl.classList.contains("user") ? "user" :
                            msgEl.classList.contains("ai") ? "ai" :
                                msgEl.classList.contains("error") ? "error" : "system";

                        // For AI messages, try to get original markdown text from data attribute
                        // Otherwise fallback to textContent
                        let text = "";
                        if (type === "ai") {
                            // First try to get from data attribute (most reliable for markdown)
                            if (msgEl.hasAttribute("data-original-markdown")) {
                                text = msgEl.getAttribute("data-original-markdown") || "";
                                Zotero.debug(`[Chat] Saving AI message with original markdown from data attribute (length: ${text.length})`);
                            } else if (contentEl) {
                                // Fallback to textContent (may lose markdown formatting)
                                text = contentEl.textContent || "";
                                Zotero.debug(`[Chat] Saving AI message with textContent (no data-original-markdown attribute, length: ${text.length})`);
                            }
                        } else if (contentEl) {
                            text = contentEl.textContent || "";
                        }

                        // Only save user and AI messages, skip system messages
                        if (text && (type === "user" || type === "ai")) {
                            currentMessages.push({ sender, text, type });
                        }
                    });
                    if (currentMessages.length > 0) {
                        saveCurrentConversation(currentConversationItemID || undefined, currentConversationID, currentMessages, undefined, currentPaperGroupID || undefined).catch(e => {
                            Zotero.debug(`Error saving conversation: ${e}`);
                        });
                    }
                }
            }
        };

        // Fix: Use onclick and ensure it works. 
        // Sometimes addEventListener is better, but here we replace potentially old listeners if re-init.
        sendBtn.onclick = (e) => {
            e.preventDefault(); // Prevent default
            e.stopPropagation();
            handleSend();
        };

        input.onkeydown = (e) => {
            const keyboardEvent = e as unknown as KeyboardEvent;
            // Send on Enter without Shift
            if (keyboardEvent.key === 'Enter' && !keyboardEvent.shiftKey) {
                keyboardEvent.preventDefault();
                handleSend();
            }
        };

        // Remove existing mode selector container if it exists (to prevent duplicates on article switch)
        const existingModeContainer = doc.getElementById("mode-selector-container");
        if (existingModeContainer) {
            existingModeContainer.remove();
        }

        // Add mode selector
        const modeSelectorContainer = doc.createElement("div");
        modeSelectorContainer.id = "mode-selector-container";
        modeSelectorContainer.style.padding = "10px 15px";
        modeSelectorContainer.style.backgroundColor = "#fff";
        modeSelectorContainer.style.borderBottom = "1px solid #eee";
        modeSelectorContainer.style.display = "flex";
        modeSelectorContainer.style.alignItems = "center";
        modeSelectorContainer.style.justifyContent = "space-between";
        modeSelectorContainer.style.gap = "10px";

        const leftSection = doc.createElement("div");
        leftSection.style.display = "flex";
        leftSection.style.alignItems = "center";
        leftSection.style.gap = "10px";

        const modeLabel = doc.createElement("label");
        modeLabel.textContent = "模式:";
        modeLabel.style.fontSize = "13px";
        modeLabel.style.fontWeight = "500";
        modeLabel.style.color = "#666";

        // Custom Dropdown UI to replace native select
        const modeSelector = doc.createElement("div") as any;
        modeSelector.id = "mode-selector";
        modeSelector.style.position = "relative";
        modeSelector.style.display = "inline-block";
        modeSelector.style.minWidth = "160px";

        // Internal state
        let currentModeValue = "ask";

        // Trigger Button
        const trigger = doc.createElement("div");
        trigger.style.padding = "8px 12px";
        trigger.style.border = "1px solid #d0d0d0";
        trigger.style.borderRadius = "6px";
        trigger.style.backgroundColor = "#ffffff";
        trigger.style.cursor = "pointer";
        trigger.style.display = "flex";
        trigger.style.alignItems = "center";
        trigger.style.justifyContent = "space-between";
        trigger.style.fontSize = "13px";
        trigger.style.color = "#444";
        trigger.style.fontWeight = "600";
        trigger.style.boxShadow = "0 1px 2px rgba(0,0,0,0.05)";
        trigger.style.transition = "all 0.2s ease";
        trigger.style.userSelect = "none";

        const triggerLabel = doc.createElement("span");
        triggerLabel.textContent = "💬 Ask (问答模式)";

        const triggerArrow = doc.createElement("span");
        triggerArrow.innerHTML = `<svg width="10" height="10" viewBox="0 0 12 12" style="display:block; opacity:0.6;"><path fill="currentColor" d="M6 8.5L2 4.5h8z"/></svg>`;

        trigger.appendChild(triggerLabel);
        trigger.appendChild(triggerArrow);
        modeSelector.appendChild(trigger);

        // Options List
        const optionsList = doc.createElement("div");
        optionsList.style.position = "absolute";
        optionsList.style.top = "calc(100% + 4px)";
        optionsList.style.left = "0";
        optionsList.style.width = "100%";
        optionsList.style.backgroundColor = "#ffffff";
        optionsList.style.border = "1px solid #d0d0d0";
        optionsList.style.borderRadius = "6px";
        optionsList.style.boxShadow = "0 4px 16px rgba(0,0,0,0.12)";
        optionsList.style.zIndex = "9999";
        optionsList.style.display = "none";
        optionsList.style.overflow = "hidden";

        const options = [
            { value: "ask", label: "💬 Ask (问答模式)" },
            { value: "agent", label: "🤖 Agent (工具模式)" }
        ];

        const updateSelection = (value: string, dispatch: boolean = false) => {
            currentModeValue = value;
            const opt = options.find(o => o.value === value);
            if (opt) triggerLabel.textContent = opt.label;
            optionsList.style.display = "none";
            trigger.style.borderColor = "#d0d0d0";
            trigger.style.boxShadow = "0 1px 2px rgba(0,0,0,0.05)";

            if (dispatch && modeSelector.onchange) {
                // Mimic event object
                modeSelector.onchange({ target: { value: currentModeValue } });
            }
        };

        options.forEach(opt => {
            const item = doc.createElement("div");
            item.textContent = opt.label;
            item.style.padding = "8px 12px";
            item.style.fontSize = "13px";
            item.style.color = "#333";
            item.style.cursor = "pointer";
            item.style.transition = "background-color 0.1s";
            item.style.userSelect = "none";

            item.onmouseenter = () => item.style.backgroundColor = "#f5f5f5";
            item.onmouseleave = () => item.style.backgroundColor = "#ffffff";
            item.onclick = (e) => {
                e.stopPropagation();
                updateSelection(opt.value, true);
            };

            optionsList.appendChild(item);
        });

        modeSelector.appendChild(optionsList);

        // Toggle
        trigger.onclick = (e) => {
            e.stopPropagation();
            const isVisible = optionsList.style.display === "block";
            optionsList.style.display = isVisible ? "none" : "block";
            if (!isVisible) {
                trigger.style.borderColor = "#007bff";
                trigger.style.boxShadow = "0 0 0 2px rgba(0,123,255,0.1)";
            } else {
                trigger.style.borderColor = "#d0d0d0";
                trigger.style.boxShadow = "0 1px 2px rgba(0,0,0,0.05)";
            }
        };

        // Close on outside click
        const closeHandler = (e: Event) => {
            // If detached, remove listener (simple GC)
            if (!modeSelector.isConnected) {
                win.removeEventListener("click", closeHandler);
                return;
            }
            if (!modeSelector.contains(e.target as Node)) {
                optionsList.style.display = "none";
                trigger.style.borderColor = "#d0d0d0";
                trigger.style.boxShadow = "0 1px 2px rgba(0,0,0,0.05)";
            }
        };
        win.addEventListener("click", closeHandler);

        // Hover effects
        trigger.onmouseenter = () => {
            if (optionsList.style.display !== "block") trigger.style.borderColor = "#b0b0b0";
        };
        trigger.onmouseleave = () => {
            if (optionsList.style.display !== "block") trigger.style.borderColor = "#d0d0d0";
        };

        // Public property simulation
        Object.defineProperty(modeSelector, "value", {
            get: () => currentModeValue,
            set: (v: string) => updateSelection(v, false)
        });

        leftSection.appendChild(modeLabel);
        leftSection.appendChild(modeSelector);

        // Add Model Selector (User Request: Right of mode selection, small)
        const modelSelector = createModelSelector();
        leftSection.appendChild(modelSelector);

        // Add pin/unpin button on the right
        const pinButton = doc.createElement("button");
        pinButton.id = "pin-window-btn";
        pinButton.title = "固定窗口在最上面";
        pinButton.style.width = "24px";
        pinButton.style.height = "24px";
        pinButton.style.border = "none";
        pinButton.style.backgroundColor = "transparent";
        pinButton.style.cursor = "pointer";
        pinButton.style.padding = "0";
        pinButton.style.display = "flex";
        pinButton.style.alignItems = "center";
        pinButton.style.justifyContent = "center";
        pinButton.style.opacity = "0.7";
        pinButton.style.transition = "opacity 0.2s";

        // Use initial pinned state
        let isPinned = initialPinned;

        // Create pin icon container
        const pinIconContainer = doc.createElement("div");
        pinIconContainer.style.width = "16px";
        pinIconContainer.style.height = "16px";
        pinIconContainer.style.display = "flex";
        pinIconContainer.style.alignItems = "center";
        pinIconContainer.style.justifyContent = "center";

        // Function to create pin icon (fixed state)
        const createPinIcon = () => {
            const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.setAttribute("width", "16");
            svg.setAttribute("height", "16");
            svg.setAttribute("viewBox", "0 0 24 24");
            svg.setAttribute("fill", "none");
            svg.setAttribute("stroke", "currentColor");
            svg.setAttribute("stroke-width", "2");
            svg.setAttribute("stroke-linecap", "round");
            svg.setAttribute("stroke-linejoin", "round");

            // Pin icon: circle head + line
            const head = doc.createElementNS("http://www.w3.org/2000/svg", "circle");
            head.setAttribute("cx", "12");
            head.setAttribute("cy", "5");
            head.setAttribute("r", "2");
            head.setAttribute("fill", "currentColor");

            const shaft = doc.createElementNS("http://www.w3.org/2000/svg", "line");
            shaft.setAttribute("x1", "12");
            shaft.setAttribute("y1", "7");
            shaft.setAttribute("x2", "12");
            shaft.setAttribute("y2", "19");

            svg.appendChild(head);
            svg.appendChild(shaft);
            return svg;
        };

        // Function to create window icon (unfixed state)
        const createWindowIcon = () => {
            const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.setAttribute("width", "16");
            svg.setAttribute("height", "16");
            svg.setAttribute("viewBox", "0 0 24 24");
            svg.setAttribute("fill", "none");
            svg.setAttribute("stroke", "currentColor");
            svg.setAttribute("stroke-width", "2");
            svg.setAttribute("stroke-linecap", "round");
            svg.setAttribute("stroke-linejoin", "round");

            // Window icon: rectangle with lines
            const rect = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
            rect.setAttribute("x", "3");
            rect.setAttribute("y", "3");
            rect.setAttribute("width", "18");
            rect.setAttribute("height", "18");
            rect.setAttribute("rx", "2");

            const line1 = doc.createElementNS("http://www.w3.org/2000/svg", "line");
            line1.setAttribute("x1", "3");
            line1.setAttribute("y1", "9");
            line1.setAttribute("x2", "21");
            line1.setAttribute("y2", "9");

            const line2 = doc.createElementNS("http://www.w3.org/2000/svg", "line");
            line2.setAttribute("x1", "9");
            line2.setAttribute("y1", "3");
            line2.setAttribute("x2", "9");
            line2.setAttribute("y2", "21");

            svg.appendChild(rect);
            svg.appendChild(line1);
            svg.appendChild(line2);
            return svg;
        };

        // Update icon based on pinned state
        const updatePinIcon = (pinned: boolean) => {
            pinIconContainer.innerHTML = "";
            const icon = pinned ? createPinIcon() : createWindowIcon();
            const color = pinned ? "#007bff" : "#666";
            icon.setAttribute("style", `color: ${color};`);
            pinIconContainer.appendChild(icon);
            pinButton.title = pinned ? "取消固定窗口（点击后窗口会在其他窗口之下）" : "固定窗口在最上面（点击后窗口会始终在其他窗口之上）";
        };

        updatePinIcon(isPinned);
        pinButton.appendChild(pinIconContainer);

        pinButton.onclick = () => {
            isPinned = !isPinned;
            try {
                let success = false;

                // Method 1: Direct window method (works in older Zotero/Firefox)
                // @ts-ignore
                if (typeof win.setAlwaysRaised === "function") {
                    // @ts-ignore
                    win.setAlwaysRaised(isPinned);
                    success = true;
                }

                // Method 2: Access underlying XUL window via docShell
                if (!success && win.docShell) {
                    try {
                        // @ts-ignore
                        const treeOwner = win.docShell.treeOwner;
                        // @ts-ignore
                        const ifreq = treeOwner.QueryInterface(Components.interfaces.nsIInterfaceRequestor);
                        // @ts-ignore
                        const xulWin = ifreq.getInterface(Components.interfaces.nsIXULWindow);
                        if (xulWin) {
                            // zLevel: 0 = normal, 1 = floating, 2 = top-most (alwaysRaised)
                            // In recent Firefox, this might be restricted, but worth a try in Zotero
                            xulWin.zLevel = isPinned ? 2 : 0; // or xulWin.highestZ
                            success = true;
                            Zotero.debug(`[AI for Science] Window zLevel set to ${isPinned ? 2 : 0}`);
                        }
                    } catch (err) {
                        Zotero.debug("[AI for Science] Failed to set zLevel: " + err);
                    }
                }

                // Method 3: windowUtils
                if (!success && win.windowUtils) {
                    try {
                        // @ts-ignore
                        win.windowUtils.setAlwaysRaised(isPinned);
                        success = true;
                    } catch (e) { }
                }

                // Update icon opacity and title regardless of success (UI feedback)
                updatePinIcon(isPinned);

                if (success) {
                    Zotero.debug(`[AI for Science] Window pinned state changed to ${isPinned}`);
                } else {
                    Zotero.debug(`[AI for Science] Could not change window pinned state (API restriction)`);
                }
            } catch (e) {
                Zotero.debug("[AI for Science] Failed to toggle window pin: " + e);
                updatePinIcon(isPinned);
            }
        };

        modeSelectorContainer.appendChild(leftSection);
        // modeSelectorContainer.appendChild(pinButton);

        // Insert mode selector after quick-actions and before input-area
        const quickActions = doc.getElementById("quick-actions");
        const inputArea = doc.getElementById("input-area");
        if (quickActions && inputArea) {
            // Insert after quick-actions, before input-area
            quickActions.parentElement?.insertBefore(modeSelectorContainer, inputArea);
        } else {
            // Fallback: insert before messages area if quick-actions not found
            const chatContainer = messagesArea.parentElement;
            if (chatContainer) {
                chatContainer.insertBefore(modeSelectorContainer, messagesArea);
            }
        }

        // Load conversation messages
        const loadConversationOnInit = async () => {
            // Always clear messages area first when creating new conversation
            if (shouldCreateNewConversation) {
                // Remove all warning messages before clearing
                if (messagesArea) {
                    const allWarnings = messagesArea.querySelectorAll("#selection-warning-message");
                    allWarnings.forEach((warning: Element) => warning.remove());
                }
                messagesArea.innerHTML = "";
                // Reset warning message state after clearing
                warningMessageState.shouldShow = false;
                warningMessageState.messageElement = null;
                // New conversation already created in initialization, just show welcome message
                if (currentPaperGroupID) {
                    const group = await getPaperGroup(currentPaperGroupID);
                    if (group) {
                        // Get all paper titles and check which PDFs are not open
                        const paperTitles: string[] = [];
                        const papersWithoutPDF = await getPapersWithoutOpenPDF(group);

                        for (const itemID of group.itemIDs) {
                            try {
                                const paperItem = Zotero.Items.get(itemID);
                                if (paperItem) {
                                    const title = paperItem.getField('title') || 'Untitled';
                                    paperTitles.push(title);
                                }
                            } catch (e) {
                                Zotero.debug(`Error getting paper ${itemID}: ${e}`);
                            }
                        }

                        // Create greeting message with all papers
                        let greetingMsg = `您好！我可以帮您处理以下 ${paperTitles.length} 篇论文：\n\n`;
                        paperTitles.forEach((title, index) => {
                            greetingMsg += `${index + 1}. ${title}\n`;
                        });
                        greetingMsg += `\n您可以让我分析、比较或讨论这些论文中的任何内容。`;

                        // Add warning if some PDFs are not open
                        if (papersWithoutPDF.length > 0) {
                            greetingMsg += `\n\n⚠️ 提示：以下 ${papersWithoutPDF.length} 篇论文的PDF尚未打开，可能影响分析效果：\n`;
                            papersWithoutPDF.forEach((paper, index) => {
                                greetingMsg += `${index + 1}. ${paper.title}\n`;
                            });
                            greetingMsg += `\n建议先打开这些论文的PDF以获得更好的分析效果。`;
                        }

                        addMessage(messagesArea, "AI", greetingMsg, "ai");
                    } else {
                        addMessage(messagesArea, "System", "已选择论文组（论文组不存在或已删除）", "system");
                    }
                } else {
                    const itemTitle = item.getField('title') || 'Untitled';
                    addMessage(messagesArea, "AI", `Hello! I can help you with "${itemTitle}". Ask me anything.`, "ai");
                }
            } else if (currentConversationID) {
                // Clear messages area before loading
                messagesArea.innerHTML = "";
                // Load current conversation
                const conversation = await getConversation(item?.id, currentConversationID, currentPaperGroupID || undefined);
                if (conversation) {
                    // Check if conversation belongs to current item or group
                    const belongsToCurrent = (conversation.groupID && conversation.groupID === currentPaperGroupID) ||
                        (conversation.itemID && conversation.itemID === item?.id);

                    if (belongsToCurrent) {
                        // Same item/group, load messages
                        if (conversation.messages.length > 0) {
                            conversation.messages.forEach(({ sender, text, type }) => {
                                addMessage(messagesArea, sender, text, type);
                            });
                        } else {
                            // No messages in conversation, show greeting
                            if (currentPaperGroupID) {
                                const group = await getPaperGroup(currentPaperGroupID);
                                if (group) {
                                    // Get all paper titles and check which PDFs are not open
                                    const paperTitles: string[] = [];
                                    const papersWithoutPDF = await getPapersWithoutOpenPDF(group);

                                    for (const itemID of group.itemIDs) {
                                        try {
                                            const paperItem = Zotero.Items.get(itemID);
                                            if (paperItem) {
                                                const title = paperItem.getField('title') || 'Untitled';
                                                paperTitles.push(title);
                                            }
                                        } catch (e) {
                                            Zotero.debug(`Error getting paper ${itemID}: ${e}`);
                                        }
                                    }

                                    // Create greeting message with all papers
                                    let greetingMsg = `您好！我可以帮您处理以下 ${paperTitles.length} 篇论文：\n\n`;
                                    paperTitles.forEach((title, index) => {
                                        greetingMsg += `${index + 1}. ${title}\n`;
                                    });
                                    greetingMsg += `\n您可以让我分析、比较或讨论这些论文中的任何内容。`;
                                    addMessage(messagesArea, "AI", greetingMsg, "ai");

                                    // Show warning in dialog if some PDFs are not open
                                    if (papersWithoutPDF.length > 0) {
                                        const warningMsg = `⚠️ 提示：以下 ${papersWithoutPDF.length} 篇论文的PDF尚未打开，可能影响分析效果：\n${papersWithoutPDF.map((paper, index) => `${index + 1}. ${paper.title}`).join('\n')}\n\n建议先打开这些论文的PDF以获得更好的分析效果。`;
                                        win.alert(warningMsg);
                                    }
                                } else {
                                    addMessage(messagesArea, "System", "已选择论文组（论文组不存在或已删除）", "system");
                                }
                            } else {
                                const itemTitle = item.getField('title') || 'Untitled';
                                addMessage(messagesArea, "AI", `Hello! I can help you with "${itemTitle}". Ask me anything.`, "ai");
                            }
                        }
                    } else {
                        // Conversation belongs to different item/group, create new conversation
                        let newConv: Conversation;
                        if (currentPaperGroupID) {
                            newConv = createNewConversation(undefined, undefined, currentPaperGroupID);
                            const group = await getPaperGroup(currentPaperGroupID);
                            if (group) {
                                const groupInfoMsg = `已选择论文组：${group.name} (${group.itemIDs.length} 篇论文)\n\n您可以对组内所有论文进行综合分析。`;
                                addMessage(messagesArea, "System", groupInfoMsg, "system");
                            } else {
                                addMessage(messagesArea, "System", "已选择论文组（论文组不存在或已删除）", "system");
                            }
                        } else if (item) {
                            newConv = createNewConversation(item.id);
                            const itemTitle = item.getField('title') || 'Untitled';
                            addMessage(messagesArea, "AI", `Hello! I can help you with "${itemTitle}". Ask me anything.`, "ai");
                        } else {
                            return;
                        }
                        currentConversationID = newConv.id;
                    }
                } else {
                    // Conversation not found, show welcome message
                    if (currentPaperGroupID) {
                        const group = await getPaperGroup(currentPaperGroupID);
                        if (group) {
                            // Create new conversation
                            const newConv = createNewConversation(undefined, undefined, currentPaperGroupID);
                            currentConversationID = newConv.id;

                            // Get all paper titles and check which PDFs are not open
                            const paperTitles: string[] = [];
                            const papersWithoutPDF = await getPapersWithoutOpenPDF(group);

                            for (const itemID of group.itemIDs) {
                                try {
                                    const paperItem = Zotero.Items.get(itemID);
                                    if (paperItem) {
                                        const title = paperItem.getField('title') || 'Untitled';
                                        paperTitles.push(title);
                                    }
                                } catch (e) {
                                    Zotero.debug(`Error getting paper ${itemID}: ${e}`);
                                }
                            }

                            // Create greeting message with all papers
                            let greetingMsg = `您好！我可以帮您处理以下 ${paperTitles.length} 篇论文：\n\n`;
                            paperTitles.forEach((title, index) => {
                                greetingMsg += `${index + 1}. ${title}\n`;
                            });
                            greetingMsg += `\n您可以让我分析、比较或讨论这些论文中的任何内容。`;
                            addMessage(messagesArea, "AI", greetingMsg, "ai");

                            // Show warning in dialog if some PDFs are not open
                            if (papersWithoutPDF.length > 0) {
                                const warningMsg = `⚠️ 提示：以下 ${papersWithoutPDF.length} 篇论文的PDF尚未打开，可能影响分析效果：\n${papersWithoutPDF.map((paper, index) => `${index + 1}. ${paper.title}`).join('\n')}\n\n建议先打开这些论文的PDF以获得更好的分析效果。`;
                                win.alert(warningMsg);
                            }
                        } else {
                            addMessage(messagesArea, "System", "已选择论文组（论文组不存在或已删除）", "system");
                        }
                    } else {
                        const itemTitle = item.getField('title') || 'Untitled';
                        addMessage(messagesArea, "AI", `Hello! I can help you with "${itemTitle}". Ask me anything.`, "ai");
                    }
                }
            } else {
                // No conversation ID, show welcome message
                if (currentPaperGroupID) {
                    const group = await getPaperGroup(currentPaperGroupID);
                    if (group) {
                        // Create new conversation
                        const newConv = createNewConversation(undefined, undefined, currentPaperGroupID);
                        currentConversationID = newConv.id;

                        // Get all paper titles and check which PDFs are not open
                        const paperTitles: string[] = [];
                        const papersWithoutPDF = await getPapersWithoutOpenPDF(group);

                        for (const itemID of group.itemIDs) {
                            try {
                                const paperItem = Zotero.Items.get(itemID);
                                if (paperItem) {
                                    const title = paperItem.getField('title') || 'Untitled';
                                    paperTitles.push(title);
                                }
                            } catch (e) {
                                Zotero.debug(`Error getting paper ${itemID}: ${e}`);
                            }
                        }

                        // Create greeting message with all papers
                        let greetingMsg = `您好！我可以帮您处理以下 ${paperTitles.length} 篇论文：\n\n`;
                        paperTitles.forEach((title, index) => {
                            greetingMsg += `${index + 1}. ${title}\n`;
                        });
                        greetingMsg += `\n您可以让我分析、比较或讨论这些论文中的任何内容。`;

                        // Add warning if some PDFs are not open
                        if (papersWithoutPDF.length > 0) {
                            greetingMsg += `\n\n⚠️ 提示：以下 ${papersWithoutPDF.length} 篇论文的PDF尚未打开，可能影响分析效果：\n`;
                            papersWithoutPDF.forEach((paper, index) => {
                                greetingMsg += `${index + 1}. ${paper.title}\n`;
                            });
                            greetingMsg += `\n建议先打开这些论文的PDF以获得更好的分析效果。`;
                        }

                        addMessage(messagesArea, "AI", greetingMsg, "ai");
                    } else {
                        addMessage(messagesArea, "System", "已选择论文组（论文组不存在或已删除）", "system");
                    }
                } else {
                    const itemTitle = item.getField('title') || 'Untitled';
                    addMessage(messagesArea, "AI", `Hello! I can help you with "${itemTitle}". Ask me anything.`, "ai");
                }
            }
        };
        loadConversationOnInit();

        // Add MCP Tools List Button/Panel immediately (only show in agent mode)
        const updateMCPToolsVisibility = () => {
            const mcpStatus = doc.getElementById("mcp-tools-status");
            if (mcpStatus) {
                (mcpStatus as HTMLElement).style.display = modeSelector.value === "agent" ? "flex" : "none";
            }
            // If switching to ask mode, close the expanded tools list if it's open
            if (modeSelector.value === "ask") {
                const toolsList = doc.getElementById("mcp-active-tools-list");
                if (toolsList) {
                    toolsList.remove();
                }
            }
        };

        modeSelector.onchange = updateMCPToolsVisibility;
        addMCPToolsIndicator(messagesArea.parentElement as HTMLElement);
        updateMCPToolsVisibility();

        // Load MCP tools in background (don't await to block UI, but update indicator when done)
        loadMCPTools().then(() => {
            Zotero.debug("[AI for Science] Tools loaded.");
        });

        const status = await getPDFReaderStatus(item);
        if (status.isOpen) {
            addMessage(messagesArea, "System", "PDF Reader is detected. You can select text to ask specific questions.", "system");
        } else if (status.hasPDF) {
            addMessage(messagesArea, "System", "PDF Reader is not open. Open the PDF to allow text selection.", "system");
        }


        // Auto-snap/hide logic (QQ-style)
        let isHidden = false;
        const SNAP_THRESHOLD = 10;
        const VISIBLE_STRIP = 20;
        let hideTimer: any = null;
        let ignoreMouseEvents = false;
        let animationFrame: any = null;

        const animateWindow = (targetY: number) => {
            ignoreMouseEvents = true;
            if (animationFrame) win.cancelAnimationFrame(animationFrame);

            const startY = win.screenY;
            const distance = targetY - startY;
            const duration = 200; // ms
            const startTime = Date.now();

            const step = () => {
                const elapsed = Date.now() - startTime;
                const progress = Math.min(elapsed / duration, 1);
                const ease = progress * (2 - progress); // Ease out

                const newY = startY + (distance * ease);
                win.moveTo(win.screenX, newY);

                if (progress < 1) {
                    animationFrame = win.requestAnimationFrame(step);
                } else {
                    win.moveTo(win.screenX, targetY);
                    setTimeout(() => {
                        ignoreMouseEvents = false;
                    }, 100);
                    animationFrame = null;
                }
            };
            animationFrame = win.requestAnimationFrame(step);
        };

        // Store expand function and current item ID on window for external access
        // @ts-ignore
        win.expandChatWindow = () => {
            // Clear any pending hide timer
            if (hideTimer) {
                clearTimeout(hideTimer);
                hideTimer = null;
            }

            // If window is hidden, expand it
            if (isHidden || win.screenY <= SNAP_THRESHOLD) {
                isHidden = false;
                // Expand window to visible position
                animateWindow(0);
            }

            // Focus the window
            win.focus();
        };

        // Store current item ID
        // @ts-ignore
        win.currentItemID = item ? item.id : null;

        const moveWindow = (x: number, y: number) => {
            ignoreMouseEvents = true;
            win.moveTo(x, y);
            setTimeout(() => {
                ignoreMouseEvents = false;
            }, 500);
        };

        // Initial Snap to Top Right (only if not preserving position)
        // @ts-ignore
        if (!win.preservePosition) {
            setTimeout(() => {
                if (win.screen) {
                    // Align to right side
                    const right = win.screen.availLeft + win.screen.availWidth - win.outerWidth - 100;
                    moveWindow(right, 0);
                } else {
                    moveWindow(win.screenX, 0);
                }
            }, 100);
        }

        doc.addEventListener('mouseout', (e) => {
            if (ignoreMouseEvents) return;

            // Don't hide if input is focused
            if (doc.activeElement === input) return;

            const mouseEvent = e as MouseEvent;
            // If mouse leaves the window (relatedTarget is null) and window is at top
            if (!mouseEvent.relatedTarget && win.screenY <= SNAP_THRESHOLD) {
                if (hideTimer) clearTimeout(hideTimer);

                hideTimer = setTimeout(() => {
                    if (!isHidden && win.screenY <= SNAP_THRESHOLD && !ignoreMouseEvents) {
                        // Double check focus before hiding (in case user focused during timeout)
                        if (doc.activeElement === input) return;

                        isHidden = true;
                        // Slide up with animation
                        animateWindow(-win.outerHeight + VISIBLE_STRIP);
                    }
                }, 500);
            }
        });

        doc.addEventListener('mouseover', () => {
            if (hideTimer) {
                clearTimeout(hideTimer);
                hideTimer = null;
            }

            // If mouse enters and window is hidden
            if (isHidden) {
                isHidden = false;
                // Slide down with animation
                animateWindow(0);
            }
        });

        // Extra stability: cancel hide if mouse moves inside window
        doc.addEventListener('mousemove', () => {
            if (hideTimer) {
                clearTimeout(hideTimer);
                hideTimer = null;
            }
        });
    }
}

function addMCPToolsIndicator(container: HTMLElement) {
    const doc = container.ownerDocument;
    if (!doc) return;

    // Check if exists
    if (doc.getElementById("mcp-tools-status")) return;

    const statusDiv = doc.createElement("div");
    statusDiv.id = "mcp-tools-status";
    statusDiv.style.padding = "5px 10px";
    statusDiv.style.backgroundColor = "#f0f0f0";
    statusDiv.style.borderTop = "1px solid #ddd";
    statusDiv.style.fontSize = "12px";
    statusDiv.style.color = "#666";
    statusDiv.style.cursor = "pointer";
    statusDiv.style.display = "flex";
    statusDiv.style.justifyContent = "space-between";
    statusDiv.style.userSelect = "none";

    // Initial text based on loaded tools
    statusDiv.textContent = `MCP Tools: ${activeMCPTools.length} available`;
    if (activeMCPTools.length > 0) {
        // Calculate selected tools
        const selectedCount = activeMCPTools.filter(t => selectedToolNames.has(t.function.name)).length;
        statusDiv.textContent = `MCP Tools: ${selectedCount}/${activeMCPTools.length} selected`;
        statusDiv.style.color = "green";
    } else {
        statusDiv.textContent = "MCP Tools: None active";
        statusDiv.style.color = "#888";
    }

    // Insert before the input area if possible, or append to container
    const inputArea = container.querySelector("#chat-input-area") || container.lastElementChild;
    if (inputArea && inputArea.parentNode) {
        inputArea.parentNode.insertBefore(statusDiv, inputArea);
    } else {
        container.appendChild(statusDiv);
    }

    statusDiv.onclick = () => {
        // Toggle tool list visibility
        const listId = "mcp-active-tools-list";
        let list = doc.getElementById(listId) as HTMLElement | null;

        if (list) {
            // If list exists, remove it (toggle off)
            list.remove();
        } else {
            // Create list
            list = doc.createElement("div");
            list.id = listId;
            // Position it properly. 
            // We insert it right after statusDiv in the DOM flow.
            // Style it to look like a panel.
            list.style.backgroundColor = "#fff";
            list.style.borderBottom = "1px solid #ddd";
            list.style.padding = "10px";
            // User requested scrollbar if > 2 items. Assuming item height ~30px. 
            // 2 items = ~60-70px. Let's set max-height to around 80px to show 2.5 items or so.
            // But user said "if exceeds two", so maybe dynamic? 
            // Fixed max-height is easiest.
            list.style.maxHeight = "100px";
            list.style.overflowY = "auto";

            // Populate list with checkboxes
            if (activeMCPTools.length === 0) {
                const item = doc.createElement("div");
                item.textContent = "No tools loaded.";
                item.style.fontStyle = "italic";
                list.appendChild(item);
            } else {
                activeMCPTools.forEach(tool => {
                    // We know list is not null here because we just created it
                    if (!list) return;

                    const row = doc.createElement("div");
                    row.style.display = "flex";
                    row.style.alignItems = "center";
                    row.style.marginBottom = "5px";

                    const checkbox = doc.createElement("input");
                    checkbox.type = "checkbox";
                    checkbox.checked = selectedToolNames.has(tool.function.name);
                    checkbox.style.marginRight = "8px";

                    checkbox.onchange = (e) => {
                        const checked = (e.target as HTMLInputElement).checked;
                        if (checked) {
                            selectedToolNames.add(tool.function.name);
                        } else {
                            selectedToolNames.delete(tool.function.name);
                        }
                        // Update status text
                        const count = selectedToolNames.size;
                        statusDiv.textContent = `MCP Tools: ${count}/${activeMCPTools.length} selected`;
                    };

                    const label = doc.createElement("div");
                    label.style.flex = "1";
                    label.style.cursor = "pointer"; // Add cursor pointer to indicate clickable

                    const name = doc.createElement("div");
                    name.textContent = tool.function.name;

                    name.style.fontWeight = "bold";
                    name.style.fontSize = "0.9em";

                    const desc = doc.createElement("div");
                    desc.textContent = tool.function.description || "";
                    desc.style.fontSize = "0.8em";
                    desc.style.color = "#666";

                    label.appendChild(name);
                    label.appendChild(desc);

                    // Allow clicking label/row to toggle
                    label.onclick = (e) => {
                        e.stopPropagation();
                        // Toggle checkbox
                        checkbox.checked = !checkbox.checked;
                        // Trigger change event logic manually
                        if (checkbox.checked) {
                            selectedToolNames.add(tool.function.name);
                        } else {
                            selectedToolNames.delete(tool.function.name);
                        }
                        // Update status text
                        const count = selectedToolNames.size;
                        statusDiv.textContent = `MCP Tools: ${count}/${activeMCPTools.length} selected`;
                    };

                    row.appendChild(checkbox);
                    row.appendChild(label);
                    list.appendChild(row);
                });
            }

            // Add "Get more MCP tools" link
            const linkDiv = doc.createElement("div");
            linkDiv.style.marginTop = "10px";
            linkDiv.style.paddingTop = "8px";
            linkDiv.style.borderTop = "1px solid #eee";
            linkDiv.style.fontSize = "0.85em";
            linkDiv.style.textAlign = "center";

            // Use button to ensure better clickability/handling
            const link = doc.createElement("button");
            link.textContent = "Get more MCP tools";
            link.style.background = "none";
            link.style.border = "none";
            link.style.padding = "4px 8px";
            link.style.color = "#007bff";
            link.style.textDecoration = "underline";
            link.style.cursor = "pointer";
            link.style.fontFamily = "inherit";
            link.style.fontSize = "inherit";

            // Open URL using Zotero main window's window.open - only one method
            link.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();

                const url = "https://mcp.so";
                Zotero.debug(`[AI for Science] CLICK DETECTED on Get More Tools, opening: ${url}`);

                // Use only Zotero main window's window.open
                try {
                    const mainWin = Zotero.getMainWindow();
                    if (mainWin && typeof mainWin.open === "function") {
                        mainWin.open(url, "_blank", "noopener,noreferrer");
                        Zotero.debug("[AI for Science] Link opened via MainWindow.open");
                    } else {
                        Zotero.debug("[AI for Science] MainWindow.open not available");
                    }
                } catch (err) {
                    Zotero.debug(`[AI for Science] Failed to open link: ${err}`);
                }
            };

            linkDiv.appendChild(link);
            list.appendChild(linkDiv);


            // Insert after statusDiv
            if (statusDiv.nextSibling) {
                statusDiv.parentNode?.insertBefore(list, statusDiv.nextSibling);
            } else {
                statusDiv.parentNode?.appendChild(list);
            }
        }
    };

    // Check interval to update status
    const updateStatus = () => {
        if (activeMCPTools.length > 0) {
            const selectedCount = activeMCPTools.filter(t => selectedToolNames.has(t.function.name)).length;
            statusDiv.textContent = `MCP Tools: ${selectedCount}/${activeMCPTools.length} selected`;
            statusDiv.style.color = "green";
        } else {
            statusDiv.textContent = "MCP Tools: None active";
            statusDiv.style.color = "#888";
        }
    };

    // Update initially and poll
    setInterval(updateStatus, 1000);
}

// Helper function to escape HTML
function escapeHtml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function parseMarkdown(text: string): string {
    // Basic Markdown Parser
    if (!text) return "";

    // Use placeholders to protect code blocks from HTML escaping
    const codeBlockPlaceholders: string[] = [];
    const inlineCodePlaceholders: string[] = [];

    // First, extract and protect code blocks
    let html = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
        const placeholder = `__CODE_BLOCK_${codeBlockPlaceholders.length}__`;
        codeBlockPlaceholders.push(`<pre><code class="language-${lang || ''}">${escapeHtml(code)}</code></pre>`);
        return placeholder;
    });

    html = html.replace(/```([\s\S]*?)```/g, (match, code) => {
        const placeholder = `__CODE_BLOCK_${codeBlockPlaceholders.length}__`;
        codeBlockPlaceholders.push(`<pre><code>${escapeHtml(code)}</code></pre>`);
        return placeholder;
    });

    // Extract and protect inline code
    html = html.replace(/`([^`]+)`/g, (match, code) => {
        const placeholder = `__INLINE_CODE_${inlineCodePlaceholders.length}__`;
        inlineCodePlaceholders.push(`<code>${escapeHtml(code)}</code>`);
        return placeholder;
    });

    // Now escape HTML entities in the remaining text
    // Must escape & first to avoid double-escaping
    html = html
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

    // Restore code blocks and inline code
    codeBlockPlaceholders.forEach((replacement, index) => {
        html = html.replace(`__CODE_BLOCK_${index}__`, replacement);
    });
    inlineCodePlaceholders.forEach((replacement, index) => {
        html = html.replace(`__INLINE_CODE_${index}__`, replacement);
    });

    // Bold (must be processed before italic to avoid conflicts)
    // Match **text** but not ***text*** (which should be bold+italic)
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italic - match *text* but ensure it's a complete pair
    // Use a simple approach: match pairs and escape unmatched ones
    // First, find all potential italic pairs
    const italicPattern = /\*([^*\n]+?)\*/g;
    const italicMatches: Array<{ match: string, content: string, start: number, end: number }> = [];
    let match;
    while ((match = italicPattern.exec(html)) !== null) {
        italicMatches.push({
            match: match[0],
            content: match[1],
            start: match.index,
            end: match.index + match[0].length
        });
    }

    // Replace matches in reverse order to preserve indices
    for (let i = italicMatches.length - 1; i >= 0; i--) {
        const m = italicMatches[i];
        if (m.content && m.content.trim()) {
            html = html.substring(0, m.start) + `<em>${m.content}</em>` + html.substring(m.end);
        }
    }

    // Escape any remaining unmatched single asterisks to prevent XML errors
    // Use numeric entity instead of named entity for better compatibility
    html = html.replace(/\*/g, '&#42;');

    // Headers
    html = html.replace(/^### (.*$)/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gm, '<h1>$1</h1>');

    // Blockquotes
    html = html.replace(/^> (.*$)/gm, '<blockquote>$1</blockquote>');

    // Lists - Unordered
    html = html.replace(/^\s*[-*] (.*$)/gm, '<ul><li>$1</li></ul>');
    // Lists - Ordered
    html = html.replace(/^\s*(\d+)\. (.*$)/gm, '<ol><li>$2</li></ol>');

    // Fix adjacent lists
    html = html.replace(/<\/ul>\s*<ul>/g, '');
    html = html.replace(/<\/ol>\s*<ol>/g, '');

    // Newlines to breaks (careful to not break block elements)
    // Replace newlines that are NOT following a closing block tag
    html = html.replace(/\n/g, '<br/>');
    html = html.replace(/(<\/h[1-6]>|<\/pre>|<\/ul>|<\/ol>|<\/blockquote>|<\/p>)<br\/>/g, '$1');
    html = html.replace(/<br\/>(<li>)/g, '$1');

    // Final cleanup: ensure all HTML tags are properly closed to prevent XML parsing errors
    // Count opening and closing tags for common inline tags
    const tagPairs: { [key: string]: string } = {
        'em': 'em',
        'strong': 'strong',
        'code': 'code'
    };

    for (const [openTag, closeTag] of Object.entries(tagPairs)) {
        const openMatches = html.match(new RegExp(`<${openTag}[^>]*>`, 'g')) || [];
        const closeMatches = html.match(new RegExp(`</${closeTag}>`, 'g')) || [];
        const diff = openMatches.length - closeMatches.length;
        // If we have unclosed tags, close them
        if (diff > 0) {
            html += '</' + closeTag + '>'.repeat(diff);
        }
    }

    return html;
}

function extractHtmlDocument(text: string): { html: string; complete: boolean } | null {
    if (!text) return null;
    let source = text.trim();
    const fenced = source.match(/```(?:html)?\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) {
        source = fenced[1].trim();
    }

    const lower = source.toLowerCase();
    let startIndex = lower.indexOf("<!doctype html");
    if (startIndex === -1) {
        startIndex = lower.indexOf("<html");
    }
    if (startIndex === -1) return null;

    const sliced = source.slice(startIndex);
    const endIndex = sliced.toLowerCase().indexOf("</html>");
    if (endIndex !== -1) {
        const html = sliced.slice(0, endIndex + "</html>".length);
        return { html, complete: true };
    }
    return { html: sliced, complete: false };
}

function isFullHtmlDocument(text: string): boolean {
    return extractHtmlDocument(text) !== null;
}

async function openHtmlInBrowser(html: string) {
    try {
        // @ts-ignore
        const tempDir = PathUtils.tempDir;
        const filename = `ai_html_${Date.now()}.html`;
        // @ts-ignore
        const filePath = PathUtils.join(tempDir, filename);
        // @ts-ignore
        await IOUtils.writeUTF8(filePath, html);

        // Prefer opening via default browser (same as resume export)
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const Cc = (globalThis as any).Components.classes;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const Ci = (globalThis as any).Components.interfaces;
            const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
            file.initWithPath(filePath);
            const ZoteroGlobal = ztoolkit.getGlobal("Zotero") as any;
            if (ZoteroGlobal?.launchFile) {
                ZoteroGlobal.launchFile(file);
                Zotero.debug("[AI for Science] HTML opened via Zotero.launchFile");
                return;
            }
        } catch (e) {
            Zotero.debug(`[AI for Science] launchFile failed, falling back: ${e}`);
        }

        // @ts-ignore
        const fileUrl = PathUtils.toFileURI(filePath);
        Zotero.launchURL(fileUrl);
    } catch (e) {
        Zotero.log(`[AI for Science] Failed to open HTML in browser: ${e}`);
    }
}

function renderAIContent(contentEl: HTMLElement, text: string, final: boolean) {
    if (!contentEl) return;
    const doc = contentEl.ownerDocument;
    if (!final) {
        contentEl.innerHTML = parseMarkdown(text);
        return;
    }

    const extracted = extractHtmlDocument(text);
    if (extracted) {
        const htmlDoc = extracted.html;
        contentEl.textContent = "";
        if (!doc) return;

        const wrapper = doc.createElement("div");
        wrapper.style.display = "flex";
        wrapper.style.flexDirection = "column";
        wrapper.style.gap = "8px";

        const openBtn = doc.createElement("button");
        openBtn.textContent = "在浏览器打开报告";
        openBtn.style.alignSelf = "flex-start";
        openBtn.style.padding = "6px 10px";
        openBtn.style.borderRadius = "8px";
        openBtn.style.border = "1px solid #ddd";
        openBtn.style.background = "#f8f9fa";
        openBtn.style.cursor = "pointer";
        openBtn.addEventListener("click", () => {
            openHtmlInBrowser(htmlDoc);
        });

        const pre = doc.createElement("pre");
        pre.style.whiteSpace = "pre-wrap";
        pre.style.background = "#f6f8fa";
        pre.style.border = "1px solid #e0e0e0";
        pre.style.borderRadius = "8px";
        pre.style.padding = "10px";
        pre.style.margin = "0";
        pre.textContent = htmlDoc;

        wrapper.appendChild(openBtn);
        wrapper.appendChild(pre);
        contentEl.appendChild(wrapper);
        return;
    }

    contentEl.innerHTML = parseMarkdown(text);
}

// Collect current messages from DOM while preserving AI markdown
function collectMessagesFromDom(messagesArea: HTMLElement): Array<{ sender: string, text: string, type: string }> {
    const currentMessages: Array<{ sender: string, text: string, type: string }> = [];
    const messageElements = messagesArea.querySelectorAll(".message");

    messageElements.forEach((msgEl: Element) => {
        const type = msgEl.classList.contains("user") ? "user" :
            msgEl.classList.contains("ai") ? "ai" :
                msgEl.classList.contains("error") ? "error" : "system";
        if (type === "system") {
            return;
        }

        const sender = msgEl.classList.contains("user") ? "User" :
            msgEl.classList.contains("ai") ? "AI" : "System";
        const contentEl = msgEl.querySelector(".message-content");

        let text = "";
        if (type === "ai") {
            if (msgEl.hasAttribute("data-original-markdown")) {
                text = msgEl.getAttribute("data-original-markdown") || "";
            }
            if (!text && contentEl) {
                text = contentEl.textContent || "";
            }
        } else if (contentEl) {
            text = contentEl.textContent || "";
        }

        if (text) {
            currentMessages.push({ sender, text, type });
        }
    });

    return currentMessages;
}

function addMessage(container: HTMLElement, sender: string, text: string, type: string) {
    const doc = container.ownerDocument;
    if (!doc) return null;
    const msg = doc.createElement("div");
    msg.className = `message ${type}`;

    // Store original text for AI messages (for history saving)
    // This ensures that when we save history, we can retrieve the original markdown
    if (type === "ai" && text) {
        msg.setAttribute("data-original-markdown", text);
    }

    // Inline styles as fallback, but CSS classes in chat.xhtml should handle most
    msg.style.maxWidth = "80%";
    msg.style.padding = "10px 14px";
    msg.style.borderRadius = "16px";
    msg.style.wordWrap = "break-word";
    msg.style.lineHeight = "1.5";
    msg.style.position = "relative";
    msg.style.fontSize = "14px";
    msg.style.marginBottom = "8px";

    if (type === "user") {
        msg.style.backgroundColor = "#007bff";
        msg.style.color = "white";
        msg.style.alignSelf = "flex-end";
        msg.style.borderBottomRightRadius = "4px";
        msg.style.marginLeft = "auto";
    } else if (type === "ai") {
        msg.style.backgroundColor = "#fff";
        msg.style.color = "#333";
        msg.style.alignSelf = "flex-start";
        msg.style.borderBottomLeftRadius = "4px";
        msg.style.boxShadow = "0 1px 2px rgba(0,0,0,0.1)";
        msg.style.border = "1px solid #e0e0e0";
    } else if (type === "system") {
        msg.style.backgroundColor = "transparent";
        msg.style.color = "#666";
        msg.style.fontSize = "0.85em";
        msg.style.alignSelf = "center";
        msg.style.textAlign = "center";
        msg.style.padding = "5px";
        msg.style.boxShadow = "none";
    } else if (type === "error") {
        msg.style.backgroundColor = "#ffebee";
        msg.style.color = "#c62828";
        msg.style.alignSelf = "center";
        msg.style.border = "1px solid #ef9a9a";
    }

    const header = doc.createElement("div");
    header.className = "sender";
    header.textContent = sender;
    header.style.display = "none";

    const content = doc.createElement("div");
    content.className = "message-content";

    if (type === "ai") {
        // For AI messages, always parse as markdown
        // The text should be original markdown text from history
        try {
            renderAIContent(content, text, true);
        } catch (e) {
            // If markdown parsing fails, fallback to text content
            Zotero.debug(`[Chat] Markdown parsing error for AI message: ${e}`);
            content.textContent = text;
        }
    } else if (type === "user") {
        // Users might also want markdown? Let's just text for now or simple escape
        content.textContent = text;
    } else {
        content.textContent = text;
    }

    msg.appendChild(header);
    msg.appendChild(content);
    container.appendChild(msg);
    container.scrollTop = container.scrollHeight;

    return msg;
}

// Helper function to map MCP tools to OpenAI tools
function formatMCPTools(mcpTools: any) {
    // Handle null, undefined, or invalid input
    if (!mcpTools) {
        Zotero.debug(`[AI for Science] formatMCPTools received null/undefined input`);
        return [];
    }

    // Handle case where tools property is null or undefined
    if (!mcpTools.tools) {
        Zotero.debug(`[AI for Science] formatMCPTools: mcpTools.tools is null/undefined. mcpTools structure: ${JSON.stringify(mcpTools)}`);
        return [];
    }

    // Handle case where tools is not an array
    if (!Array.isArray(mcpTools.tools)) {
        Zotero.debug(`[AI for Science] formatMCPTools: mcpTools.tools is not an array. Type: ${typeof mcpTools.tools}, Value: ${JSON.stringify(mcpTools.tools)}`);
        return [];
    }

    const sanitizeToolName = (name: string) => {
        const safeName = (name || "").replace(/[^a-zA-Z0-9_-]/g, "_");
        return safeName || "tool";
    };

    const usedNames = new Set<string>();

    // Filter out any null/undefined tools and map to OpenAI format
    return mcpTools.tools
        .filter((tool: any) => tool && tool.name) // Filter out null/undefined tools
        .map((tool: any) => {
            const originalName = tool.name;
            let safeName = sanitizeToolName(originalName);
            if (usedNames.has(safeName)) {
                let suffix = 2;
                while (usedNames.has(`${safeName}_${suffix}`)) {
                    suffix += 1;
                }
                safeName = `${safeName}_${suffix}`;
            }
            usedNames.add(safeName);

            return {
                type: "function",
                originalName,
                function: {
                    name: safeName,
                    description: tool.description || "",
                    parameters: tool.inputSchema || {}
                }
            };
        });
}

const MAX_USER_CONTENT_CHARS = 40000;
const MAX_TOOL_RESULT_CHARS = 8000;

function truncateForModel(text: string, maxChars: number, label: string) {
    if (!text) return "";
    if (text.length <= maxChars) return text;
    const truncated = text.slice(0, maxChars);
    return `${truncated}\n\n[${label} truncated, ${text.length - maxChars} chars omitted]`;
}

function emitToolResult(onChunk: (text: string) => void, toolName: string, result: string) {
    if (!onChunk) return;
    const text = result || "(empty)";
    const preview = text.length > 4000 ? `${text.slice(0, 4000)}...` : text;
    onChunk(`\n\n*工具返回 (${toolName})*:\n\n${preview}\n\n`);
}

function describeToolPurpose(toolName: string, args: any): string {
    if (!toolName) return "获取所需的外部数据";
    if (toolName === "sql_query" || toolName === "sql.query" || toolName === "execute_query") {
        if (args?.sql && typeof args.sql === "string") {
            const snippet = args.sql.length > 200 ? `${args.sql.slice(0, 200)}...` : args.sql;
            return `执行 SQL 查询以获取所需数据：${snippet}`;
        }
        return "执行 SQL 查询以获取所需数据";
    }
    return "获取所需的外部数据";
}

function emitToolCallReason(onChunk: (text: string) => void, toolName: string, args: any) {
    if (!onChunk) return;
    const reason = describeToolPurpose(toolName, args);
    onChunk(`\n\n*即将调用工具: ${toolName}*（用途：${reason}）\n\n`);
}

function isSciSciNetResolveMode(args: any): boolean {
    const mode = (args?.mode || "").toString().toLowerCase();
    return [
        "authors_by_title",
        "authors_by_title_keyword",
        "authors_by_name_and_title",
        "authors_by_name",
        "papers_by_title",
        "papers_by_title_exact",
        "papers_by_keyword",
        "authors_by_paperid"
    ].includes(mode);
}

function isSciSciNetToolName(name: string): boolean {
    const originalName = resolveToolNameForCall(name);
    return originalName === "sql_query" || originalName === "sql.query";
}

function normalizeSciSciNetToolArgs(
    functionName: string,
    args: any,
    title: string,
    requestedAuthorName?: string | null
): any {
    if (!isSciSciNetToolName(functionName)) return args;
    const safeTitle = (title || "").trim();
    const safeName = (requestedAuthorName || "").trim();
    const hasSql = typeof args?.sql === "string" && args.sql.trim().length > 0;
    const hasTitle = typeof args?.title === "string" && args.title.trim().length > 0;
    const hasAuthorName = typeof args?.author_name === "string" && args.author_name.trim().length > 0;
    const mode = (args?.mode || "").toString().toLowerCase();

    if (hasAuthorName && hasTitle && (!mode || mode === "authors_by_name")) {
        return {
            title: args.title.trim(),
            author_name: args.author_name.trim(),
            mode: "authors_by_name_and_title"
        };
    }

    if (hasAuthorName && !hasTitle && safeTitle) {
        const authorName = args.author_name.trim();
        const nextMode = mode && mode !== "authors_by_name" ? mode : "authors_by_name_and_title";
        return { title: safeTitle, author_name: authorName, mode: nextMode };
    }

    if (!hasSql && !hasTitle && !hasAuthorName) {
        if (safeTitle) {
            return safeName
                ? { title: safeTitle, author_name: safeName, mode: "authors_by_name_and_title" }
                : { title: safeTitle, mode: "authors_by_title_keyword" };
        }
        if (safeName) {
            return { author_name: safeName, mode: "authors_by_name" };
        }
        return args;
    }

    if (hasSql) {
        const sqlLower = args.sql.toLowerCase();
        const hasPapersCte = /\bwith\s+papers\s+as\b/.test(sqlLower);
        const usesUnknownPapersTable = /\bfrom\s+papers\b/.test(sqlLower) || /\bjoin\s+papers\b/.test(sqlLower);
        if (usesUnknownPapersTable && !hasPapersCte) {
            args = {
                ...args,
                sql: args.sql.replace(/\b(from|join)\s+papers\b/gi, "$1 sciscinet_papers")
            };
        }
        if (!hasTitle && usesUnknownPapersTable && safeTitle) {
            return safeName
                ? { title: safeTitle, author_name: safeName, mode: "authors_by_name_and_title" }
                : { title: safeTitle, mode: "authors_by_title_keyword" };
        }
    }
    return args;
}

function blockSqlToolCallIfUnauthorized(functionName: string, args: any, allowedAuthorIds: string[]): string | null {
    if (!allowedAuthorIds || allowedAuthorIds.length === 0) return null;
    if (!isSciSciNetToolName(functionName)) return null;
    if (isSciSciNetResolveMode(args)) return null;
    const sql = (args?.sql && typeof args.sql === "string") ? args.sql : "";
    if (!sql) return "Error: Missing SQL for author-scoped query.";
    const lowerSql = sql.toLowerCase();
    if (lowerSql.includes("information_schema") || lowerSql.includes("pg_catalog")) {
        return null;
    }
    if (lowerSql.includes("author_name")) {
        return "Error: Author is scoped to this paper. Query must use allowed authorid only (no author_name search).";
    }
    const needsAuthorScope = lowerSql.includes("sciscinet_authors") ||
        lowerSql.includes("sciscinet_paper_author_affiliation") ||
        lowerSql.includes("authorid");
    if (needsAuthorScope) {
        const hasAllowedId = allowedAuthorIds.some(id => lowerSql.includes(id.toLowerCase()));
        if (!hasAllowedId) {
            return `Error: Query must include one of the allowed authorid values for this paper: ${allowedAuthorIds.join(", ")}.`;
        }
    }
    return null;
}

function blockSciSciNetResolveAfterResolved(functionName: string, args: any, resolvedAuthorIds: string[]): string | null {
    if (!resolvedAuthorIds || resolvedAuthorIds.length === 0) return null;
    if (!isSciSciNetToolName(functionName)) return null;
    if (!isSciSciNetResolveMode(args)) return null;
    return "Error: Author already resolved. Use the resolved authorid for SQL queries (do not call author-resolve again).";
}

function blockSciSciNetAuthorWithoutTitle(functionName: string, args: any): string | null {
    if (!isSciSciNetToolName(functionName)) return null;
    if (!args || typeof args !== "object") return null;
    const hasAuthorName = typeof args.author_name === "string" && args.author_name.trim().length > 0;
    const hasTitle = typeof args.title === "string" && args.title.trim().length > 0;
    const hasSql = typeof args.sql === "string" && args.sql.trim().length > 0;
    const mode = (args.mode || "").toString().toLowerCase();
    if (hasSql) return null;
    if (mode === "authors_by_name" || (hasAuthorName && !hasTitle)) {
        return "Error: Author lookup must include the paper title. Use {author_name, title, mode:'authors_by_name_and_title'}.";
    }
    return null;
}

function extractAuthorIdsFromToolResult(resultText: string): string[] {
    if (!resultText || typeof resultText !== "string") return [];
    try {
        const parsed = JSON.parse(resultText);
        const rows = parsed?.rows;
        if (!Array.isArray(rows)) return [];
        const ids = rows
            .map((row: any) => row?.authorid)
            .filter((id: any) => id !== undefined && id !== null)
            .map((id: any) => String(id));
        return Array.from(new Set(ids));
    } catch (e) {
        return [];
    }
}

function buildAuthorPapersSql(authorId: string): string {
    const safeId = (authorId || "").replace(/'/g, "''");
    return `
SELECT
  paa.paperid,
  COALESCE(pd.title, pa.title) AS title,
  COALESCE(pd.year, p.year)::int AS year
FROM sciscinet_paper_author_affiliation paa
LEFT JOIN sciscinet_paperdetails pd ON pd.paperid = paa.paperid
LEFT JOIN sciscinet_papertitleabstract pa ON pa.paperid = paa.paperid
LEFT JOIN sciscinet_papers p ON p.paperid = paa.paperid
WHERE paa.authorid = '${safeId}'
ORDER BY year DESC NULLS LAST
LIMIT 30;
    `.trim();
}

function coerceResolveToSqlIfNeeded(functionName: string, args: any, resolvedAuthorIds: string[]): any {
    if (!resolvedAuthorIds || resolvedAuthorIds.length === 0) return args;
    if (!isSciSciNetToolName(functionName)) return args;
    if (!isSciSciNetResolveMode(args)) return args;
    return { sql: buildAuthorPapersSql(resolvedAuthorIds[0]) };
}

function blockSqlToolCallWithoutResolvedAuthor(functionName: string, args: any, allowedAuthorIds: string[]): string | null {
    if (!isSciSciNetToolName(functionName)) return null;
    if (allowedAuthorIds && allowedAuthorIds.length > 0) return null;
    if (isSciSciNetResolveMode(args)) return null;
    const sql = (args?.sql && typeof args.sql === "string") ? args.sql : "";
    if (!sql) return "Error: Missing SQL for author-scoped query.";
    const lowerSql = sql.toLowerCase();
    if (lowerSql.includes("information_schema") || lowerSql.includes("pg_catalog")) {
        return null;
    }
    const touchesAuthorOrPaper = lowerSql.includes("sciscinet_authors") ||
        lowerSql.includes("sciscinet_paper_author_affiliation") ||
        lowerSql.includes("sciscinet_papers") ||
        lowerSql.includes("sciscinet_paperdetails") ||
        lowerSql.includes("sciscinet_papertitleabstract") ||
        lowerSql.includes("sciscinet_paperfields") ||
        lowerSql.includes("sciscinet_affiliations");
    if (touchesAuthorOrPaper) {
        return "Error: No authorid resolved for the current paper. Do not perform author- or paper-level queries without resolved authorid from this paper.";
    }
    return null;
}

// Helper to sanitize strings for JSON/API safety
function sanitizeString(str: string): string {
    if (!str) return "";
    // Replace lone surrogates and other problematic chars
    // Try native toWellFormed if available (ES2024)
    if (typeof (String.prototype as any).toWellFormed === 'function') {
        return (str as any).toWellFormed();
    }
    // Manual fallback
    return str
        .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "\uFFFD")
        .replace(/([^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "$1\uFFFD")
        .replace(/^[\uDC00-\uDFFF]/g, "\uFFFD");
}

function getSciSciNetToolName(): string | null {
    if (toolToClientMap["sql_query"]) return "sql_query";
    if (toolToClientMap["sql.query"]) return "sql.query";
    return null;
}

function normalizeNameForMatch(name: string): string {
    return (name || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function extractLatinNameFromPrompt(prompt: string): string | null {
    if (!prompt) return null;
    const match = prompt.match(/[A-Za-z]+(?:[-'][A-Za-z]+)?\s+[A-Za-z]+(?:[-'][A-Za-z]+)?/);
    return match ? match[0].trim() : null;
}

function resolveAuthorCandidatesFromPrompt(
    prompt: string,
    candidates: Array<{ authorid: string; author_name: string }>
): Array<{ authorid: string; author_name: string }> {
    const promptNorm = normalizeNameForMatch(prompt);
    if (!promptNorm || candidates.length === 0) return [];
    return candidates.filter(candidate => {
        const nameNorm = normalizeNameForMatch(candidate.author_name);
        if (!nameNorm) return false;
        const tokens = nameNorm.split(" ").filter(t => t.length > 0);
        return tokens.every(token => promptNorm.includes(token));
    });
}

function findRequestedAuthorName(prompt: string, metadataItem: Zotero.Item): string | null {
    const promptNorm = normalizeNameForMatch(prompt);
    if (!promptNorm) return null;
    try {
        const creators = metadataItem.getCreators ? metadataItem.getCreators() : [];
        const authorNames = (creators || [])
            .map((c: any) => `${c.firstName || ""} ${c.lastName || ""}`.trim())
            .filter((n: string) => n.length > 0);

        for (const name of authorNames) {
            const nameNorm = normalizeNameForMatch(name);
            if (nameNorm && promptNorm.includes(nameNorm)) {
                return name;
            }
        }
    } catch (e) {
        Zotero.debug(`[AI for Science] Failed to read creators for author match: ${e}`);
    }
    return null;
}

function buildAuthorNameTokenFilters(authorName: string): string[] {
    const normalized = normalizeNameForMatch(authorName);
    if (!normalized) return [];
    return normalized.split(" ").filter(t => t.length > 0);
}

async function fetchSciSciNetAuthorsForTitle(title: string): Promise<Array<{ authorid: string; author_name: string }>> {
    const safeTitle = (title || "").trim();
    if (!safeTitle || safeTitle.length < 4) return [];
    const toolName = getSciSciNetToolName();
    if (!toolName || !selectedToolNames.has(toolName)) return [];

    try {
        const client = toolToClientMap[toolName];
        if (!client) return [];
        const res = await client.callTool(resolveToolNameForCall(toolName), {
            title: safeTitle,
            mode: "authors_by_title_keyword"
        });
        let rows: any[] = [];
        if (res && typeof res === "object" && Array.isArray((res as any).content)) {
            const textParts = (res as any).content
                .filter((item: any) => item?.type === "text" && item.text)
                .map((item: any) => item.text);
            const joined = textParts.join("\n\n");
            try {
                const parsed = JSON.parse(joined);
                if (parsed?.rows && Array.isArray(parsed.rows)) {
                    rows = parsed.rows;
                }
            } catch (e) {
                Zotero.debug(`[AI for Science] Failed to parse SciSciNet author candidates: ${e}`);
            }
        } else if ((res as any)?.rows && Array.isArray((res as any).rows)) {
            rows = (res as any).rows;
        }
        return rows
            .filter((r: any) => r?.authorid && r?.author_name)
            .map((r: any) => ({ authorid: String(r.authorid), author_name: String(r.author_name) }));
    } catch (e) {
        Zotero.debug(`[AI for Science] SciSciNet author lookup failed: ${e}`);
        return [];
    }
}

async function fetchSciSciNetAuthorsForTitleAndName(title: string, authorName: string): Promise<Array<{ authorid: string; author_name: string }>> {
    const safeTitle = (title || "").trim();
    const safeName = (authorName || "").trim();
    if (!safeTitle || safeTitle.length < 4 || !safeName) return [];
    const toolName = getSciSciNetToolName();
    if (!toolName || !selectedToolNames.has(toolName)) return [];

    try {
        const client = toolToClientMap[toolName];
        if (!client) return [];
        const res = await client.callTool(resolveToolNameForCall(toolName), {
            title: safeTitle,
            author_name: safeName,
            mode: "authors_by_name_and_title"
        });
        let rows: any[] = [];
        if (res && typeof res === "object" && Array.isArray((res as any).content)) {
            const textParts = (res as any).content
                .filter((item: any) => item?.type === "text" && item.text)
                .map((item: any) => item.text);
            const joined = textParts.join("\n\n");
            try {
                const parsed = JSON.parse(joined);
                if (parsed?.rows && Array.isArray(parsed.rows)) {
                    rows = parsed.rows;
                }
            } catch (e) {
                Zotero.debug(`[AI for Science] Failed to parse SciSciNet filtered authors: ${e}`);
            }
        } else if ((res as any)?.rows && Array.isArray((res as any).rows)) {
            rows = (res as any).rows;
        }
        return rows
            .filter((r: any) => r?.authorid && r?.author_name)
            .map((r: any) => ({ authorid: String(r.authorid), author_name: String(r.author_name) }));
    } catch (e) {
        Zotero.debug(`[AI for Science] SciSciNet filtered author lookup failed: ${e}`);
        return [];
    }
}

function resolveToolNameForCall(name: string): string {
    return toolNameToOriginalMap[name] || name;
}

// Streaming version of callLLM
async function callLLMStream(
    prompt: string,
    item: Zotero.Item,
    selectedText: string = "",
    mode: "ask" | "agent" = "ask",
    onChunk: (chunk: string) => void,
    abortSignal?: AbortSignal
) {
    // Sanitize inputs
    prompt = sanitizeString(prompt);
    selectedText = sanitizeString(selectedText);

    const prefsPrefix = addon.data.config.prefsPrefix;
    const provider = Zotero.Prefs.get(`${prefsPrefix}.provider`) as string;

    // Check if item is attachment and get parent if possible for metadata
    let metadataItem = item;
    if (item.isAttachment() && item.parentItem) {
        // @ts-ignore
        metadataItem = item.parentItem;
    }

    // Get title from PDF, fall back to Zotero metadata title
    const title = sanitizeString(await getPDFTitle(metadataItem) || metadataItem.getField("title") || "");
    const abstract = sanitizeString(metadataItem.getField("abstractNote"));

    let context = `Context: You are discussing the paper titled "${title}".\n`;
    let enforcedAuthorIds: string[] = [];
    let requestedAuthorName: string | null = null;

    // If SciSciNet tool is active, pre-fetch candidate authors for this paper title
    if (mode === "agent") {
        const authorCandidates = await fetchSciSciNetAuthorsForTitle(title);
        if (authorCandidates.length > 0) {
            const authorsList = authorCandidates
                .map(a => `- ${a.author_name} (authorid: ${a.authorid})`)
                .join("\n");
            context += `\n[Paper author candidates from SciSciNet]\nTitle: ${title}\n${authorsList}\n\n` +
                "Use only the author IDs listed above when the user asks about an author from this paper.\n\n";
        } else {
            context += `\n[Paper author candidates from SciSciNet]\nTitle: ${title}\n(No matching authors found for this title)\n\n` +
                "Do NOT perform author- or paper-level queries without resolved authorid from this paper.\n\n";
        }

        requestedAuthorName = findRequestedAuthorName(prompt, metadataItem) || extractLatinNameFromPrompt(prompt);
        if (requestedAuthorName) {
            const requestedName = requestedAuthorName;
            let resolved = authorCandidates.filter(a =>
                normalizeNameForMatch(a.author_name).includes(normalizeNameForMatch(requestedName))
            );
            if (resolved.length === 0) {
                resolved = await fetchSciSciNetAuthorsForTitleAndName(title, requestedName);
            }
            if (resolved.length > 0) {
                const resolvedList = resolved
                    .map(a => `- ${a.author_name} (authorid: ${a.authorid})`)
                    .join("\n");
                enforcedAuthorIds = resolved.map(a => a.authorid);
                context += `\n[Resolved Author For This Paper]\nRequested name: ${requestedName}\n${resolvedList}\n\n` +
                    "You MUST use ONLY these authorid values for subsequent queries and MUST NOT search by author_name.\n\n";
            } else {
                context += `\n[Resolved Author For This Paper]\nRequested name: ${requestedName}\n(No matching authorid resolved from this paper)\n\n` +
                    "Do NOT perform author- or paper-level queries without resolved authorid from this paper.\n\n";
            }
        } else if (authorCandidates.length > 0) {
            const resolvedFromPrompt = resolveAuthorCandidatesFromPrompt(prompt, authorCandidates);
            if (resolvedFromPrompt.length > 0) {
                const resolvedList = resolvedFromPrompt
                    .map(a => `- ${a.author_name} (authorid: ${a.authorid})`)
                    .join("\n");
                const uniqueNames = Array.from(new Set(resolvedFromPrompt.map(a => a.author_name)));
                const requestedLabel = uniqueNames.length === 1
                    ? uniqueNames[0]
                    : "matched from user prompt";
                enforcedAuthorIds = resolvedFromPrompt.map(a => a.authorid);
                context += `\n[Resolved Author For This Paper]\nRequested name: ${requestedLabel}\n${resolvedList}\n\n` +
                    "You MUST use ONLY these authorid values for subsequent queries and MUST NOT search by author_name.\n\n";
            } else {
                enforcedAuthorIds = authorCandidates.map(a => a.authorid);
            }
        }
    }

    if (selectedText) {
        // Check if this is an explanation request
        const isExplanationRequest = prompt.toLowerCase().includes("解释") ||
            prompt.toLowerCase().includes("explain") ||
            prompt.toLowerCase().includes("这段") ||
            prompt.toLowerCase().includes("选中");

        if (isExplanationRequest) {
            // For explanation requests, clearly distinguish selected text from context
            // Put selected text first and emphasize it's what needs to be explained
            context += `\n\n[SELECTED TEXT TO EXPLAIN]\n"${selectedText}"\n\n[PAPER CONTEXT - USE FOR UNDERSTANDING ONLY, DO NOT EXPLAIN THIS]\n`;
        } else {
            // For other requests, use the original format
            context += `\nUser selected text from the paper: "${selectedText}"\n\nPlease answer the user's question based on this selected text and the paper's context.\n`;
        }
    }

    try {
        const rawPdfText = await getPDFText(item);
        const pdfText = sanitizeString(rawPdfText);

        // Check if PDF is open and warn if not
        await checkAndWarnPDFNotOpen(item, pdfText);

        if (pdfText && pdfText.length > 100) {
            Zotero.debug(`[AI for Science] PDF text length: ${pdfText.length}`);

            // RAG Logic: If text is long, retrieve relevant chunks
            // Threshold: 15000 characters (approx 3-4k tokens)
            if (pdfText.length > 15000) {
                Zotero.debug("[AI for Science] Using RAG for long document.");
                const rawRelevantText = await RAGEngine.getRelevantContext(prompt, item, pdfText);
                const relevantText = sanitizeString(rawRelevantText);
                context += `Relevant excerpts from the paper:\n${relevantText}\n\n`;
            } else {
                context += `Full Text: ${pdfText}\n\n`;
            }
        } else {
            context += `Abstract: ${abstract}\n\n`;
            if (!pdfText) {
                context += `(Note: Full text PDF could not be read. Using abstract only.)\n`;
            }
        }
    } catch (e) {
        Zotero.log("Failed to read PDF text: " + e);
        context += `Abstract: ${abstract}\n\n`;
        // Also check and warn if PDF is not open when there's an error
        try {
            await checkAndWarnPDFNotOpen(item, "");
        } catch (warnError) {
            Zotero.debug(`[AI for Science] Error checking PDF status: ${warnError}`);
        }
    }

    // Prepare active tools based on user selection (only in agent mode)
    const toolsToSend = mode === "agent"
        ? activeMCPTools.filter(t => selectedToolNames.has(t.function.name))
        : [];
    const enforceSciSciNetHtmlOnly = toolsToSend.some((tool: any) =>
        tool?.function?.name === "sql_query" || tool?.function?.name === "sql.query"
    );

    // Prepare Messages
    let systemPrompt = "You are a helpful academic research assistant. Please format your responses using Markdown. Use **bold** for key terms, lists for bullet points, and code blocks for technical details or code. Keep your responses structured, professional, and easy to read.";

    // Check if this is an explanation request and add special instruction to system prompt
    if (selectedText) {
        const isExplanationRequest = prompt.toLowerCase().includes("解释") ||
            prompt.toLowerCase().includes("explain") ||
            prompt.toLowerCase().includes("这段") ||
            prompt.toLowerCase().includes("选中") ||
            prompt.includes("这一段讲了什么") ||
            prompt.includes("这一段讲了");
        if (isExplanationRequest) {
            systemPrompt += "\n\n**CRITICAL INSTRUCTION FOR EXPLANATION REQUESTS:**\nWhen the user asks you to explain selected text (e.g., '这一段讲了什么'), you MUST:\n1. Use ALL the paper context provided below to FULLY UNDERSTAND the selected text\n2. Consider the context, background, and surrounding information to grasp the meaning\n3. However, in your explanation, ONLY explain the SELECTED TEXT portion itself\n4. Do NOT explain or summarize the context portions - they are only for your understanding\n5. Focus your explanation entirely on what the selected text says, using your understanding from the context\n\nThe context is your reference material for understanding, but your explanation should be about the selected text only.";
        }
    }

    // In agent mode, add instruction to output task breakdown and progress
    const hasSciSciNetToolInMode = toolsToSend.some((tool: any) =>
        tool?.function?.name === "sql_query" || tool?.function?.name === "sql.query"
    );
    if (mode === "agent" && !hasSciSciNetToolInMode) {
        // CRITICAL: Always output task breakdown in agent mode, especially when using tools
        if (toolsToSend.length > 0) {
            systemPrompt += "\n\n**CRITICAL REQUIREMENT - TASK BREAKDOWN IS MANDATORY:**\nWhen working in agent mode with access to tools, you MUST:\n1. **ALWAYS start by creating a task breakdown** - Before doing anything else, break down the task into a clear task list with checkboxes\n2. **Show your progress** - As you complete each task, update the task list with checkmarks\n3. **Use this exact format:**\n\n## Task Breakdown\n- [ ] Task 1: Description\n- [ ] Task 2: Description\n- [✓] Task 3: Completed task (use [✓] for completed)\n\n## Progress\n- ✓ Task 3 completed\n- Working on Task 1...\n\n**This is mandatory - always output the task breakdown first, even for simple tasks.**";
        } else {
            systemPrompt += "\n\nWhen working on complex tasks, you should:\n1. First, break down the task into a clear task list with checkboxes\n2. Show your progress as you complete each task\n3. Update the task list with checkmarks (✓) as you finish each item\n4. Use this format:\n\n## Task Breakdown\n- [ ] Task 1: Description\n- [ ] Task 2: Description\n- [✓] Task 3: Completed task (use [✓] for completed)\n\n## Progress\n- ✓ Task 3 completed\n- Working on Task 1...\n\nThis helps users understand what you're doing and track your progress.";
        }

        // Add instruction about selective tool usage
        if (toolsToSend.length > 0) {
            systemPrompt += "\n\n**IMPORTANT: Tool Usage Guidelines**\nYou have access to tools that can help you answer questions. Use them appropriately:\n\n- **USE tools when:**\n  * The user asks for information NOT in the provided paper context (e.g., 'get author's recent papers', 'find similar papers', 'search for author information')\n  * The user explicitly requests an action that requires external data or computation\n  * You need to retrieve information from external sources (DBLP, OpenAlex, etc.)\n\n- **Do NOT use tools when:**\n  * The question can be answered directly from the paper content provided (e.g., 'summarize this paper', 'explain this section', 'what is the main contribution')\n  * The user is asking for explanations, summaries, or analysis of the CURRENT paper's content\n  * The question is about the paper that is already in the context\n\n**Key principle:** If the answer is in the provided paper context, answer directly. If the answer requires external information, use tools.";

            // Check if execute_query tool (HelmDB) is available and add specific instructions
            const hasHelmDBTool = toolsToSend.some((tool: any) => tool.function.name === "execute_query");
            if (hasHelmDBTool) {
                systemPrompt += HELMDB_PROMPT; //HELMDB_PROMPT
            }

            const hasSciSciNetTool = toolsToSend.some((tool: any) =>
                tool?.function?.name === "sql_query" || tool?.function?.name === "sql.query"
            );
            if (hasSciSciNetTool) {
                systemPrompt += `\n\n${SCISCINET_HTML_PROMPT}`;
            }

        }
    }

    systemPrompt = systemPrompt.replace("工具 sql_query 查询", "工具 sql.query（或 sql_query）查询");

    systemPrompt = systemPrompt.replace("工具 sql_query 查询", "工具 sql.query（或 sql_query）查询");

    const userContent = truncateForModel(context + prompt, MAX_USER_CONTENT_CHARS, "context");
    const messages: any[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent }
    ];

    try {
        if (provider === "Gemini") {
            // Gemini API with tool support
            const apiKey = Zotero.Prefs.get(`${prefsPrefix}.geminiApiKey`) as string;
            const model = Zotero.Prefs.get(`${prefsPrefix}.geminiModel`) as string;
            const baseUrl = "https://generativelanguage.googleapis.com/v1beta/models";

            if (!apiKey) throw new Error("Please set API Key for Gemini.");

            // Loop for tool calls (no hard limit) - only in agent mode
            const maxTurns = mode === "agent" ? Number.POSITIVE_INFINITY : 1;
            for (let turn = 0; turn < maxTurns; turn++) {
                // Check abort signal
                if (abortSignal?.aborted) {
                    throw new Error("Request aborted by user");
                }

                // Convert messages to Gemini format
                const geminiContents: any[] = [];

                // Add system prompt as first user message
                if (systemPrompt) {
                    geminiContents.push({
                        role: "user",
                        parts: [{ text: systemPrompt }]
                    });
                    geminiContents.push({
                        role: "model",
                        parts: [{ text: "I understand. I will follow these instructions." }]
                    });
                }

                // Convert remaining messages
                for (const msg of messages) {
                    if (msg.role === "system") continue; // Already handled

                    if (msg.role === "user") {
                        geminiContents.push({
                            role: "user",
                            parts: [{ text: msg.content }]
                        });
                    } else if (msg.role === "assistant") {
                        geminiContents.push({
                            role: "model",
                            parts: msg.tool_calls ? [
                                { text: msg.content || "" },
                                ...msg.tool_calls.map((tc: any) => ({
                                    functionCall: {
                                        name: tc.function.name,
                                        args: JSON.parse(tc.function.arguments || "{}")
                                    }
                                }))
                            ] : [{ text: msg.content || "" }]
                        });
                    } else if (msg.role === "tool") {
                        geminiContents.push({
                            role: "function",
                            parts: [{
                                functionResponse: {
                                    name: msg.tool_call_id,
                                    response: { result: msg.content }
                                }
                            }]
                        });
                    }
                }

                const url = `${baseUrl}/${model}:generateContent?key=${apiKey}`;
                const requestBody: any = {
                    contents: geminiContents
                };

                // Add tools if available and in agent mode
                if (toolsToSend.length > 0 && mode === "agent") {
                    requestBody.tools = [{
                        functionDeclarations: toolsToSend.map((tool: any) => ({
                            name: tool.function.name,
                            description: tool.function.description,
                            parameters: tool.function.parameters
                        }))
                    }];
                }

                const response = await Zotero.HTTP.request("POST", url, {
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(requestBody),
                    responseType: "json",
                    timeout: 120000
                });

                if (response.status !== 200 || !response.response) {
                    throw new Error(`API Error ${response.status}: ${JSON.stringify(response.response)}`);
                }

                const data = response.response;
                if (!data.candidates || data.candidates.length === 0) {
                    throw new Error("No response candidates from Gemini API.");
                }

                const candidate = data.candidates[0];
                const content = candidate.content;

                if (!content || !content.parts) {
                    throw new Error("Invalid response format from Gemini API.");
                }

                // Check for tool calls
                const toolCalls: any[] = [];
                let responseText = "";

                for (const part of content.parts) {
                    if (part.text) {
                        responseText += part.text;
                    }
                    if (part.functionCall) {
                        toolCalls.push({
                            id: `call_${Date.now()}_${toolCalls.length}`,
                            type: "function",
                            function: {
                                name: part.functionCall.name,
                                arguments: JSON.stringify(part.functionCall.args || {})
                            }
                        });
                    }
                }

                // Stream the response text
                if (responseText) {
                    for (let i = 0; i < responseText.length; i += 5) {
                        if (abortSignal?.aborted) break;
                        onChunk(responseText.substring(i, Math.min(i + 5, responseText.length)));
                        await new Promise(resolve => setTimeout(resolve, 20));
                    }
                }

                // Add assistant message to history
                const assistantMessage: any = {
                    role: "assistant",
                    content: responseText || null
                };
                if (toolCalls.length > 0) {
                    assistantMessage.tool_calls = toolCalls;
                }
                messages.push(assistantMessage);

                // Handle tool calls if any
                if (toolCalls.length > 0 && mode === "agent") {
                    Zotero.debug(`[AI for Science] Tool calls detected in Gemini: ${toolCalls.length} tools`);

                    // Show tool call info
                    if (responseText) {
                        onChunk(`\n\n*正在调用工具: ${toolCalls.map(tc => tc.function.name).join(", ")}...*\n\n`);
                    } else {
                        onChunk(`*正在调用工具: ${toolCalls.map(tc => tc.function.name).join(", ")}...*\n\n`);
                    }

                    // Execute tool calls
                    for (const toolCall of toolCalls) {
                        const functionName = toolCall.function.name;
                        const argsString = toolCall.function.arguments;
                        let args = {};
                        try {
                            args = JSON.parse(argsString);
                        } catch (e) {
                            Zotero.debug("[AI for Science] Failed to parse tool arguments: " + e);
                        }

                        Zotero.debug(`[AI for Science] Calling tool: ${functionName}`);

                        let result = "";
                        try {
                            args = normalizeSciSciNetToolArgs(functionName, args, title, requestedAuthorName);
                            args = coerceResolveToSqlIfNeeded(functionName, args, enforcedAuthorIds);
                            const guardError = blockSciSciNetAuthorWithoutTitle(functionName, args) ||
                                blockSqlToolCallWithoutResolvedAuthor(functionName, args, enforcedAuthorIds) ||
                                blockSqlToolCallIfUnauthorized(functionName, args, enforcedAuthorIds);
                            if (guardError) {
                                result = guardError;
                            } else {
                                const client = toolToClientMap[functionName];
                                if (client) {
                                    const res = await client.callTool(resolveToolNameForCall(functionName), args);
                                    // MCP tools return result in format: {content: [{type: "text", text: "..."}]}
                                    if (res && typeof res === 'object' && res.content && Array.isArray(res.content)) {
                                        const textParts = res.content
                                            .filter((item: any) => item.type === "text" && item.text)
                                            .map((item: any) => item.text);
                                        result = textParts.join("\n\n");
                                    } else {
                                        result = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
                                    }
                                } else {
                                    result = "Error: Tool not found or client not connected.";
                                }
                            }
                        } catch (e) {
                            result = `Error executing tool: ${e}`;
                        }

                        const modelResult = truncateForModel(result, MAX_TOOL_RESULT_CHARS, "tool result");
                        emitToolResult(onChunk, functionName, modelResult);
                        messages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            content: modelResult
                        });
                    }
                    if (enforceSciSciNetHtmlOnly) {
                        messages.push({
                            role: "user",
                            content: SCISCINET_HTML_ONLY_INSTRUCTION
                        });
                    }
                    // Continue loop to send tool results back
                } else {
                    // Final response
                    return;
                }
            }
        } else if (provider === "Claude") {
            // Claude uses a different API format
            const baseUrl = Zotero.Prefs.get(`${prefsPrefix}.claudeBaseUrl`) as string || "https://api.anthropic.com/v1";
            const apiKey = Zotero.Prefs.get(`${prefsPrefix}.claudeApiKey`) as string;
            const model = Zotero.Prefs.get(`${prefsPrefix}.claudeModel`) as string;

            if (!apiKey) throw new Error("Please set API Key for Claude.");

            const endpoint = `${baseUrl}/messages`.replace(/([^:]\/)\/+/g, "$1");

            // Claude doesn't support streaming in the same way, so we'll simulate it
            const response = await Zotero.HTTP.request("POST", endpoint, {
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": apiKey,
                    "anthropic-version": "2023-06-01"
                },
                body: JSON.stringify({
                    model: model,
                    max_tokens: 4096,
                    messages: messages.filter(m => m.role !== "system").map(m => ({
                        role: m.role === "system" ? "user" : m.role,
                        content: m.role === "system" ? systemPrompt + "\n\n" + m.content : m.content
                    }))
                }),
                responseType: "json",
                timeout: 120000
            });

            if (response.status === 200 && response.response) {
                const data = response.response;
                if (data.content && data.content.length > 0) {
                    const text = data.content[0].text;
                    // Simulate streaming for Claude
                    for (let i = 0; i < text.length; i += 5) {
                        onChunk(text.substring(i, Math.min(i + 5, text.length)));
                        await new Promise(resolve => setTimeout(resolve, 20));
                    }
                    return;
                }
            }
            throw new Error(`API Error ${response.status}: ${JSON.stringify(response.response)}`);

        } else {
            // OpenAI Compatible Streaming
            let baseUrl = Zotero.Prefs.get(`${prefsPrefix}.openaiBaseUrl`) as string;
            let apiKey = Zotero.Prefs.get(`${prefsPrefix}.openaiApiKey`) as string;
            let model = Zotero.Prefs.get(`${prefsPrefix}.openaiModel`) as string;

            if (provider === "DeepSeek") {
                baseUrl = Zotero.Prefs.get(`${prefsPrefix}.deepseekBaseUrl`) as string;
                apiKey = Zotero.Prefs.get(`${prefsPrefix}.deepseekApiKey`) as string;
                model = Zotero.Prefs.get(`${prefsPrefix}.deepseekModel`) as string;
            } else if (provider === "Custom") {
                baseUrl = Zotero.Prefs.get(`${prefsPrefix}.customBaseUrl`) as string;
                apiKey = Zotero.Prefs.get(`${prefsPrefix}.customApiKey`) as string;
                model = Zotero.Prefs.get(`${prefsPrefix}.customModel`) as string;
            }

            if (!apiKey) throw new Error(`Please set API Key for ${provider}.`);

            let endpoint = `${baseUrl}/chat/completions`;
            endpoint = endpoint.replace(/([^:]\/)\/+/g, "$1");

            // Check if this is a reasoning model that requires reasoning_content field
            const isReasoningModel = provider === "DeepSeek" &&
                (model.includes("reasoner") || model.includes("r1") || model.includes("R1"));

            // For DeepSeek Reasoner models, add stricter tool usage instructions
            // Reasoner models tend to call tools more aggressively, so we need stricter control
            if (isReasoningModel && mode === "agent") {
                systemPrompt += "\n\n**CRITICAL FOR REASONER MODELS - TOOL USAGE RULES:**\nYou are a reasoning model with access to tools. However, you MUST follow these strict rules:\n\n1. **DO NOT call tools automatically** - Only call tools when the user EXPLICITLY requests an action that requires tools\n2. **Answer from context first** - If the question can be answered from the provided paper context, answer directly WITHOUT calling any tools\n3. **Explicit tool requests only** - Only call tools when the user explicitly asks you to:\n   - Perform a calculation or computation\n   - Retrieve external information not in the paper\n   - Execute a specific action that requires a tool\n4. **For questions about the paper** - If the user asks about the paper content, explanations, summaries, or analysis, answer directly from the context WITHOUT calling tools\n5. **Think before calling** - Before calling any tool, ask yourself: \"Can I answer this from the paper context?\" If yes, do NOT call tools\n\n**Remember: When in doubt, answer from context. Only use tools when absolutely necessary and explicitly requested.**";
            }

            // Loop for tool calls (no hard limit) - only in agent mode
            const maxTurns = mode === "agent" ? Number.POSITIVE_INFINITY : 1;
            for (let turn = 0; turn < maxTurns; turn++) {
                // Check abort signal
                if (abortSignal?.aborted) {
                    throw new Error("Request aborted by user");
                }
                // For DeepSeek Reasoner/R1 models, prepare messages for next request
                // According to DeepSeek docs: remove reasoning_content from previous messages,
                // BUT if assistant message has tool_calls, it MUST have reasoning_content field
                if (isReasoningModel && turn > 0) {
                    messages.forEach((msg: any) => {
                        if (msg.role === "assistant") {
                            // If message has tool_calls, ensure it has reasoning_content (even if empty)
                            if (msg.tool_calls && msg.tool_calls.length > 0) {
                                if (!msg.hasOwnProperty("reasoning_content")) {
                                    msg.reasoning_content = "";
                                }
                            } else {
                                // If message doesn't have tool_calls, remove reasoning_content
                                if (msg.hasOwnProperty("reasoning_content")) {
                                    delete msg.reasoning_content;
                                }
                            }
                        }
                    });
                }

                const body: any = {
                    model: model,
                    messages: messages,
                    stream: true  // Enable streaming
                };

                if (toolsToSend.length > 0 && mode === "agent") {
                    body.tools = toolsToSend;
                    // For DeepSeek Reasoner models, we keep "auto" but rely on stricter system prompts
                    // to control tool usage. The system prompt will guide the model to only use tools
                    // when explicitly needed, preventing chaotic tool calls.
                    body.tool_choice = "auto";
                }

                // Use Zotero.HTTP.request with requestObserver for streaming
                let fullContent = "";
                let hasToolCalls = false;
                let toolCalls: any[] = [];
                let reasoningContent = ""; // For DeepSeek Reasoner/R1 models
                let processedLength = 0; // Track how much we've processed

                try {
                    // Check abort signal before making request
                    if (abortSignal?.aborted) {
                        throw new Error("Request aborted by user");
                    }

                    await Zotero.HTTP.request("POST", endpoint, {
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": `Bearer ${apiKey}`
                        },
                        body: JSON.stringify(body),
                        responseType: "text",
                        timeout: 120000,
                        requestObserver: (xmlhttp: XMLHttpRequest) => {
                            xmlhttp.onprogress = (e: any) => {
                                // Check abort signal at the start of each progress event
                                if (abortSignal?.aborted) {
                                    try {
                                        xmlhttp.abort();
                                    } catch (abortError) {
                                        // Ignore abort errors
                                    }
                                    return;
                                }
                                try {
                                    const response = e.target.response;
                                    if (!response || response.length <= processedLength) return;

                                    // Only process new data
                                    const newData = response.substring(processedLength);
                                    processedLength = response.length;

                                    // Process streaming data
                                    const lines = newData.split("\n");
                                    for (const line of lines) {
                                        if (line.trim() === "") continue;
                                        if (line.startsWith("data: ")) {
                                            const data = line.slice(6);
                                            if (data === "[DONE]") continue;

                                            try {
                                                const json = JSON.parse(data);
                                                const delta = json.choices?.[0]?.delta;
                                                if (!delta) continue;

                                                // Check for tool calls
                                                if (delta.tool_calls) {
                                                    hasToolCalls = true;
                                                    delta.tool_calls.forEach((tc: any, idx: number) => {
                                                        if (!toolCalls[idx]) {
                                                            toolCalls[idx] = {
                                                                id: "",
                                                                type: "function", // API required field
                                                                function: { name: "", arguments: "" }
                                                            };
                                                        }
                                                        if (tc.id) toolCalls[idx].id = tc.id;
                                                        if (tc.function?.name) toolCalls[idx].function.name = tc.function.name;
                                                        if (tc.function?.arguments) {
                                                            toolCalls[idx].function.arguments += tc.function.arguments;
                                                        }
                                                    });
                                                }

                                                // Handle reasoning_content for DeepSeek Reasoner/R1 models
                                                if (delta.reasoning_content) {
                                                    reasoningContent += delta.reasoning_content;
                                                }

                                                // Handle content streaming
                                                if (delta.content) {
                                                    // No extra abort check here to ensure data is passed through
                                                    fullContent += delta.content;
                                                    onChunk(delta.content);
                                                }
                                            } catch (e) {
                                                // Skip invalid JSON
                                            }
                                        }
                                    }
                                } catch (e) {
                                    Zotero.debug("[AI for Science] Error processing stream: " + e);
                                }
                                // Reset timeout on progress
                                if (e.target.timeout) {
                                    e.target.timeout = 0;
                                }
                            };
                        }
                    });
                } catch (error: any) {
                    // Check if it's an HTTP error
                    if (error.xmlhttp) {
                        const status = error.xmlhttp.status;
                        const responseText = error.xmlhttp.responseText || error.xmlhttp.response;
                        throw new Error(`API Error ${status}: ${responseText}`);
                    }
                    throw error;
                }

                // Add assistant message to history
                const assistantMessage: any = {
                    role: "assistant",
                    type: "assistant",
                    content: fullContent || null // Use null if empty for DeepSeek compatibility
                };
                if (hasToolCalls && toolCalls.length > 0) {
                    assistantMessage.tool_calls = toolCalls;
                    // DeepSeek Reasoner/R1 models REQUIRE reasoning_content field when using tool calls
                    // This field is mandatory, even if empty
                    if (isReasoningModel) {
                        assistantMessage.reasoning_content = reasoningContent || "";
                    }
                } else if (isReasoningModel) {
                    // For reasoning models without tool_calls, don't include reasoning_content
                    // (it will be removed in next turn if needed)
                }
                messages.push(assistantMessage);

                if (hasToolCalls && toolCalls.length > 0 && mode === "agent") {
                    Zotero.debug(`[AI for Science] Tool calls received: ${toolCalls.length}`);

                    // Show tool call info in the message
                    if (fullContent) {
                        // If there's already content, append tool call info
                        onChunk(`\n\n*正在调用工具: ${toolCalls.map(tc => tc.function.name).join(", ")}...*\n\n`);
                    } else {
                        // If no content yet, show tool call info
                        onChunk(`*正在调用工具: ${toolCalls.map(tc => tc.function.name).join(", ")}...*\n\n`);
                    }

                    for (const toolCall of toolCalls) {
                        const functionName = toolCall.function.name;
                        const argsString = toolCall.function.arguments;
                        let args = {};
                        try {
                            args = JSON.parse(argsString);
                        } catch (e) {
                            Zotero.debug("[AI for Science] Failed to parse tool arguments: " + e);
                        }

                        Zotero.debug(`[AI for Science] Calling tool: ${functionName}`);

                        let result = "";
                        try {
                            args = normalizeSciSciNetToolArgs(functionName, args, title, requestedAuthorName);
                            args = coerceResolveToSqlIfNeeded(functionName, args, enforcedAuthorIds);
                            const guardError = blockSciSciNetAuthorWithoutTitle(functionName, args) ||
                                blockSqlToolCallWithoutResolvedAuthor(functionName, args, enforcedAuthorIds) ||
                                blockSqlToolCallIfUnauthorized(functionName, args, enforcedAuthorIds);
                            if (guardError) {
                                result = guardError;
                            } else {
                                const client = toolToClientMap[functionName];
                                if (client) {
                                    const res = await client.callTool(resolveToolNameForCall(functionName), args);
                                    // MCP tools return result in format: {content: [{type: "text", text: "..."}]}
                                    if (res && typeof res === 'object' && res.content && Array.isArray(res.content)) {
                                        // Extract text from content array
                                        const textParts = res.content
                                            .filter((item: any) => item.type === "text" && item.text)
                                            .map((item: any) => item.text);
                                        result = textParts.join("\n\n");
                                    } else {
                                        result = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
                                    }
                                } else {
                                    result = "Error: Tool not found or client not connected.";
                                }
                            }
                        } catch (e) {
                            result = `Error executing tool: ${e}`;
                        }

                        const modelResult = truncateForModel(result, MAX_TOOL_RESULT_CHARS, "tool result");
                        emitToolResult(onChunk, functionName, modelResult);
                        messages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            content: modelResult
                        });
                    }
                    if (enforceSciSciNetHtmlOnly) {
                        messages.push({
                            role: "user",
                            content: SCISCINET_HTML_ONLY_INSTRUCTION
                        });
                    }
                    // Continue loop to send tool results back to LLM (will stream the final response)
                } else {
                    // Final response - streaming is complete
                    return;
                }
            }
        }
    } finally {
        // Do not close clients here anymore, as they are managed globally for the session
    }
}

// Streaming version for paper groups
async function callLLMStreamForGroup(
    prompt: string,
    items: Zotero.Item[],
    selectedText: string = "",
    mode: "ask" | "agent" = "ask",
    onChunk: (chunk: string) => void,
    abortSignal?: AbortSignal
) {
    // Sanitize inputs
    prompt = sanitizeString(prompt);
    selectedText = sanitizeString(selectedText);

    const prefsPrefix = addon.data.config.prefsPrefix;
    const provider = Zotero.Prefs.get(`${prefsPrefix}.provider`) as string;

    // Build context for multiple papers
    // Note: This context is provided for understanding only, not for summarizing
    let context = `[PAPER CONTEXT - FOR YOUR UNDERSTANDING ONLY]\nThe user has provided context from ${items.length} papers below. Use this context to understand the background, but focus your response on answering the user's specific question.\n\n`;

    // First pass: collect all PDF texts and calculate total length
    const paperData: Array<{
        item: Zotero.Item;
        metadataItem: Zotero.Item;
        title: string;
        abstract: string;
        authors: string;
        pdfText: string;
        pdfTextLength: number;
    }> = [];

    let totalTextLength = 0;

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        let metadataItem = item;
        if (item.isAttachment() && item.parentItem) {
            // @ts-ignore
            metadataItem = item.parentItem;
        }

        // Get title from PDF, fall back to Zotero metadata title
        const title = sanitizeString(await getPDFTitle(metadataItem) || metadataItem.getField("title") || "Untitled");
        const abstract = sanitizeString(metadataItem.getField("abstractNote") || "");
        const authors = metadataItem.getCreators().map((c: any) => `${c.firstName || ""} ${c.lastName || ""}`).join(", ");

        let pdfText = "";
        let pdfTextLength = 0;

        try {
            const rawPdfText = await getPDFText(item);
            pdfText = sanitizeString(rawPdfText);
            if (pdfText && pdfText.length > 100) {
                pdfTextLength = pdfText.length;
                totalTextLength += pdfTextLength;
            }
        } catch (e) {
            Zotero.log(`Failed to read PDF text for paper ${i + 1}: ${e}`);
        }

        paperData.push({
            item,
            metadataItem,
            title,
            abstract,
            authors,
            pdfText,
            pdfTextLength
        });
    }

    // Determine if we should use RAG for the group
    // Use RAG if: 
    // 1. Total length exceeds threshold (30000 chars for groups, more lenient than single paper)
    // 2. OR any single paper exceeds 15000 chars
    const GROUP_RAG_THRESHOLD = 30000; // Total length threshold for groups
    const SINGLE_PAPER_RAG_THRESHOLD = 15000; // Single paper threshold
    const shouldUseRAGForGroup = totalTextLength > GROUP_RAG_THRESHOLD ||
        paperData.some(p => p.pdfTextLength > SINGLE_PAPER_RAG_THRESHOLD);

    // Second pass: build context for each paper
    const paperContexts: string[] = [];
    for (let i = 0; i < paperData.length; i++) {
        const data = paperData[i];
        let paperContext = `\n[PAPER ${i + 1} of ${items.length}]\n`;
        paperContext += `Title: ${data.title}\n`;
        if (data.authors) paperContext += `Authors: ${data.authors}\n`;
        if (data.abstract) paperContext += `Abstract: ${data.abstract}\n`;

        if (data.pdfText && data.pdfTextLength > 100) {
            // For groups: use RAG if group total is long OR this paper is long
            if (shouldUseRAGForGroup) {
                const rawRelevantText = await RAGEngine.getRelevantContext(prompt, data.item, data.pdfText);
                const relevantText = sanitizeString(rawRelevantText);
                paperContext += `Relevant excerpts:\n${relevantText}\n`;
            } else {
                paperContext += `Full Text: ${data.pdfText}\n`;
            }
        } else if (data.abstract) {
            paperContext += `(Note: Full text PDF could not be read. Using abstract only.)\n`;
        }

        paperContexts.push(paperContext);
    }

    const primaryPaper = paperData[0];
    const primaryTitle = primaryPaper?.title || "";
    const primaryMetadataItem = primaryPaper?.metadataItem;
    const requestedAuthorName = primaryMetadataItem
        ? (findRequestedAuthorName(prompt, primaryMetadataItem) || extractLatinNameFromPrompt(prompt))
        : extractLatinNameFromPrompt(prompt);
    let resolvedAuthorIds: string[] = [];

    context += paperContexts.join("\n---\n");

    if (selectedText) {
        const isExplanationRequest = prompt.toLowerCase().includes("解释") ||
            prompt.toLowerCase().includes("explain") ||
            prompt.toLowerCase().includes("这段") ||
            prompt.toLowerCase().includes("选中");

        if (isExplanationRequest) {
            context += `\n\n[SELECTED TEXT TO EXPLAIN]\n"${selectedText}"\n\n`;
        } else {
            context += `\n\nUser selected text: "${selectedText}"\n\n`;
        }
    }

    // Prepare active tools
    const toolsToSend = mode === "agent"
        ? activeMCPTools.filter(t => selectedToolNames.has(t.function.name))
        : [];
    const enforceSciSciNetHtmlOnly = toolsToSend.some((tool: any) =>
        tool?.function?.name === "sql_query" || tool?.function?.name === "sql.query"
    );

    // Prepare Messages
    let systemPrompt = `You are a helpful academic research assistant. The user will provide context from ${items.length} papers below, but you should focus on answering the user's specific question.

**IMPORTANT INSTRUCTIONS:**
1. The paper contexts provided below are ONLY for your understanding and reference
2. Your response should focus directly on answering the user's question
3. Use the paper contexts to understand the background, but do NOT summarize or explain the contexts themselves
4. Only reference specific papers when directly relevant to answering the user's question
5. Keep your response concise and focused on what the user asked

Please format your responses using Markdown. Use **bold** for key terms, lists for bullet points, and code blocks for technical details. Keep your responses structured, professional, and easy to read.`;

    if (mode === "agent" && !enforceSciSciNetHtmlOnly) {
        // CRITICAL: Always output task breakdown in agent mode, especially when using tools
        if (toolsToSend.length > 0) {
            systemPrompt += "\n\n**CRITICAL REQUIREMENT - TASK BREAKDOWN IS MANDATORY:**\nWhen working in agent mode with access to tools, you MUST:\n1. **ALWAYS start by creating a task breakdown** - Before doing anything else, break down the task into a clear task list with checkboxes\n2. **Show your progress** - As you complete each task, update the task list with checkmarks\n3. **Use this exact format:**\n\n## Task Breakdown\n- [ ] Task 1: Description\n- [ ] Task 2: Description\n- [✓] Task 3: Completed task (use [✓] for completed)\n\n## Progress\n- ✓ Task 3 completed\n- Working on Task 1...\n\n**This is mandatory - always output the task breakdown first, even for simple tasks.**";
        } else {
            systemPrompt += "\n\nWhen working on complex tasks, you should:\n1. First, break down the task into a clear task list with checkboxes\n2. Show your progress as you complete each task\n3. Update the task list with checkmarks (✓) as you finish each item\n4. Use this format:\n\n## Task Breakdown\n- [ ] Task 1: Description\n- [ ] Task 2: Description\n- [✓] Task 3: Completed task (use [✓] for completed)\n\n## Progress\n- ✓ Task 3 completed\n- Working on Task 1...\n\nThis helps users understand what you're doing and track your progress.";
        }

        if (toolsToSend.length > 0) {
            systemPrompt += "\n\n**IMPORTANT: Tool Usage Guidelines**\nYou have access to tools that can help you answer questions. Use them when the user asks for information NOT in the provided paper context (e.g., 'get author's recent papers', 'find similar papers'). Do NOT use tools for questions about the current paper's content (e.g., 'summarize this paper', 'explain this section').";

            // Check if execute_query tool (HelmDB) is available and add specific instructions
            const hasHelmDBTool = toolsToSend.some((tool: any) => tool.function.name === "execute_query");
            if (hasHelmDBTool) {
                systemPrompt += HELMDB_PROMPT;            }
        }
    }

    const userContent = truncateForModel(context + prompt, MAX_USER_CONTENT_CHARS, "context");
    const messages: any[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent }
    ];

    // Use the same streaming logic as callLLMStream
    try {
        if (provider === "Gemini") {
            // Gemini API with tool support (same logic as callLLMStream)
            const apiKey = Zotero.Prefs.get(`${prefsPrefix}.geminiApiKey`) as string;
            const model = Zotero.Prefs.get(`${prefsPrefix}.geminiModel`) as string;
            const baseUrl = "https://generativelanguage.googleapis.com/v1beta/models";

            if (!apiKey) throw new Error("Please set API Key for Gemini.");

            // Loop for tool calls (no hard limit) - only in agent mode
            const maxTurns = mode === "agent" ? Number.POSITIVE_INFINITY : 1;
            for (let turn = 0; turn < maxTurns; turn++) {
                // Check abort signal
                if (abortSignal?.aborted) {
                    throw new Error("Request aborted by user");
                }

                // Convert messages to Gemini format
                const geminiContents: any[] = [];

                // Add system prompt as first user message
                if (systemPrompt) {
                    geminiContents.push({
                        role: "user",
                        parts: [{ text: systemPrompt }]
                    });
                    geminiContents.push({
                        role: "model",
                        parts: [{ text: "I understand. I will follow these instructions." }]
                    });
                }

                // Convert remaining messages
                for (const msg of messages) {
                    if (msg.role === "system") continue;

                    if (msg.role === "user") {
                        geminiContents.push({
                            role: "user",
                            parts: [{ text: msg.content }]
                        });
                    } else if (msg.role === "assistant") {
                        geminiContents.push({
                            role: "model",
                            parts: msg.tool_calls ? [
                                { text: msg.content || "" },
                                ...msg.tool_calls.map((tc: any) => ({
                                    functionCall: {
                                        name: tc.function.name,
                                        args: JSON.parse(tc.function.arguments || "{}")
                                    }
                                }))
                            ] : [{ text: msg.content || "" }]
                        });
                    } else if (msg.role === "tool") {
                        geminiContents.push({
                            role: "function",
                            parts: [{
                                functionResponse: {
                                    name: msg.tool_call_id,
                                    response: { result: msg.content }
                                }
                            }]
                        });
                    }
                }

                const url = `${baseUrl}/${model}:generateContent?key=${apiKey}`;
                const requestBody: any = {
                    contents: geminiContents
                };

                // Add tools if available and in agent mode
                if (toolsToSend.length > 0 && mode === "agent") {
                    requestBody.tools = [{
                        functionDeclarations: toolsToSend.map((tool: any) => ({
                            name: tool.function.name,
                            description: tool.function.description,
                            parameters: tool.function.parameters
                        }))
                    }];
                }

                const response = await Zotero.HTTP.request("POST", url, {
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(requestBody),
                    responseType: "json",
                    timeout: 180000
                });

                if (response.status !== 200 || !response.response) {
                    throw new Error(`API Error ${response.status}: ${JSON.stringify(response.response)}`);
                }

                const data = response.response;
                if (!data.candidates || data.candidates.length === 0) {
                    throw new Error("No response candidates from Gemini API.");
                }

                const candidate = data.candidates[0];
                const content = candidate.content;

                if (!content || !content.parts) {
                    throw new Error("Invalid response format from Gemini API.");
                }

                // Check for tool calls
                const toolCalls: any[] = [];
                let responseText = "";

                for (const part of content.parts) {
                    if (part.text) {
                        responseText += part.text;
                    }
                    if (part.functionCall) {
                        toolCalls.push({
                            id: `call_${Date.now()}_${toolCalls.length}`,
                            type: "function",
                            function: {
                                name: part.functionCall.name,
                                arguments: JSON.stringify(part.functionCall.args || {})
                            }
                        });
                    }
                }

                // Stream the response text
                if (responseText) {
                    for (let i = 0; i < responseText.length; i += 5) {
                        if (abortSignal?.aborted) break;
                        onChunk(responseText.substring(i, Math.min(i + 5, responseText.length)));
                        await new Promise(resolve => setTimeout(resolve, 20));
                    }
                }

                // Add assistant message to history
                const assistantMessage: any = {
                    role: "assistant",
                    content: responseText || null
                };
                if (toolCalls.length > 0) {
                    assistantMessage.tool_calls = toolCalls;
                }
                messages.push(assistantMessage);

                // Handle tool calls if any
                if (toolCalls.length > 0 && mode === "agent") {
                    Zotero.debug(`[AI for Science] Tool calls detected in Gemini group: ${toolCalls.length} tools`);

                    // Show tool call info
                    if (responseText) {
                        onChunk(`\n\n*正在调用工具: ${toolCalls.map(tc => tc.function.name).join(", ")}...*\n\n`);
                    } else {
                        onChunk(`*正在调用工具: ${toolCalls.map(tc => tc.function.name).join(", ")}...*\n\n`);
                    }

                    // Execute tool calls
                    for (const toolCall of toolCalls) {
                        const functionName = toolCall.function.name;
                        const argsString = toolCall.function.arguments;
                        let args = {};
                        try {
                            args = JSON.parse(argsString);
                        } catch (e) {
                            Zotero.debug("[AI for Science] Failed to parse tool arguments: " + e);
                        }

                        Zotero.debug(`[AI for Science] Calling tool: ${functionName}`);

                        let result = "";
                        try {
                            args = normalizeSciSciNetToolArgs(functionName, args, primaryTitle, requestedAuthorName);
                            args = coerceResolveToSqlIfNeeded(functionName, args, resolvedAuthorIds);
                            const guardError = blockSciSciNetAuthorWithoutTitle(functionName, args) ||
                                blockSciSciNetResolveAfterResolved(functionName, args, resolvedAuthorIds) ||
                                blockSqlToolCallIfUnauthorized(functionName, args, resolvedAuthorIds);
                            if (guardError) {
                                result = guardError;
                            } else {
                                const client = toolToClientMap[functionName];
                                if (client) {
                                    const res = await client.callTool(resolveToolNameForCall(functionName), args);
                                    if (res && typeof res === 'object' && res.content && Array.isArray(res.content)) {
                                        const textParts = res.content
                                            .filter((item: any) => item.type === "text" && item.text)
                                            .map((item: any) => item.text);
                                        result = textParts.join("\n\n");
                                    } else {
                                        result = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
                                    }
                                } else {
                                    result = "Error: Tool not found or client not connected.";
                                }
                            }
                        } catch (e) {
                            result = `Error executing tool: ${e}`;
                        }

                        const modelResult = truncateForModel(result, MAX_TOOL_RESULT_CHARS, "tool result");
                        emitToolResult(onChunk, functionName, modelResult);
                        messages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            content: modelResult
                        });
                        const resolvedIds = extractAuthorIdsFromToolResult(result);
                        if (resolvedIds.length > 0) {
                            resolvedAuthorIds = resolvedIds;
                            messages.push({
                                role: "user",
                                content: `[Resolved Author]\nUse only these authorid values for subsequent SQL queries: ${resolvedIds.join(", ")}. Do not call author-resolve again.`
                            });
                        }
                    }
                    if (enforceSciSciNetHtmlOnly) {
                        messages.push({
                            role: "user",
                            content: SCISCINET_HTML_ONLY_INSTRUCTION
                        });
                    }
                    // Continue loop to send tool results back
                } else {
                    // Final response
                    return;
                }
            }
        } else if (provider === "Claude") {
            const baseUrl = Zotero.Prefs.get(`${prefsPrefix}.claudeBaseUrl`) as string || "https://api.anthropic.com/v1";
            const apiKey = Zotero.Prefs.get(`${prefsPrefix}.claudeApiKey`) as string;
            const model = Zotero.Prefs.get(`${prefsPrefix}.claudeModel`) as string;

            if (!apiKey) throw new Error("Please set API Key for Claude.");

            const url = `${baseUrl}/messages`;

            const response = await Zotero.HTTP.request("POST", url, {
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": apiKey,
                    "anthropic-version": "2023-06-01"
                },
                body: JSON.stringify({
                    model: model,
                    max_tokens: 4096,
                    messages: messages,
                    tools: toolsToSend.length > 0 ? toolsToSend : undefined
                }),
                responseType: "json",
                timeout: 180000
            });

            if (response.status === 200 && response.response) {
                const data = response.response;
                if (data.content && data.content.length > 0) {
                    const text = data.content[0].text;
                    for (let i = 0; i < text.length; i += 5) {
                        if (abortSignal?.aborted) break;
                        onChunk(text.substring(i, Math.min(i + 5, text.length)));
                        await new Promise(resolve => setTimeout(resolve, 20));
                    }
                    return;
                }
            }
            throw new Error(`API Error ${response.status}: ${JSON.stringify(response.response)}`);

        } else {
            // OpenAI, DeepSeek, or Custom provider
            let baseUrl = Zotero.Prefs.get(`${prefsPrefix}.openaiBaseUrl`) as string || "https://api.openai.com/v1";
            let apiKey = Zotero.Prefs.get(`${prefsPrefix}.openaiApiKey`) as string;
            let model = Zotero.Prefs.get(`${prefsPrefix}.openaiModel`) as string;

            if (provider === "DeepSeek") {
                baseUrl = Zotero.Prefs.get(`${prefsPrefix}.deepseekBaseUrl`) as string || "https://api.deepseek.com/v1";
                apiKey = Zotero.Prefs.get(`${prefsPrefix}.deepseekApiKey`) as string;
                model = Zotero.Prefs.get(`${prefsPrefix}.deepseekModel`) as string;
            } else if (provider === "Custom") {
                baseUrl = Zotero.Prefs.get(`${prefsPrefix}.customBaseUrl`) as string;
                apiKey = Zotero.Prefs.get(`${prefsPrefix}.customApiKey`) as string;
                model = Zotero.Prefs.get(`${prefsPrefix}.customModel`) as string;
            }

            if (!apiKey) throw new Error(`Please set API Key for ${provider}.`);

            const endpoint = `${baseUrl}/chat/completions`;

            const body: any = {
                model: model,
                messages: messages,
                stream: true,
                temperature: 0.7,
                max_tokens: 4096
            };

            if (toolsToSend.length > 0) {
                body.tools = toolsToSend;
                body.tool_choice = "auto";
            }

            // Loop for tool calls (no hard limit) - only in agent mode
            const maxTurns = mode === "agent" ? Number.POSITIVE_INFINITY : 1;
            const isReasonerModel = provider === "DeepSeek" &&
                (model.includes("reasoner") || model.includes("r1") || model.includes("R1"));
            for (let turn = 0; turn < maxTurns; turn++) {
                // Check abort signal
                if (abortSignal?.aborted) {
                    throw new Error("Request aborted by user");
                }

                let processedLength = 0;
                let toolCalls: any[] = [];
                let hasToolCalls = false;
                let fullContent = "";

                // Update body with current messages
                let messagesToSend: any[] = messages;
                if (isReasonerModel) {
                    messagesToSend = messages.map((m: any) => {
                        if (m.role !== "assistant") return m;
                        const copy = { ...m };
                        if (copy.tool_calls) {
                            if (!Object.prototype.hasOwnProperty.call(copy, "reasoning_content")) {
                                copy.reasoning_content = "";
                            }
                        } else if (Object.prototype.hasOwnProperty.call(copy, "reasoning_content")) {
                            delete copy.reasoning_content;
                        }
                        return copy;
                    });
                }
                body.messages = messagesToSend;

                await Zotero.HTTP.request("POST", endpoint, {
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${apiKey}`
                    },
                    body: JSON.stringify(body),
                    responseType: "text",
                    timeout: 180000,
                    requestObserver: (xmlhttp: XMLHttpRequest) => {
                        xmlhttp.onprogress = (e: any) => {
                            if (abortSignal?.aborted) {
                                try {
                                    xmlhttp.abort();
                                } catch (abortError) {
                                    // Ignore abort errors
                                }
                                return;
                            }
                            try {
                                const response = e.target.response;
                                if (!response || response.length <= processedLength) return;

                                const newData = response.substring(processedLength);
                                processedLength = response.length;

                                const lines = newData.split("\n");
                                for (const line of lines) {
                                    if (line.trim() === "") continue;
                                    if (line.startsWith("data: ")) {
                                        const data = line.slice(6);
                                        if (data === "[DONE]") continue;

                                        try {
                                            const json = JSON.parse(data);
                                            const delta = json.choices?.[0]?.delta;
                                            if (!delta) continue;

                                            if (delta.tool_calls) {
                                                hasToolCalls = true;
                                                delta.tool_calls.forEach((tc: any, idx: number) => {
                                                    if (!toolCalls[idx]) {
                                                        toolCalls[idx] = { id: tc.id, type: "function", function: { name: "", arguments: "" } };
                                                    }
                                                    if (tc.function?.name) {
                                                        toolCalls[idx].function.name = tc.function.name;
                                                    }
                                                    if (tc.function?.arguments) {
                                                        toolCalls[idx].function.arguments += tc.function.arguments;
                                                    }
                                                });
                                            } else if (delta.content) {
                                                fullContent += delta.content;
                                                onChunk(delta.content);
                                            }
                                        } catch (parseError) {
                                            // Ignore parse errors
                                        }
                                    }
                                }
                            } catch (e) {
                                // Ignore errors
                            }
                        };
                    }
                });

                // Add assistant message to history
                const assistantMessage: any = {
                    role: "assistant",
                    content: fullContent || null
                };
                if (hasToolCalls && toolCalls.length > 0) {
                    assistantMessage.tool_calls = toolCalls;
                    if (isReasonerModel && !Object.prototype.hasOwnProperty.call(assistantMessage, "reasoning_content")) {
                        assistantMessage.reasoning_content = "";
                    }
                }
                messages.push(assistantMessage);

                // Handle tool calls if any
                if (hasToolCalls && toolCalls.length > 0 && mode === "agent") {
                    Zotero.debug(`[AI for Science] Tool calls detected in group analysis: ${toolCalls.length} tools`);

                    // Show tool call info in the message
                    if (fullContent) {
                        onChunk(`\n\n*正在调用工具: ${toolCalls.map(tc => tc.function.name).join(", ")}...*\n\n`);
                    } else {
                        onChunk(`*正在调用工具: ${toolCalls.map(tc => tc.function.name).join(", ")}...*\n\n`);
                    }

                    // Execute tool calls and add results to messages
                    for (const toolCall of toolCalls) {
                        const functionName = toolCall.function.name;
                        const argsString = toolCall.function.arguments;
                        let args = {};
                        try {
                            args = JSON.parse(argsString);
                        } catch (e) {
                            Zotero.debug("[AI for Science] Failed to parse tool arguments: " + e);
                        }

                        Zotero.debug(`[AI for Science] Calling tool: ${functionName}`);

                        let result = "";
                        try {
                            args = normalizeSciSciNetToolArgs(functionName, args, primaryTitle, requestedAuthorName);
                            args = coerceResolveToSqlIfNeeded(functionName, args, resolvedAuthorIds);
                            const guardError = blockSciSciNetAuthorWithoutTitle(functionName, args) ||
                                blockSciSciNetResolveAfterResolved(functionName, args, resolvedAuthorIds) ||
                                blockSqlToolCallIfUnauthorized(functionName, args, resolvedAuthorIds);
                            if (guardError) {
                                result = guardError;
                            } else {
                                const client = toolToClientMap[functionName];
                                if (client) {
                                    const res = await client.callTool(resolveToolNameForCall(functionName), args);
                                    // MCP tools return result in format: {content: [{type: "text", text: "..."}]}
                                    if (res && typeof res === 'object' && res.content && Array.isArray(res.content)) {
                                        // Extract text from content array
                                        const textParts = res.content
                                            .filter((item: any) => item.type === "text" && item.text)
                                            .map((item: any) => item.text);
                                        result = textParts.join("\n\n");
                                    } else {
                                        result = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
                                    }
                                } else {
                                    result = "Error: Tool not found or client not connected.";
                                }
                            }
                        } catch (e) {
                            result = `Error executing tool: ${e}`;
                        }

                        const modelResult = truncateForModel(result, MAX_TOOL_RESULT_CHARS, "tool result");
                        emitToolResult(onChunk, functionName, modelResult);
                        messages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            content: modelResult
                        });
                        const resolvedIds = extractAuthorIdsFromToolResult(result);
                        if (resolvedIds.length > 0) {
                            resolvedAuthorIds = resolvedIds;
                            messages.push({
                                role: "user",
                                content: `[Resolved Author]\nUse only these authorid values for subsequent SQL queries: ${resolvedIds.join(", ")}. Do not call author-resolve again.`
                            });
                        }
                    }
                    if (enforceSciSciNetHtmlOnly) {
                        messages.push({
                            role: "user",
                            content: SCISCINET_HTML_ONLY_INSTRUCTION
                        });
                    }
                    // Continue loop to send tool results back to LLM (will stream the final response)
                } else {
                    // Final response - streaming is complete
                    return;
                }
            }
        }
    } catch (e: any) {
        if (!abortSignal?.aborted) {
            throw e;
        }
    }
}

// Keep the original callLLM for backward compatibility (non-streaming)
async function callLLM(prompt: string, item: Zotero.Item, selectedText: string = "") {
    // Sanitize inputs
    prompt = sanitizeString(prompt);
    selectedText = sanitizeString(selectedText);

    const prefsPrefix = addon.data.config.prefsPrefix;
    const provider = Zotero.Prefs.get(`${prefsPrefix}.provider`) as string;

    // Check if item is attachment and get parent if possible for metadata
    let metadataItem = item;
    if (item.isAttachment() && item.parentItem) {
        // @ts-ignore
        metadataItem = item.parentItem;
    }

    // Get title from PDF, fall back to Zotero metadata title
    const title = sanitizeString(await getPDFTitle(metadataItem) || metadataItem.getField("title") || "");
    const abstract = sanitizeString(metadataItem.getField("abstractNote"));

    let context = `Context: You are discussing the paper titled "${title}".\n`;
    let enforcedAuthorIds: string[] = [];
    let requestedAuthorName: string | null = null;

    // If SciSciNet tool is active, pre-fetch candidate authors for this paper title
    const authorCandidates = await fetchSciSciNetAuthorsForTitle(title);
    if (authorCandidates.length > 0) {
        const authorsList = authorCandidates
            .map(a => `- ${a.author_name} (authorid: ${a.authorid})`)
            .join("\n");
        context += `\n[Paper author candidates from SciSciNet]\nTitle: ${title}\n${authorsList}\n\n` +
            "Use only the author IDs listed above when the user asks about an author from this paper.\n\n";
    } else {
        context += `\n[Paper author candidates from SciSciNet]\nTitle: ${title}\n(No matching authors found for this title)\n\n` +
            "Do NOT perform author- or paper-level queries without resolved authorid from this paper.\n\n";
    }

    requestedAuthorName = findRequestedAuthorName(prompt, metadataItem) || extractLatinNameFromPrompt(prompt);
    if (requestedAuthorName) {
        let resolved = authorCandidates.filter(a =>
            normalizeNameForMatch(a.author_name).includes(normalizeNameForMatch(requestedAuthorName))
        );
        if (resolved.length === 0) {
            resolved = await fetchSciSciNetAuthorsForTitleAndName(title, requestedAuthorName);
        }
        if (resolved.length > 0) {
            const resolvedList = resolved
                .map(a => `- ${a.author_name} (authorid: ${a.authorid})`)
                .join("\n");
            enforcedAuthorIds = resolved.map(a => a.authorid);
            context += `\n[Resolved Author For This Paper]\nRequested name: ${requestedAuthorName}\n${resolvedList}\n\n` +
                "You MUST use ONLY these authorid values for subsequent queries and MUST NOT search by author_name.\n\n";
        } else {
            context += `\n[Resolved Author For This Paper]\nRequested name: ${requestedAuthorName}\n(No matching authorid resolved from this paper)\n\n` +
                "Do NOT perform author- or paper-level queries without resolved authorid from this paper.\n\n";
        }
    } else if (authorCandidates.length > 0) {
        const resolvedFromPrompt = resolveAuthorCandidatesFromPrompt(prompt, authorCandidates);
        if (resolvedFromPrompt.length > 0) {
            const resolvedList = resolvedFromPrompt
                .map(a => `- ${a.author_name} (authorid: ${a.authorid})`)
                .join("\n");
            const uniqueNames = Array.from(new Set(resolvedFromPrompt.map(a => a.author_name)));
            const requestedLabel = uniqueNames.length === 1
                ? uniqueNames[0]
                : "matched from user prompt";
            enforcedAuthorIds = resolvedFromPrompt.map(a => a.authorid);
            context += `\n[Resolved Author For This Paper]\nRequested name: ${requestedLabel}\n${resolvedList}\n\n` +
                "You MUST use ONLY these authorid values for subsequent queries and MUST NOT search by author_name.\n\n";
        } else {
            enforcedAuthorIds = authorCandidates.map(a => a.authorid);
        }
    }

    if (selectedText) {
        // Check if this is an explanation request
        const isExplanationRequest = prompt.toLowerCase().includes("解释") ||
            prompt.toLowerCase().includes("explain") ||
            prompt.toLowerCase().includes("这段") ||
            prompt.toLowerCase().includes("选中") ||
            prompt.includes("这一段讲了什么") ||
            prompt.includes("这一段讲了");

        if (isExplanationRequest) {
            // For explanation requests, clearly distinguish selected text from context
            // Put selected text first and emphasize it's what needs to be explained
            context += `\n\n[SELECTED TEXT TO EXPLAIN]\n"${selectedText}"\n\n[PAPER CONTEXT - USE FOR UNDERSTANDING ONLY, DO NOT EXPLAIN THIS]\n`;
        } else {
            // For other requests, use the original format
            context += `\nUser selected text from the paper: "${selectedText}"\n\nPlease answer the user's question based on this selected text and the paper's context.\n`;
        }
    }

    try {
        const rawPdfText = await getPDFText(item);
        const pdfText = sanitizeString(rawPdfText);

        // Check if PDF is open and warn if not
        await checkAndWarnPDFNotOpen(item, pdfText);

        if (pdfText && pdfText.length > 100) {
            Zotero.debug(`[AI for Science] PDF text length: ${pdfText.length}`);

            // RAG Logic: If text is long, retrieve relevant chunks
            // Threshold: 15000 characters (approx 3-4k tokens)
            if (pdfText.length > 15000) {
                Zotero.debug("[AI for Science] Using RAG for long document.");
                const rawRelevantText = await RAGEngine.getRelevantContext(prompt, item, pdfText);
                const relevantText = sanitizeString(rawRelevantText);
                context += `Relevant excerpts from the paper:\n${relevantText}\n\n`;
            } else {
                context += `Full Text: ${pdfText}\n\n`;
            }
        } else {
            context += `Abstract: ${abstract}\n\n`;
            if (!pdfText) {
                context += `(Note: Full text PDF could not be read. Using abstract only.)\n`;
            }
        }
    } catch (e) {
        Zotero.log("Failed to read PDF text: " + e);
        context += `Abstract: ${abstract}\n\n`;
        // Also check and warn if PDF is not open when there's an error
        try {
            await checkAndWarnPDFNotOpen(item, "");
        } catch (warnError) {
            Zotero.debug(`[AI for Science] Error checking PDF status: ${warnError}`);
        }
    }

    // Prepare active tools based on user selection
    const toolsToSend = activeMCPTools.filter(t => selectedToolNames.has(t.function.name));
    const enforceSciSciNetHtmlOnly = toolsToSend.some((tool: any) =>
        tool?.function?.name === "sql_query" || tool?.function?.name === "sql.query"
    );

    // Prepare Messages (for backward compatibility, assume agent mode if tools are available)
    let systemPrompt = "You are a helpful academic research assistant. Please format your responses using Markdown. Use **bold** for key terms, lists for bullet points, and code blocks for technical details or code. Keep your responses structured, professional, and easy to read.";

    // Check if this is an explanation request and add special instruction to system prompt
    if (selectedText) {
        const isExplanationRequest = prompt.toLowerCase().includes("解释") ||
            prompt.toLowerCase().includes("explain") ||
            prompt.toLowerCase().includes("这段") ||
            prompt.toLowerCase().includes("选中") ||
            prompt.includes("这一段讲了什么") ||
            prompt.includes("这一段讲了");
        if (isExplanationRequest) {
            systemPrompt += "\n\n**CRITICAL INSTRUCTION FOR EXPLANATION REQUESTS:**\nWhen the user asks you to explain selected text (e.g., '这一段讲了什么'), you MUST:\n1. Use ALL the paper context provided below to FULLY UNDERSTAND the selected text\n2. Consider the context, background, and surrounding information to grasp the meaning\n3. However, in your explanation, ONLY explain the SELECTED TEXT portion itself\n4. Do NOT explain or summarize the context portions - they are only for your understanding\n5. Focus your explanation entirely on what the selected text says, using your understanding from the context\n\nThe context is your reference material for understanding, but your explanation should be about the selected text only.";
        }
    }

    // If tools are available, add task breakdown instruction
    if (toolsToSend.length > 0) {
        systemPrompt += "\n\nWhen working on complex tasks, you should:\n1. First, break down the task into a clear task list with checkboxes\n2. Show your progress as you complete each task\n3. Update the task list with checkmarks (✓) as you finish each item\n4. Use this format:\n\n## Task Breakdown\n- [ ] Task 1: Description\n- [ ] Task 2: Description\n- [✓] Task 3: Completed task (use [✓] for completed)\n\n## Progress\n- ✓ Task 3 completed\n- Working on Task 1...\n\nThis helps users understand what you're doing and track your progress.";

        // Add instruction about selective tool usage
        systemPrompt += "\n\n**IMPORTANT: Tool Usage Guidelines**\nYou have access to tools, but you should ONLY use them when they are truly necessary to answer the user's question. Do NOT call tools for every question.\n\n- Use tools ONLY when:\n  * The user's question requires external data, computation, or actions that cannot be answered from the paper content alone\n  * The user explicitly asks you to perform an action that requires a tool\n  * You need to retrieve information that is not in the provided context\n\n- Do NOT use tools when:\n  * The question can be answered directly from the paper content or context provided\n  * The user is asking for explanations, summaries, or analysis of the paper\n  * The question is a simple query that doesn't require external tools\n\nAnswer questions directly when possible, and only use tools when they add real value to your response.";

        // Check if execute_query tool (HelmDB) is available and add specific instructions
        const hasHelmDBTool = toolsToSend.some((tool: any) => tool.function.name === "execute_query");
        if (hasHelmDBTool) {
            systemPrompt += HELMDB_PROMPT;        }

        const hasSciSciNetTool = toolsToSend.some((tool: any) =>
            tool?.function?.name === "sql_query" || tool?.function?.name === "sql.query"
        );
        if (hasSciSciNetTool) {
            systemPrompt += `\n\n${SCISCINET_HTML_PROMPT}`;
        }
    }

    const userContent = truncateForModel(context + prompt, MAX_USER_CONTENT_CHARS, "context");
    const messages: any[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent }
    ];

    try {
        if (provider === "Gemini") {
            // Gemini API with tool support (non-streaming version)
            const apiKey = Zotero.Prefs.get(`${prefsPrefix}.geminiApiKey`) as string;
            const model = Zotero.Prefs.get(`${prefsPrefix}.geminiModel`) as string;
            const baseUrl = "https://generativelanguage.googleapis.com/v1beta/models";

            if (!apiKey) throw new Error("Please set API Key for Gemini.");

            // Loop for tool calls (no hard limit)
            for (let turn = 0; ; turn++) {
                // Convert messages to Gemini format
                const geminiContents: any[] = [];

                // Add system prompt as first user message
                if (systemPrompt) {
                    geminiContents.push({
                        role: "user",
                        parts: [{ text: systemPrompt }]
                    });
                    geminiContents.push({
                        role: "model",
                        parts: [{ text: "I understand. I will follow these instructions." }]
                    });
                }

                // Convert remaining messages
                for (const msg of messages) {
                    if (msg.role === "system") continue;

                    if (msg.role === "user") {
                        geminiContents.push({
                            role: "user",
                            parts: [{ text: msg.content }]
                        });
                    } else if (msg.role === "assistant") {
                        geminiContents.push({
                            role: "model",
                            parts: msg.tool_calls ? [
                                { text: msg.content || "" },
                                ...msg.tool_calls.map((tc: any) => ({
                                    functionCall: {
                                        name: tc.function.name,
                                        args: JSON.parse(tc.function.arguments || "{}")
                                    }
                                }))
                            ] : [{ text: msg.content || "" }]
                        });
                    } else if (msg.role === "tool") {
                        geminiContents.push({
                            role: "function",
                            parts: [{
                                functionResponse: {
                                    name: msg.tool_call_id,
                                    response: { result: msg.content }
                                }
                            }]
                        });
                    }
                }

                const url = `${baseUrl}/${model}:generateContent?key=${apiKey}`;
                const requestBody: any = {
                    contents: geminiContents
                };

                // Add tools if available
                if (toolsToSend.length > 0) {
                    requestBody.tools = [{
                        functionDeclarations: toolsToSend.map((tool: any) => ({
                            name: tool.function.name,
                            description: tool.function.description,
                            parameters: tool.function.parameters
                        }))
                    }];
                }

                const response = await Zotero.HTTP.request("POST", url, {
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(requestBody),
                    responseType: "json",
                    timeout: 120000
                });

                if (response.status !== 200 || !response.response) {
                    throw new Error(`API Error ${response.status}: ${JSON.stringify(response.response)}`);
                }

                const data = response.response;
                if (!data.candidates || data.candidates.length === 0) {
                    throw new Error("No response candidates from Gemini API.");
                }

                const candidate = data.candidates[0];
                const content = candidate.content;

                if (!content || !content.parts) {
                    throw new Error("Invalid response format from Gemini API.");
                }

                // Check for tool calls
                const toolCalls: any[] = [];
                let responseText = "";

                for (const part of content.parts) {
                    if (part.text) {
                        responseText += part.text;
                    }
                    if (part.functionCall) {
                        toolCalls.push({
                            id: `call_${Date.now()}_${toolCalls.length}`,
                            type: "function",
                            function: {
                                name: part.functionCall.name,
                                arguments: JSON.stringify(part.functionCall.args || {})
                            }
                        });
                    }
                }

                // Add assistant message to history
                const assistantMessage: any = {
                    role: "assistant",
                    content: responseText || null
                };
                if (toolCalls.length > 0) {
                    assistantMessage.tool_calls = toolCalls;
                }
                messages.push(assistantMessage);

                // Handle tool calls if any
                if (toolCalls.length > 0) {
                    Zotero.debug(`[AI for Science] Tool calls detected in Gemini: ${toolCalls.length} tools`);

                    // Execute tool calls
                    for (const toolCall of toolCalls) {
                        const functionName = toolCall.function.name;
                        const argsString = toolCall.function.arguments;
                        let args = {};
                        try {
                            args = JSON.parse(argsString);
                        } catch (e) {
                            Zotero.debug("[AI for Science] Failed to parse tool arguments: " + e);
                        }

                        Zotero.debug(`[AI for Science] Calling tool: ${functionName}`);

                        let result = "";
                        try {
                            args = normalizeSciSciNetToolArgs(functionName, args, title, requestedAuthorName);
                            const client = toolToClientMap[functionName];
                            if (client) {
                                const res = await client.callTool(resolveToolNameForCall(functionName), args);
                                if (res && typeof res === 'object' && res.content && Array.isArray(res.content)) {
                                    const textParts = res.content
                                        .filter((item: any) => item.type === "text" && item.text)
                                        .map((item: any) => item.text);
                                    result = textParts.join("\n\n");
                                } else {
                                    result = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
                                }
                            } else {
                                result = "Error: Tool not found or client not connected.";
                            }
                        } catch (e) {
                            result = `Error executing tool: ${e}`;
                        }

                        messages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            content: result
                        });
                    }
                    if (enforceSciSciNetHtmlOnly) {
                        messages.push({
                            role: "user",
                            content: SCISCINET_HTML_ONLY_INSTRUCTION
                        });
                    }
                    // Continue loop to send tool results back
                } else {
                    // Final response
                    return responseText;
                }
            }
            return "Error: No response generated.";

        } else if (provider === "Claude") {
            // Claude uses a different API format
            const baseUrl = Zotero.Prefs.get(`${prefsPrefix}.claudeBaseUrl`) as string || "https://api.anthropic.com/v1";
            const apiKey = Zotero.Prefs.get(`${prefsPrefix}.claudeApiKey`) as string;
            const model = Zotero.Prefs.get(`${prefsPrefix}.claudeModel`) as string;

            if (!apiKey) throw new Error("Please set API Key for Claude.");

            const endpoint = `${baseUrl}/messages`.replace(/([^:]\/)\/+/g, "$1");

            const response = await Zotero.HTTP.request("POST", endpoint, {
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": apiKey,
                    "anthropic-version": "2023-06-01"
                },
                body: JSON.stringify({
                    model: model,
                    max_tokens: 4096,
                    messages: messages.filter(m => m.role !== "system").map(m => ({
                        role: m.role === "system" ? "user" : m.role,
                        content: m.role === "system" ? systemPrompt + "\n\n" + m.content : m.content
                    }))
                }),
                responseType: "json",
                timeout: 120000
            });

            if (response.status === 200 && response.response) {
                const data = response.response;
                if (data.content && data.content.length > 0) {
                    return data.content[0].text;
                }
            }
            throw new Error(`API Error ${response.status}: ${JSON.stringify(response.response)}`);

        } else {
            // OpenAI Compatible Loop
            let baseUrl = Zotero.Prefs.get(`${prefsPrefix}.openaiBaseUrl`) as string;
            let apiKey = Zotero.Prefs.get(`${prefsPrefix}.openaiApiKey`) as string;
            let model = Zotero.Prefs.get(`${prefsPrefix}.openaiModel`) as string;

            if (provider === "DeepSeek") {
                baseUrl = Zotero.Prefs.get(`${prefsPrefix}.deepseekBaseUrl`) as string;
                apiKey = Zotero.Prefs.get(`${prefsPrefix}.deepseekApiKey`) as string;
                model = Zotero.Prefs.get(`${prefsPrefix}.deepseekModel`) as string;
            } else if (provider === "Custom") {
                baseUrl = Zotero.Prefs.get(`${prefsPrefix}.customBaseUrl`) as string;
                apiKey = Zotero.Prefs.get(`${prefsPrefix}.customApiKey`) as string;
                model = Zotero.Prefs.get(`${prefsPrefix}.customModel`) as string;
            }

            if (!apiKey) throw new Error(`Please set API Key for ${provider}.`);

            let endpoint = `${baseUrl}/chat/completions`;
            endpoint = endpoint.replace(/([^:]\/)\/+/g, "$1");

            // Check if this is a reasoning model that requires reasoning_content field
            const isReasoningModel = provider === "DeepSeek" &&
                (model.includes("reasoner") || model.includes("r1") || model.includes("R1"));

            // Loop for tool calls (no hard limit)
            for (let turn = 0; ; turn++) {
                // For DeepSeek Reasoner/R1 models, prepare messages for next request
                // According to DeepSeek docs: remove reasoning_content from previous messages,
                // BUT if assistant message has tool_calls, it MUST have reasoning_content field
                if (isReasoningModel && turn > 0) {
                    messages.forEach((msg: any) => {
                        if (msg.role === "assistant") {
                            // If message has tool_calls, ensure it has reasoning_content (even if empty)
                            if (msg.tool_calls && msg.tool_calls.length > 0) {
                                if (!msg.hasOwnProperty("reasoning_content")) {
                                    msg.reasoning_content = "";
                                }
                            } else {
                                // If message doesn't have tool_calls, remove reasoning_content
                                if (msg.hasOwnProperty("reasoning_content")) {
                                    delete msg.reasoning_content;
                                }
                            }
                        }
                    });
                }

                const body: any = {
                    model: model,
                    messages: messages
                };

                if (toolsToSend.length > 0) {
                    body.tools = toolsToSend;
                    body.tool_choice = "auto";
                }

                const response = await Zotero.HTTP.request("POST", endpoint, {
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${apiKey}`
                    },
                    body: JSON.stringify(body),
                    responseType: "json",
                    timeout: 120000
                });

                if (response.status !== 200 || !response.response) {
                    throw new Error(`API Error ${response.status}: ${JSON.stringify(response.response)}`);
                }

                const data = response.response;
                if (!data.choices || data.choices.length === 0) {
                    throw new Error("No response choices from API.");
                }

                const choice = data.choices[0];
                const message = choice.message;

                // Ensure message has type field
                if (!message.type) {
                    message.type = "assistant";
                }

                // For DeepSeek Reasoner/R1 models, ensure reasoning_content is included when using tool calls
                // This field is MANDATORY when tool_calls exist, even if empty
                if (isReasoningModel && message.tool_calls && message.tool_calls.length > 0) {
                    // Ensure reasoning_content field exists (mandatory for tool_calls)
                    if (!message.hasOwnProperty("reasoning_content")) {
                        message.reasoning_content = "";
                    }
                } else if (isReasoningModel) {
                    // For reasoning models without tool_calls, remove reasoning_content if present
                    if (message.hasOwnProperty("reasoning_content")) {
                        delete message.reasoning_content;
                    }
                }

                // Add assistant message to history
                messages.push(message);

                if (message.tool_calls && message.tool_calls.length > 0) {
                    Zotero.debug(`[AI for Science] Tool calls received: ${message.tool_calls.length}`);

                    for (const toolCall of message.tool_calls) {
                        const functionName = toolCall.function.name;
                        const argsString = toolCall.function.arguments;
                        let args = {};
                        try {
                            args = JSON.parse(argsString);
                        } catch (e) {
                            Zotero.debug("[AI for Science] Failed to parse tool arguments: " + e);
                        }

                        Zotero.debug(`[AI for Science] Calling tool: ${functionName}`);

                        let result = "";
                        try {
                            args = coerceResolveToSqlIfNeeded(functionName, args, enforcedAuthorIds);
                            const guardError = blockSciSciNetAuthorWithoutTitle(functionName, args) ||
                                blockSqlToolCallWithoutResolvedAuthor(functionName, args, enforcedAuthorIds) ||
                                blockSqlToolCallIfUnauthorized(functionName, args, enforcedAuthorIds);
                            if (guardError) {
                                result = guardError;
                            } else {
                                const client = toolToClientMap[functionName];
                                if (client) {
                                    const res = await client.callTool(resolveToolNameForCall(functionName), args);
                                    // MCP tools return result in format: {content: [{type: "text", text: "..."}]}
                                    if (res && typeof res === 'object' && res.content && Array.isArray(res.content)) {
                                        // Extract text from content array
                                        const textParts = res.content
                                            .filter((item: any) => item.type === "text" && item.text)
                                            .map((item: any) => item.text);
                                        result = textParts.join("\n\n");
                                    } else {
                                        result = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
                                    }
                                } else {
                                    result = "Error: Tool not found or client not connected.";
                                }
                            }
                        } catch (e) {
                            result = `Error executing tool: ${e}`;
                        }

                        messages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            content: result
                        });
                    }
                    if (enforceSciSciNetHtmlOnly) {
                        messages.push({
                            role: "user",
                            content: SCISCINET_HTML_ONLY_INSTRUCTION
                        });
                    }
                    // Continue loop to send tool results back to LLM
                } else {
                    // Final response
                    return message.content;
                }
            }
            return "Error: No response generated.";
        }
    } finally {
        // Do not close clients here anymore, as they are managed globally for the session
    }
}
