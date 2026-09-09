/**
 * DBLP API integration module
 * Used to query author information and papers from DBLP
 */

import { config } from "../../package.json";
import { getPDFTitle } from "./pdf";

export interface DBLPAuthor {
    pid: string;
    name: string;
}

export interface DBLPPaper {
    key: string;
    title: string;
    year?: string;
    authors?: string[];
    venue?: string;
    type?: string;
    doi?: string;
    url?: string;
    ee?: string; // Electronic edition URL
}

export interface DBLPResponse {
    result?: {
        hits?: {
            hit?: Array<{
                info?: {
                    key?: string;
                    title?: string;
                    year?: string;
                    authors?: {
                        author?: Array<{
                            text?: string;
                            "@pid"?: string;
                            pid?: string;
                        }>;
                    };
                    venue?: string;
                    type?: string;
                    doi?: string;
                    url?: string;
                    ee?: string;
                };
            }>;
        };
    };
}

function normalizeNameForDblp(name: string): string {
    return (name || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function getConfiguredDblpBaseUrl(): string {
    try {
        const pref = Zotero.Prefs.get(`${config.prefsPrefix}.dblpBaseUrl`) as string;
        return (pref || "").trim().replace(/\/+$/, "");
    } catch (e) {
        return "";
    }
}

function getDblpBaseUrls(): string[] {
    const preferred = getConfiguredDblpBaseUrl();
    const defaults = [
        "https://dblp.uni-trier.de",
        "https://dblp.dagstuhl.de",
        "https://dblp.org"
    ];
    if (preferred) {
        const normalized = preferred.replace(/\/+$/, "");
        return [normalized, ...defaults.filter((d) => d !== normalized)];
    }
    return defaults;
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 从错误对象中提取HTTP状态码
 */
function extractHttpStatus(err: any): number | null {
    // 首先尝试从status属性获取
    if (err?.status && typeof err.status === "number") {
        return err.status;
    }
    // 从错误消息中提取状态码
    const text = String(err?.message || err || "");
    const match = text.match(/status code (\d+)|HTTP (\d+)/i);
    if (match) {
        return parseInt(match[1] || match[2], 10);
    }
    return null;
}

function isServerError(err: any): boolean {
    // 504 Gateway Timeout 和 502 Bad Gateway 应该重试（尝试其他镜像）
    // 500 Internal Server Error 应该立即跳过（不重试）
    // 4xx 客户端错误（除了 408/429）应该立即跳过
    const status = extractHttpStatus(err);
    if (status !== null) {
        // 500 错误立即跳过，504/502 可以重试
        if (status === 500) return true;
        // 4xx 客户端错误（除了超时和限流）立即跳过
        if (status >= 400 && status < 500 && status !== 408 && status !== 429 && status !== 504 && status !== 502) return true;
    }
    const text = String(err || "");
    // 500 错误立即跳过
    if (text.includes("status code 500") || text.includes("HTTP 500")) return true;
    // 504/502 错误可以重试，不跳过
    return false;
}

/**
 * 判断是否是网关超时错误（504/502），应该立即切换镜像
 */
function isGatewayTimeout(err: any): boolean {
    const status = extractHttpStatus(err);
    return status === 504 || status === 502;
}

/**
 * 判断是否是限流错误（429），应该等待后重试
 */
function isRateLimitError(err: any): boolean {
    const status = extractHttpStatus(err);
    return status === 429;
}

/**
 * 判断是否是服务不可用错误（503），应该等待后重试
 */
function isServiceUnavailable(err: any): boolean {
    const status = extractHttpStatus(err);
    return status === 503;
}

async function requestJsonWithRetry(url: string, retries = 0, baseDelayMs = 500) {
    // 对于504错误，不应该重试，应该立即切换到其他镜像
    let lastError: any = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await Zotero.HTTP.request("GET", url, {
                responseType: "json",
                timeout: 15000  // 15秒超时（减少等待时间）
            });
        } catch (e: any) {
            lastError = e;
            // 如果是504/502错误，立即抛出，不重试（让上层切换到其他镜像）
            if (isGatewayTimeout(e)) {
                Zotero.debug(`[DBLP] Gateway timeout (${extractHttpStatus(e)}), skipping retry: ${url}`);
                throw e;  // 立即抛出，不重试
            }
            if (attempt < retries) {
                if (isServerError(e)) {
                    Zotero.debug(`[DBLP] Server error (${extractHttpStatus(e) || "unknown"}), skipping retry: ${url}`);
                    break;
                }
                const delay = baseDelayMs * (attempt + 1);
                Zotero.debug(`[DBLP] Request failed, retrying in ${delay}ms: ${url}`);
                await sleep(delay);
                continue;
            }
        }
    }
    throw lastError;
}

async function requestTextWithRetry(url: string, retries = 0, baseDelayMs = 500) {
    // 对于504错误，不应该重试，应该立即切换到其他镜像
    let lastError: any = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await Zotero.HTTP.request("GET", url, {
                responseType: "text",
                timeout: 15000  // 15秒超时（减少等待时间）
            });
        } catch (e: any) {
            lastError = e;
            const status = extractHttpStatus(e);
            
            // 如果是429限流错误，等待更长时间后重试
            if (isRateLimitError(e)) {
                const waitTime = 5000 + (attempt * 2000); // 5秒 + 递增延迟
                Zotero.debug(`[DBLP] Rate limit (429), waiting ${waitTime}ms before retry: ${url}`);
                if (attempt < retries) {
                    await sleep(waitTime);
                    continue;
                }
            }
            
            // 如果是503服务不可用，快速失败，不重试（让上层切换到其他镜像）
            if (isServiceUnavailable(e)) {
                Zotero.debug(`[DBLP] Service unavailable (503), skipping retry and trying next mirror: ${url}`);
                throw e;  // 立即抛出，让上层切换到其他镜像
            }
            
            // 如果是504/502错误，立即抛出，不重试（让上层切换到其他镜像）
            if (isGatewayTimeout(e)) {
                Zotero.debug(`[DBLP] Gateway timeout (${status}), skipping retry: ${url}`);
                throw e;  // 立即抛出，不重试
            }
            
            if (attempt < retries) {
                if (isServerError(e)) {
                    Zotero.debug(`[DBLP] Server error (${status || "unknown"}), skipping retry: ${url}`);
                    break;
                }
                const delay = baseDelayMs * (attempt + 1);
                Zotero.debug(`[DBLP] Request failed, retrying in ${delay}ms: ${url}`);
                await sleep(delay);
                continue;
            }
        }
    }
    throw lastError;
}

async function requestJsonWithFallback(
    pathBuilder: (baseUrl: string) => string,
    retries = 0,
    baseDelayMs = 500
) {
    let lastError: any = null;
    const baseUrls = getDblpBaseUrls();
    for (let i = 0; i < baseUrls.length; i++) {
        const baseUrl = baseUrls[i];
        const url = pathBuilder(baseUrl);
        try {
            const response = await requestJsonWithRetry(url, retries, baseDelayMs);
            if (response?.status === 200) {
                Zotero.debug(`[DBLP] Successfully fetched from ${baseUrl}`);
                return response;
            }
            const status = response?.status || "unknown";
            lastError = new Error(`DBLP HTTP ${status}: ${url}`);
            // 如果是 504/502，立即尝试下一个镜像（不延迟）
            if (status === 504 || status === 502) {
                Zotero.debug(`[DBLP] Gateway timeout (${status}) from ${baseUrl}, trying next mirror...`);
                continue;
            }
        } catch (e: any) {
            lastError = e;
            // 如果是 504/502 错误，立即尝试下一个镜像（不延迟）
            if (isGatewayTimeout(e)) {
                const status = extractHttpStatus(e) || "unknown";
                Zotero.debug(`[DBLP] Gateway timeout (${status}) from ${baseUrl}, trying next mirror...`);
                // 如果是最后一个镜像，抛出错误
                if (i < baseUrls.length - 1) {
                    continue;  // 尝试下一个镜像
                }
            }
        }
    }
    throw lastError;
}

async function requestTextWithFallback(
    pathBuilder: (baseUrl: string) => string,
    retries = 0,  // 减少重试次数，避免长时间等待
    baseDelayMs = 500
) {
    let lastError: any = null;
    const baseUrls = getDblpBaseUrls();
    let consecutive503Errors = 0; // 跟踪连续503错误次数
    
    for (let i = 0; i < baseUrls.length; i++) {
        const baseUrl = baseUrls[i];
        const url = pathBuilder(baseUrl);
        try {
            const response = await requestTextWithRetry(url, retries, baseDelayMs);
            if (response?.status === 200) {
                Zotero.debug(`[DBLP] Successfully fetched from ${baseUrl}`);
                return response;
            }
            const status = response?.status || "unknown";
            lastError = new Error(`DBLP HTTP ${status}: ${url}`);
            
            // 如果是 504/502，立即尝试下一个镜像（不延迟）
            if (status === 504 || status === 502) {
                Zotero.debug(`[DBLP] Gateway timeout (${status}) from ${baseUrl}, trying next mirror...`);
                continue;
            }
            
            // 如果是 503，记录并尝试下一个镜像（最多尝试2次）
            if (status === 503) {
                consecutive503Errors++;
                Zotero.debug(`[DBLP] Service unavailable (503) from ${baseUrl} (${consecutive503Errors}/${baseUrls.length}), trying next mirror...`);
                // 如果所有镜像都返回503，快速失败
                if (consecutive503Errors >= baseUrls.length) {
                    Zotero.debug(`[DBLP] All mirrors returned 503, giving up`);
                    throw new Error(`All DBLP mirrors unavailable (503)`);
                }
                await sleep(1000); // 短暂等待
                if (i < baseUrls.length - 1) {
                    continue;  // 尝试下一个镜像
                }
            }
            
            // 如果是 429，等待后尝试下一个镜像
            if (status === 429) {
                Zotero.debug(`[DBLP] Rate limit (429) from ${baseUrl}, waiting before next mirror...`);
                await sleep(3000); // 等待3秒
                if (i < baseUrls.length - 1) {
                    continue;  // 尝试下一个镜像
                }
            }
        } catch (e: any) {
            lastError = e;
            const status = extractHttpStatus(e);
            
            // 如果是 504/502 错误，立即尝试下一个镜像（不延迟）
            if (isGatewayTimeout(e)) {
                Zotero.debug(`[DBLP] Gateway timeout (${status || "unknown"}) from ${baseUrl}, trying next mirror...`);
                if (i < baseUrls.length - 1) {
                    continue;  // 尝试下一个镜像
                }
            }
            
            // 如果是 503 错误，记录并尝试下一个镜像
            if (isServiceUnavailable(e)) {
                consecutive503Errors++;
                Zotero.debug(`[DBLP] Service unavailable (503) from ${baseUrl} (${consecutive503Errors}/${baseUrls.length}), trying next mirror...`);
                // 如果所有镜像都返回503，快速失败
                if (consecutive503Errors >= baseUrls.length) {
                    Zotero.debug(`[DBLP] All mirrors returned 503, giving up`);
                    throw new Error(`All DBLP mirrors unavailable (503)`);
                }
                await sleep(1000); // 短暂等待
                if (i < baseUrls.length - 1) {
                    continue;  // 尝试下一个镜像
                }
            }
            
            // 如果是 429 错误，等待后尝试下一个镜像
            if (isRateLimitError(e)) {
                Zotero.debug(`[DBLP] Rate limit (429) from ${baseUrl}, waiting before next mirror...`);
                await sleep(3000); // 等待3秒
                if (i < baseUrls.length - 1) {
                    continue;  // 尝试下一个镜像
                }
            }
        }
    }
    throw lastError;
}

function extractAuthorsFromSearchXml(xmlText: string): Array<{ name: string; pid: string | null }> {
    try {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, "text/xml");
        const parserError = xmlDoc.querySelector("parsererror");
        if (parserError) return [];

        const hit = xmlDoc.querySelector("hits > hit");
        if (!hit) return [];

        const authorNodes = hit.querySelectorAll("info > authors > author");
        const authors: Array<{ name: string; pid: string | null }> = [];
        authorNodes.forEach((node: Element) => {
            const name = (node.textContent || "").trim();
            if (!name) return;
            const pid = node.getAttribute("pid");
            authors.push({ name, pid: pid ? pid.trim() : null });
        });
        return authors;
    } catch (e) {
        Zotero.debug(`[DBLP] Error parsing DBLP XML: ${e}`);
        return [];
    }
}

function extractOrcidFromXml(xmlText: string): string | null {
    try {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, "text/xml");
        const parserError = xmlDoc.querySelector("parsererror");
        if (parserError) return null;

        const root = xmlDoc.documentElement;
        const rootName = root?.getAttribute("name") || "";
        const normalizedRootName = normalizeNameForDblp(rootName);

        const authorNodes = xmlDoc.getElementsByTagName("author");
        if (normalizedRootName) {
            for (const node of Array.from(authorNodes) as Element[]) {
                const name = normalizeNameForDblp(node.textContent || "");
                if (name && name === normalizedRootName) {
                    const orcid = node.getAttribute("orcid");
                    if (orcid) return orcid.trim();
                }
            }
        }

        // Fallback: only return ORCID if there is exactly one unique ORCID in the XML
        const nodesWithOrcid = xmlDoc.querySelectorAll("[orcid]");
        const unique = new Set<string>();
        for (const node of Array.from(nodesWithOrcid)) {
            const orcid = (node as Element).getAttribute("orcid");
            if (orcid) unique.add(orcid.trim());
        }
        if (unique.size === 1) {
            return Array.from(unique)[0];
        }
    } catch (e) {
        Zotero.debug(`[DBLP] Error extracting ORCID from XML: ${e}`);
    }
    return null;
}

/**
 * Get author ORCID by DBLP PID
 */
export async function getAuthorOrcidByPid(pid: string): Promise<string | null> {
    if (!pid) return null;
    try {
        const response = await requestTextWithFallback(
            (baseUrl) => `${baseUrl}/pid/${pid}.xml`,
            1,
            1000
        );
        if (response.status !== 200) return null;
        const xmlText = response.response || "";
        return extractOrcidFromXml(xmlText);
    } catch (e) {
        Zotero.debug(`[DBLP] Error fetching ORCID for PID ${pid}: ${e}`);
        return null;
    }
}

/**
 * Search for a paper in DBLP by title and get authors
 * Returns authors with their PIDs if found
 */
export async function searchPaperByTitleAndGetAuthors(title: string): Promise<Array<{ pid: string; name: string }>> {
    try {
        // DBLP API endpoint for searching
        const query = encodeURIComponent(title);
        let data: DBLPResponse | null = null;
        try {
            const response = await requestJsonWithFallback(
                (baseUrl) => `${baseUrl}/search/publ/api?q=${query}&format=json&h=5`,
                1,
                1000
            );
            if (response.status === 200) {
                data = response.response as DBLPResponse;
            } else {
                Zotero.debug(`[DBLP] Search failed with status ${response.status}`);
            }
        } catch (e) {
            Zotero.debug(`[DBLP] JSON search failed, fallback to XML: ${e}`);
        }

        const authors: Array<{ pid: string; name: string }> = [];
        const seenNames = new Set<string>();
        let rawAuthors: Array<{ name: string; pid: string | null }> = [];

        if (data?.result?.hits?.hit) {
            const firstHit = data.result.hits.hit[0];
            Zotero.debug(`[DBLP] First hit title: ${firstHit?.info?.title}`);
            Zotero.debug(`[DBLP] First hit authors: ${JSON.stringify(firstHit?.info?.authors)}`);

            if (firstHit?.info?.authors?.author) {
                const authorList = Array.isArray(firstHit.info.authors.author)
                    ? firstHit.info.authors.author
                    : [firstHit.info.authors.author];

                rawAuthors = authorList.map((author) => {
                    if (typeof author === "string") {
                        return { name: author, pid: null };
                    }
                    if (author && typeof author === "object") {
                        // @ts-ignore - DBLP API may include @pid as an attribute
                        const pid = author["@pid"] || author.pid || null;
                        return { name: author.text || "", pid };
                    }
                    return { name: "", pid: null };
                }).filter((a) => a.name);
            }
        } else {
            try {
                const response = await requestTextWithFallback(
                    (baseUrl) => `${baseUrl}/search/publ/api?q=${query}&format=xml&h=5`,
                    1,
                    1000
                );
                if (response.status === 200) {
                    rawAuthors = extractAuthorsFromSearchXml(response.response || "");
                } else {
                    Zotero.debug(`[DBLP] XML search failed with status ${response.status}`);
                }
            } catch (e) {
                Zotero.debug(`[DBLP] XML search failed: ${e}`);
            }
        }

        if (rawAuthors.length === 0) {
            Zotero.debug(`[DBLP] No authors found in search results`);
            return [];
        }

        Zotero.debug(`[DBLP] Found ${rawAuthors.length} authors in paper`);

        for (const author of rawAuthors) {
            const authorName = (author.name || "").trim();
            if (!authorName) continue;

            const nameKey = authorName.toLowerCase();
            if (seenNames.has(nameKey)) {
                Zotero.debug(`[DBLP] Skipping duplicate author: ${authorName}`);
                continue;
            }
            seenNames.add(nameKey);

            let authorPid = author.pid;
            if (!authorPid) {
                Zotero.debug(`[DBLP] PID not in author object, searching for: ${authorName}`);
                authorPid = await searchAuthorByName(authorName);
            } else {
                Zotero.debug(`[DBLP] Found PID in author object: ${authorPid} for ${authorName}`);
            }

            if (authorPid) {
                authors.push({
                    pid: authorPid,
                    name: authorName
                });
                Zotero.debug(`[DBLP] Added author: ${authorName} (PID: ${authorPid})`);
            } else {
                Zotero.debug(`[DBLP] Could not find PID for author: ${authorName}`);
            }
        }

        Zotero.debug(`[DBLP] Total authors found with PIDs: ${authors.length}`);
        return authors;
    } catch (e) {
        Zotero.debug(`[DBLP] Error searching paper: ${e}`);
        return [];
    }
}

/**
 * Get author PID by searching for author name
 * This is a helper function, but we'll use searchAuthorByName instead
 */
async function getAuthorPID(authorName: string): Promise<string | null> {
    return searchAuthorByName(authorName);
}

/**
 * Get all papers by author PID
 */
export async function getPapersByAuthorPID(pid: string): Promise<DBLPPaper[]> {
    try {
        // DBLP API endpoint for author publications
        // Format: https://dblp.org/pid/{pid}.xml
        // Note: DBLP doesn't provide JSON format directly, we need to parse XML
        // 不重试，直接尝试所有镜像（504错误会立即切换镜像）
        const response = await requestTextWithFallback(
            (baseUrl) => `${baseUrl}/pid/${pid}.xml`,
            0,  // 不重试，直接切换镜像
            0   // 无延迟
        );

        if (response.status !== 200) {
            Zotero.debug(`[DBLP] Failed to get papers for PID ${pid}: status ${response.status}`);
            return [];  // 返回空数组，不抛出异常
        }

        const xmlText = response.response;
        Zotero.debug(`[DBLP] Received XML response, length: ${xmlText.length} characters`);
        if (xmlText.length > 0) {
            Zotero.debug(`[DBLP] XML preview (first 500 chars): ${xmlText.substring(0, 500)}`);
        }

        const papers = parseDBLPXML(xmlText);
        Zotero.debug(`[DBLP] Parsed ${papers.length} papers for PID ${pid}`);

        return papers;
    } catch (e: any) {
        const status = extractHttpStatus(e) || "unknown";
        Zotero.debug(`[DBLP] Error getting papers by PID ${pid} (status: ${status}): ${e}`);
        // 返回空数组而不是抛出异常，这样至少可以显示作者
        return [];
    }
}


/**
 * Parse DBLP XML response
 */
function parseDBLPXML(xmlText: string): DBLPPaper[] {
    const papers: DBLPPaper[] = [];

    try {
        // Parse XML using DOMParser
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, "text/xml");

        // Check for parsing errors
        const parserError = xmlDoc.querySelector("parsererror");
        if (parserError) {
            Zotero.debug(`[DBLP] XML parsing error: ${parserError.textContent}`);
            Zotero.debug(`[DBLP] XML content (first 500 chars): ${xmlText.substring(0, 500)}`);
            return [];
        }

        // DBLP XML structure: <dblpperson><r>...</r></dblpperson>
        // Try different possible structures
        let publications = xmlDoc.querySelectorAll("r");

        // If no <r> tags found, try other structures
        if (publications.length === 0) {
            // Try <article>, <inproceedings>, <proceedings>, <book>, etc.
            publications = xmlDoc.querySelectorAll("article, inproceedings, proceedings, book, incollection, phdthesis, mastersthesis");
            Zotero.debug(`[DBLP] No <r> tags found, trying other publication types, found: ${publications.length}`);
        }

        Zotero.debug(`[DBLP] Found ${publications.length} publications in XML`);

        for (const pub of publications) {
            const key = pub.getAttribute("key") || "";
            const publtype = pub.getAttribute("publtype") || "";

            // Try different ways to get title
            let title = "";
            const titleElem = pub.querySelector("title");
            if (titleElem) {
                title = titleElem.textContent?.trim() || "";
            }
            // If no title found, try to get from text content
            if (!title && pub.textContent) {
                // This is a fallback, might not work well
                const text = pub.textContent.trim();
                const titleMatch = text.match(/<title[^>]*>(.*?)<\/title>/i);
                if (titleMatch) {
                    title = titleMatch[1].trim();
                }
            }

            // Debug: log if key is missing
            if (!key && title) {
                Zotero.debug(`[DBLP] Paper without key: ${title.substring(0, 50)}`);
            }

            const yearElem = pub.querySelector("year");
            const year = yearElem?.textContent?.trim() || "";

            // Try different venue fields
            let venue = "";
            const venueElem = pub.querySelector("venue, journal, booktitle, publisher");
            if (venueElem) {
                venue = venueElem.textContent?.trim() || "";
            }

            const doiElem = pub.querySelector("doi");
            const doi = doiElem?.textContent?.trim() || "";

            const urlElem = pub.querySelector("url");
            const url = urlElem?.textContent?.trim() || "";

            const eeElem = pub.querySelector("ee");
            const ee = eeElem?.textContent?.trim() || "";

            const authors: string[] = [];
            const authorElems = pub.querySelectorAll("author");
            for (const authorElem of authorElems) {
                const authorName = authorElem.textContent?.trim();
                if (authorName) {
                    authors.push(authorName);
                }
            }

            if (title) {
                papers.push({
                    key,
                    title,
                    year,
                    authors: authors.length > 0 ? authors : undefined,
                    venue,
                    type: publtype,
                    doi,
                    url,
                    ee
                });
            } else {
                Zotero.debug(`[DBLP] Skipping publication without title, key: ${key}`);
            }
        }

        Zotero.debug(`[DBLP] Parsed ${papers.length} papers from XML`);
    } catch (e) {
        Zotero.debug(`[DBLP] Error parsing XML: ${e}`);
        Zotero.debug(`[DBLP] Error stack: ${(e as Error).stack}`);
    }

    return papers;
}

/**
 * Get authors from Zotero item
 */
export function getAuthorsFromItem(item: Zotero.Item): Array<{ firstName: string; lastName: string; fullName: string }> {
    const authors: Array<{ firstName: string; lastName: string; fullName: string }> = [];

    try {
        if (!item) {
            Zotero.debug(`[DBLP] getAuthorsFromItem: item is null or undefined`);
            return authors;
        }

        // Check if item is an attachment, if so get parent
        let actualItem = item;
        if (item.isAttachment && item.isAttachment()) {
            Zotero.debug(`[DBLP] Item ${item.id} is attachment, getting parent`);
            const parentID = item.parentItemID;
            if (parentID) {
                try {
                    const parent = Zotero.Items.get(parentID);
                    if (parent) {
                        actualItem = parent;
                        Zotero.debug(`[DBLP] Got parent item ${parent.id} for attachment ${item.id}`);
                    } else {
                        Zotero.debug(`[DBLP] Parent item ${parentID} not found`);
                    }
                } catch (e) {
                    Zotero.debug(`[DBLP] Error getting parent item: ${e}`);
                }
            } else {
                Zotero.debug(`[DBLP] Attachment ${item.id} has no parentItemID`);
            }
        }

        // Get creators
        let creators: any[] = [];
        try {
            creators = actualItem.getCreators();
            Zotero.debug(`[DBLP] getCreators() returned ${creators.length} creators for item ${actualItem.id} (type: ${actualItem.itemType})`);
        } catch (e) {
            Zotero.debug(`[DBLP] Error calling getCreators(): ${e}`);
            return authors;
        }

        if (creators.length === 0) {
            Zotero.debug(`[DBLP] No creators found. Item info: id=${actualItem.id}, type=${actualItem.itemType}, title=${actualItem.getField('title')}`);
            // Try alternative method to get creators
            try {
                // @ts-ignore - try alternative API (creators property may exist in some contexts)
                if ((actualItem as any).creators) {
                    // @ts-ignore
                    creators = (actualItem as any).creators;
                    Zotero.debug(`[DBLP] Using alternative creators property, found ${creators.length} creators`);
                }
            } catch (e) {
                Zotero.debug(`[DBLP] Alternative creator access failed: ${e}`);
            }
        }

        for (const creator of creators) {
            // Process all creator types, but prioritize authors
            // Get creator type name from creatorTypeID
            let creatorTypeName = "author";
            if (creator.creatorTypeID) {
                try {
                    creatorTypeName = Zotero.CreatorTypes.getName(creator.creatorTypeID);
                } catch (e) {
                    Zotero.debug(`[DBLP] Error getting creator type name: ${e}`);
                }
            }

            // Skip if it's clearly not an author (like editor, translator, etc.)
            if (creatorTypeName !== "author" && creatorTypeName !== "contributor" && creatorTypeName !== "director") {
                Zotero.debug(`[DBLP] Skipping creator type: ${creatorTypeName}`);
                continue;
            }

            if (creator.firstName && creator.lastName) {
                authors.push({
                    firstName: creator.firstName,
                    lastName: creator.lastName,
                    fullName: `${creator.firstName} ${creator.lastName}`.trim()
                });
            } else if (creator.lastName) {
                authors.push({
                    firstName: "",
                    lastName: creator.lastName,
                    fullName: creator.lastName
                });
            } else if (creator.firstName) {
                // Some items might only have firstName
                authors.push({
                    firstName: creator.firstName,
                    lastName: "",
                    fullName: creator.firstName
                });
            } else {
                // Log if we have a creator with no name
                Zotero.debug(`[DBLP] Creator with no name: ${JSON.stringify(creator)}`);
            }
        }

        Zotero.debug(`[DBLP] Extracted ${authors.length} authors: ${authors.map(a => a.fullName).join(', ')}`);
    } catch (e) {
        Zotero.debug(`[DBLP] Error getting authors from item: ${e}`);
        Zotero.debug(`[DBLP] Error stack: ${(e as Error).stack}`);
    }

    return authors;
}

/**
 * Search for author by name in DBLP
 */
export async function searchAuthorByName(authorName: string): Promise<string | null> {
    try {
        const query = encodeURIComponent(authorName);
        const response = await requestJsonWithFallback(
            (baseUrl) => `${baseUrl}/search/author/api?q=${query}&format=json&h=5`,
            1,
            1000
        );
        if (response.status !== 200) return null;
        const data = response.response as any;
        if (data.result?.hits?.hit) {
            const firstHit = data.result.hits.hit[0];
            if (firstHit?.info?.pid) {
                return firstHit.info.pid;
            }
        }

        return null;
    } catch (e) {
        Zotero.debug(`[DBLP] Error searching author: ${e}`);
        return null;
    }
}

/**
 * Check if an item is already in a collection
 */
async function isItemInCollection(itemID: number, collectionID: number): Promise<boolean> {
    try {
        // @ts-ignore
        const checkResult = await Zotero.DB.valueQueryAsync(
            "SELECT COUNT(*) FROM collectionItems WHERE collectionID = ? AND itemID = ?",
            [collectionID, itemID]
        );
        return Number(checkResult) > 0;
    } catch (e) {
        Zotero.debug(`[DBLP] Error checking if item ${itemID} is in collection ${collectionID}: ${e}`);
        return false;
    }
}

/**
 * Check if a paper already exists in Zotero library
 */
async function checkPaperExists(paper: DBLPPaper): Promise<Zotero.Item | null> {
    try {
        if (paper.title) {
            const search = new Zotero.Search();
            search.addCondition("title", "is", paper.title);
            const results = await search.search();

            if (results && results.length > 0) {
                for (const itemID of results) {
                    const item = Zotero.Items.get(itemID);
                    if (item) {
                        // Get title from PDF
                        const itemTitle = await getPDFTitle(item) || "";
                        if (itemTitle === paper.title) {
                            if (paper.doi) {
                                const itemDOI = item.getField("DOI");
                                if (itemDOI === paper.doi) {
                                    return item;
                                }
                            } else if (paper.year) {
                                const itemYear = item.getField("date");
                                if (itemYear && itemYear.substring(0, 4) === paper.year) {
                                    return item;
                                }
                            } else {
                                return item;
                            }
                        }
                    }
                }
            }
        }

        if (paper.key) {
            const search = new Zotero.Search();
            search.addCondition("extra", "contains", `DBLP: ${paper.key}`);
            const results = await search.search();

            if (results && results.length > 0) {
                return Zotero.Items.get(results[0]);
            }
        }

        return null;
    } catch (e) {
        Zotero.debug(`[DBLP] Error checking if paper exists: ${e}`);
        return null;
    }
}

/**
 * Import a DBLP paper into Zotero library
 */
export async function importPaperToZotero(paper: DBLPPaper): Promise<Zotero.Item | null> {
    try {
        // Check if paper already exists
        const existingItem = await checkPaperExists(paper);
        if (existingItem) {
            Zotero.debug(`[DBLP] Paper already exists: ${paper.title}`);
            return existingItem;
        }

        // Create a new journal article item
        const item = new Zotero.Item("journalArticle");

        // Set title
        if (paper.title) {
            item.setField("title", paper.title);
        }

        // Set year
        if (paper.year) {
            item.setField("date", paper.year);
        }

        // Set venue/journal
        if (paper.venue) {
            item.setField("publicationTitle", paper.venue);
        }

        // Set DOI
        if (paper.doi) {
            item.setField("DOI", paper.doi);
        }

        // Set URL
        if (paper.url) {
            item.setField("url", paper.url);
        } else if (paper.ee) {
            item.setField("url", paper.ee);
        }

        // Set authors
        if (paper.authors && paper.authors.length > 0) {
            const creators = paper.authors.map(authorName => {
                // Try to parse author name (format: "First Last" or "Last, First")
                let firstName = "";
                let lastName = "";

                if (authorName.includes(",")) {
                    // Format: "Last, First"
                    const parts = authorName.split(",").map(s => s.trim());
                    lastName = parts[0] || "";
                    firstName = parts[1] || "";
                } else {
                    // Format: "First Last" or just "Last"
                    const parts = authorName.trim().split(/\s+/);
                    if (parts.length > 1) {
                        firstName = parts.slice(0, -1).join(" ");
                        lastName = parts[parts.length - 1];
                    } else {
                        lastName = parts[0] || "";
                    }
                }

                return {
                    firstName: firstName,
                    lastName: lastName,
                    creatorType: "author" as const
                };
            });

            item.setCreators(creators);
        }

        // Set extra field with DBLP key
        if (paper.key) {
            item.setField("extra", `DBLP: ${paper.key}`);
        }

        // Save the item to the library
        await item.saveTx();

        Zotero.debug(`[DBLP] Successfully imported paper: ${paper.title}`);
        return item;
    } catch (e) {
        Zotero.debug(`[DBLP] Error importing paper to Zotero: ${e}`);
        return null;
    }
}

/**
 * Import a paper and add it to a collection
 */
async function importPaperToZoteroWithCollection(
    paper: DBLPPaper,
    collectionID: number
): Promise<Zotero.Item | null> {
    try {
        Zotero.debug(`[DBLP] [importPaperToZoteroWithCollection] Starting for paper: "${paper.title}" (key: ${paper.key || "N/A"})`);
        // First, check if paper already exists
        const existingItem = await checkPaperExists(paper);
        if (existingItem) {
            Zotero.debug(`[DBLP] [importPaperToZoteroWithCollection] Paper already exists in library: ${paper.title} (ID: ${existingItem.id})`);

            // Check if item is already in the collection using API (most reliable)
            try {
                // @ts-ignore
                const collection = Zotero.Collections.get(collectionID);
                if (collection) {
                    // @ts-ignore
                    const collectionItemIDs: number[] = collection.getChildItems ? collection.getChildItems() : [];
                    Zotero.debug(`[DBLP] [importPaperToZoteroWithCollection] Collection ${collectionID} has ${collectionItemIDs.length} items via API`);
                    if (collectionItemIDs.includes(existingItem.id)) {
                        Zotero.debug(`[DBLP] [importPaperToZoteroWithCollection] ✓ Paper already in collection ${collectionID} (via API), skipping: ${paper.title}`);
                        return null; // Return null to indicate it was skipped (already in collection)
                    } else {
                        Zotero.debug(`[DBLP] [importPaperToZoteroWithCollection] Item ${existingItem.id} NOT in collection via API, checking DB...`);
                    }
                }
            } catch (e) {
                Zotero.debug(`[DBLP] [importPaperToZoteroWithCollection] Error checking if item is in collection: ${e}`);
            }

            // Item exists but not in collection, add it
            // But first, double-check using DB query to ensure it's really not in collection
            try {
                // @ts-ignore
                const dbCheck = await Zotero.DB.queryAsync(
                    "SELECT itemID FROM collectionItems WHERE collectionID = ? AND itemID = ?",
                    [collectionID, existingItem.id]
                );
                Zotero.debug(`[DBLP] [importPaperToZoteroWithCollection] DB check result: ${JSON.stringify(dbCheck)}`);

                // Check if item is already in collection (via DB)
                if (Array.isArray(dbCheck) && dbCheck.length > 0) {
                    Zotero.debug(`[DBLP] [importPaperToZoteroWithCollection] ✓ Item ${existingItem.id} already in collection ${collectionID} (verified via DB), skipping: ${paper.title}`);
                    return null; // Return null to indicate it was skipped (already in collection)
                } else {
                    Zotero.debug(`[DBLP] [importPaperToZoteroWithCollection] DB check shows item ${existingItem.id} NOT in collection`);
                }

                // Also check via API one more time before adding
                // @ts-ignore
                const collection = Zotero.Collections.get(collectionID);
                if (collection) {
                    // @ts-ignore
                    const collectionItemIDs: number[] = collection.getChildItems ? collection.getChildItems() : [];
                    Zotero.debug(`[DBLP] [importPaperToZoteroWithCollection] API check: collection has ${collectionItemIDs.length} items`);
                    if (collectionItemIDs.includes(existingItem.id)) {
                        Zotero.debug(`[DBLP] [importPaperToZoteroWithCollection] ✓ Item ${existingItem.id} already in collection ${collectionID} (verified via API), skipping: ${paper.title}`);
                        return null; // Return null to indicate it was skipped (already in collection)
                    } else {
                        Zotero.debug(`[DBLP] [importPaperToZoteroWithCollection] API check confirms item ${existingItem.id} NOT in collection, will add it`);
                    }
                }

                // Item is confirmed not in collection, add it
                // Use DB query directly - this is the most reliable method
                // @ts-ignore
                const result = await Zotero.DB.queryAsync(
                    "INSERT OR IGNORE INTO collectionItems (collectionID, itemID) VALUES (?, ?)",
                    [collectionID, existingItem.id]
                );
                Zotero.debug(`[DBLP] DB insert result for existing item ${existingItem.id}: ${result}`);

                // Force reload collection to get updated state
                // @ts-ignore
                const reloadedCollection = Zotero.Collections.get(collectionID);
                if (reloadedCollection) {
                    // @ts-ignore
                    if (reloadedCollection.reload) {
                        // @ts-ignore
                        await reloadedCollection.reload();
                    }

                    // Verify by checking with API after reload
                    // @ts-ignore
                    const collectionItemIDs: number[] = reloadedCollection.getChildItems ? reloadedCollection.getChildItems() : [];
                    if (collectionItemIDs.includes(existingItem.id)) {
                        Zotero.debug(`[DBLP] Verified: Existing item ${existingItem.id} is now in collection ${collectionID}`);
                        return existingItem; // Return item to indicate success
                    } else {
                        // Even if API doesn't show it, if DB insert succeeded, we consider it added
                        // This handles the case where API is out of sync
                        Zotero.debug(`[DBLP] Item ${existingItem.id} added via DB but not yet visible in API (API may be out of sync)`);
                        return existingItem; // Return item to indicate success
                    }
                } else {
                    Zotero.debug(`[DBLP] Collection ${collectionID} not found after reload`);
                    return null;
                }
            } catch (e) {
                Zotero.debug(`[DBLP] Error adding existing item to collection: ${e}`);
                Zotero.debug(`[DBLP] Error stack: ${(e as Error).stack}`);
                return null;
            }
        }

        // Paper doesn't exist yet, but before creating, double-check if there's a similar paper already in collection
        // This prevents creating duplicates with slightly different titles
        // Use both API and DB query to ensure comprehensive check
        Zotero.debug(`[DBLP] [importPaperToZoteroWithCollection] Paper does NOT exist in library, checking collection before creating...`);
        if (paper.title || paper.key) {
            try {
                // First check via DB query (most reliable for existence check)
                if (paper.key) {
                    Zotero.debug(`[DBLP] [importPaperToZoteroWithCollection] Checking DB for DBLP key: ${paper.key}`);
                    // @ts-ignore
                    const dbCheck = await Zotero.DB.queryAsync(
                        `SELECT ci.itemID FROM collectionItems ci 
                         JOIN items i ON ci.itemID = i.itemID 
                         WHERE ci.collectionID = ? AND i.extra LIKE ?`,
                        [collectionID, `%DBLP: ${paper.key}%`]
                    );
                    Zotero.debug(`[DBLP] [importPaperToZoteroWithCollection] DB check for key result: ${JSON.stringify(dbCheck)}`);
                    if (Array.isArray(dbCheck) && dbCheck.length > 0) {
                        Zotero.debug(`[DBLP] [importPaperToZoteroWithCollection] ✓ Paper with same DBLP key already in collection (verified via DB), skipping: ${paper.title}`);
                        return null; // Skip creating duplicate
                    }
                }

                // Also check via API for title matching
                // @ts-ignore
                const collection = Zotero.Collections.get(collectionID);
                if (collection) {
                    // @ts-ignore
                    const collectionItemIDs: number[] = collection.getChildItems ? collection.getChildItems() : [];
                    Zotero.debug(`[DBLP] [importPaperToZoteroWithCollection] Checking ${collectionItemIDs.length} items in collection via API for title/key match...`);
                    for (const itemID of collectionItemIDs) {
                        const item = Zotero.Items.get(itemID);
                        if (item) {
                            const itemTitle = item.getField("title");
                            // Check if title matches (case-insensitive, trimmed)
                            if (paper.title && itemTitle && itemTitle.toLowerCase().trim() === paper.title.toLowerCase().trim()) {
                                Zotero.debug(`[DBLP] [importPaperToZoteroWithCollection] ✓ Paper with same title already in collection (itemID: ${itemID}), skipping: ${paper.title}`);
                                return null; // Skip creating duplicate
                            }

                            // Also check by DBLP key if available
                            if (paper.key) {
                                const extra = item.getField("extra");
                                if (extra && extra.includes(`DBLP: ${paper.key}`)) {
                                    Zotero.debug(`[DBLP] [importPaperToZoteroWithCollection] ✓ Paper with same DBLP key already in collection (itemID: ${itemID}), skipping: ${paper.title}`);
                                    return null; // Skip creating duplicate
                                }
                            }
                        }
                    }
                    Zotero.debug(`[DBLP] [importPaperToZoteroWithCollection] No matches found in collection, will create new item`);
                }
            } catch (e) {
                Zotero.debug(`[DBLP] [importPaperToZoteroWithCollection] Error checking collection before creating paper: ${e}`);
            }
        }

        // Create a new journal article item
        Zotero.debug(`[DBLP] [importPaperToZoteroWithCollection] Creating new journal article item...`);
        const item = new Zotero.Item("journalArticle");

        // Set title
        if (paper.title) {
            item.setField("title", paper.title);
        }

        // Set year
        if (paper.year) {
            item.setField("date", paper.year);
        }

        // Set venue/journal
        if (paper.venue) {
            item.setField("publicationTitle", paper.venue);
        }

        // Set DOI
        if (paper.doi) {
            item.setField("DOI", paper.doi);
        }

        // Set URL
        if (paper.url) {
            item.setField("url", paper.url);
        } else if (paper.ee) {
            item.setField("url", paper.ee);
        }

        // Set authors
        if (paper.authors && paper.authors.length > 0) {
            const creators = paper.authors.map(authorName => {
                // Try to parse author name (format: "First Last" or "Last, First")
                let firstName = "";
                let lastName = "";

                if (authorName.includes(",")) {
                    // Format: "Last, First"
                    const parts = authorName.split(",").map(s => s.trim());
                    lastName = parts[0] || "";
                    firstName = parts[1] || "";
                } else {
                    // Format: "First Last" or just "Last"
                    const parts = authorName.trim().split(/\s+/);
                    if (parts.length > 1) {
                        firstName = parts.slice(0, -1).join(" ");
                        lastName = parts[parts.length - 1];
                    } else {
                        lastName = parts[0] || "";
                    }
                }

                return {
                    firstName: firstName,
                    lastName: lastName,
                    creatorType: "author" as const
                };
            });

            item.setCreators(creators);
        }

        // Set extra field with DBLP key
        if (paper.key) {
            item.setField("extra", `DBLP: ${paper.key}`);
        }

        // Save the item to the library
        await item.saveTx();
        Zotero.debug(`[DBLP] [importPaperToZoteroWithCollection] Saved new item to library: ID=${item.id}, Title="${item.getField('title')}"`);

        // Before adding to collection, check if it's already in the collection using API
        try {
            // @ts-ignore
            const collection = Zotero.Collections.get(collectionID);
            if (collection) {
                // @ts-ignore
                const collectionItemIDs: number[] = collection.getChildItems ? collection.getChildItems() : [];
                Zotero.debug(`[DBLP] [importPaperToZoteroWithCollection] Checking if newly created item ${item.id} is already in collection (${collectionItemIDs.length} items)...`);
                if (collectionItemIDs.includes(item.id)) {
                    Zotero.debug(`[DBLP] [importPaperToZoteroWithCollection] ✓ Newly created item ${item.id} is already in collection ${collectionID}, skipping: ${paper.title}`);
                    return null; // Skip adding to collection
                } else {
                    Zotero.debug(`[DBLP] [importPaperToZoteroWithCollection] Newly created item ${item.id} is NOT in collection, will add it`);
                }
            }
        } catch (e) {
            Zotero.debug(`[DBLP] [importPaperToZoteroWithCollection] Error checking if newly created item is in collection: ${e}`);
        }

        // Add to collection - use database query (most reliable method)
        try {
            // @ts-ignore
            let collection = Zotero.Collections.get(collectionID);
            if (!collection) {
                Zotero.debug(`[DBLP] Collection ${collectionID} not found`);
                return item;
            }

            // Double check if item is already in collection (using collection API)
            // @ts-ignore - getChildItems returns array of item IDs (numbers)
            const existingItemIDs: number[] = collection.getChildItems ? collection.getChildItems() : [];
            if (existingItemIDs.includes(item.id)) {
                Zotero.debug(`[DBLP] Item ${item.id} already in collection ${collectionID}`);
                return null; // Return null to indicate it was skipped
            }

            // Use Zotero.DB to directly insert into collectionItems table
            try {
                // @ts-ignore
                await Zotero.DB.queryAsync(
                    "INSERT OR IGNORE INTO collectionItems (collectionID, itemID) VALUES (?, ?)",
                    [collectionID, item.id]
                );
                Zotero.debug(`[DBLP] Added item ${item.id} to collection ${collectionID} via DB query`);

                // Verify by reloading collection
                // @ts-ignore
                collection = Zotero.Collections.get(collectionID);
                // @ts-ignore - getChildItems returns array of item IDs (numbers)
                const verifyItemIDs: number[] = collection.getChildItems ? collection.getChildItems() : [];
                if (verifyItemIDs.includes(item.id)) {
                    Zotero.debug(`[DBLP] Verified: Item ${item.id} is now in collection ${collectionID} (${verifyItemIDs.length} items total)`);
                } else {
                    Zotero.debug(`[DBLP] WARNING: Item ${item.id} not found in collection after DB insert`);
                }
            } catch (dbError) {
                Zotero.debug(`[DBLP] DB query method failed: ${dbError}, trying collection API`);

                // Fallback: Try to modify collection.itemIDs and save
                // @ts-ignore - getChildItems returns array of item IDs (numbers)
                const currentItemIDs: number[] = collection.getChildItems ? collection.getChildItems() : [];
                if (!currentItemIDs.includes(item.id)) {
                    // @ts-ignore
                    if (collection.itemIDs) {
                        // @ts-ignore
                        collection.itemIDs.push(item.id);
                    } else {
                        // @ts-ignore
                        collection.itemIDs = [...currentItemIDs, item.id];
                    }

                    // Mark collection as changed and save
                    // @ts-ignore
                    if (collection.saveTx) {
                        await collection.saveTx();
                    } else {
                        // @ts-ignore
                        await Zotero.DB.queryAsync(
                            "INSERT OR IGNORE INTO collectionItems (collectionID, itemID) VALUES (?, ?)",
                            [collectionID, item.id]
                        );
                    }
                    Zotero.debug(`[DBLP] Added item ${item.id} via collection API`);
                }
            }
        } catch (e) {
            Zotero.debug(`[DBLP] Error adding item to collection: ${e}`);
            Zotero.debug(`[DBLP] Error details: ${(e as Error).message}`);
            Zotero.debug(`[DBLP] Error stack: ${(e as Error).stack}`);
        }

        Zotero.debug(`[DBLP] Successfully imported paper: ${paper.title}`);
        return item;
    } catch (e) {
        Zotero.debug(`[DBLP] Error importing paper to Zotero: ${e}`);
        return null;
    }
}

/**
 * Import multiple papers and add them to a collection
 */
export async function importPapersToCollection(
    papers: DBLPPaper[],
    collectionName: string
): Promise<{ success: number; failed: number; collection: Zotero.Collection | null }> {
    let success = 0;
    let failed = 0;
    let collection: Zotero.Collection | null = null;

    try {
        // Get or create collection first
        const libraryID = Zotero.Libraries.userLibraryID;

        // Check if collection already exists
        // @ts-ignore
        const existingCollections = Zotero.Collections.getByLibrary(libraryID);
        collection = existingCollections.find((c: Zotero.Collection) => c.name === collectionName) || null;

        if (!collection) {
            // Create new collection
            // @ts-ignore
            collection = new Zotero.Collection();
            collection.name = collectionName;
            // @ts-ignore
            collection.libraryID = libraryID;
            await collection.saveTx();
            Zotero.debug(`[DBLP] Created collection: ${collectionName} (ID: ${collection.id})`);
        } else {
            Zotero.debug(`[DBLP] Using existing collection: ${collectionName} (ID: ${collection.id})`);
        }

        // Deduplicate papers before importing (using key or title as unique identifier)
        const seenPapers = new Set<string>();
        const uniquePapers: DBLPPaper[] = [];

        for (const paper of papers) {
            const paperId = paper.key || (paper.title ? paper.title.toLowerCase().trim() : "");
            if (paperId && !seenPapers.has(paperId)) {
                seenPapers.add(paperId);
                uniquePapers.push(paper);
            } else {
                Zotero.debug(`[DBLP] Skipping duplicate paper in batch: ${paper.title}`);
            }
        }

        Zotero.debug(`[DBLP] After deduplication: ${uniquePapers.length} unique papers out of ${papers.length} total`);

        // Build a map of existing papers in the collection before importing
        // This will be used to quickly check if a paper is already in the collection
        // Use Zotero API to get items (most reliable, reflects actual collection state)
        let existingItemIDs: number[] = [];
        try {
            // Use Zotero API method first (most reliable, reflects actual collection state)
            // @ts-ignore
            existingItemIDs = collection.getChildItems ? collection.getChildItems() : [];
            Zotero.debug(`[DBLP] Found ${existingItemIDs.length} items in collection ${collectionName} (ID: ${collection.id}) via API`);

            // Double-check with database query to see if there's a discrepancy
            try {
                // @ts-ignore
                const dbResult = await Zotero.DB.queryAsync(
                    "SELECT itemID FROM collectionItems WHERE collectionID = ?",
                    [collection.id]
                );
                let dbItemIDs: number[] = [];
                if (Array.isArray(dbResult)) {
                    dbItemIDs = dbResult.map((row: any) => {
                        if (Array.isArray(row)) {
                            return row[0];
                        } else if (row && typeof row === 'object' && 'itemID' in row) {
                            return row.itemID;
                        } else {
                            return row;
                        }
                    }).filter((id: any) => id != null && !isNaN(Number(id)));
                }
                if (dbItemIDs.length !== existingItemIDs.length) {
                    Zotero.debug(`[DBLP] WARNING: API returned ${existingItemIDs.length} items but DB query returned ${dbItemIDs.length} items.`);
                    // If API returns 0 but DB has items, or if there's a significant discrepancy, use DB result
                    // DB is the source of truth, API might be out of sync
                    if (existingItemIDs.length === 0 && dbItemIDs.length > 0) {
                        Zotero.debug(`[DBLP] API returned 0 items but DB has ${dbItemIDs.length} items. Using DB result as source of truth.`);
                        existingItemIDs = dbItemIDs;
                    } else if (Math.abs(dbItemIDs.length - existingItemIDs.length) > existingItemIDs.length * 0.1) {
                        // If discrepancy is more than 10%, prefer DB result
                        Zotero.debug(`[DBLP] Significant discrepancy detected (${Math.abs(dbItemIDs.length - existingItemIDs.length)} items difference). Using DB result.`);
                        existingItemIDs = dbItemIDs;
                    } else {
                        Zotero.debug(`[DBLP] Minor discrepancy, keeping API result.`);
                    }
                }
            } catch (dbError) {
                Zotero.debug(`[DBLP] Could not verify with DB query: ${dbError}`);
            }
        } catch (e) {
            Zotero.debug(`[DBLP] Error getting items via API: ${e}, trying DB query`);
            // Fallback to database query
            try {
                // @ts-ignore
                const dbResult = await Zotero.DB.queryAsync(
                    "SELECT itemID FROM collectionItems WHERE collectionID = ?",
                    [collection.id]
                );
                if (Array.isArray(dbResult)) {
                    existingItemIDs = dbResult.map((row: any) => {
                        if (Array.isArray(row)) {
                            return row[0];
                        } else if (row && typeof row === 'object' && 'itemID' in row) {
                            return row.itemID;
                        } else {
                            return row;
                        }
                    }).filter((id: any) => id != null && !isNaN(Number(id)));
                }
                Zotero.debug(`[DBLP] Found ${existingItemIDs.length} items in collection via DB query (fallback)`);
            } catch (dbError) {
                Zotero.debug(`[DBLP] Error querying collection items from DB: ${dbError}`);
            }
        }

        const existingItemIDsSet = new Set(existingItemIDs);

        // Build maps for quick lookup: title -> itemID, key -> itemID
        const existingTitlesMap = new Map<string, number>(); // lowercase title -> itemID
        const existingKeysMap = new Map<string, number>(); // DBLP key -> itemID

        Zotero.debug(`[DBLP] Processing ${existingItemIDs.length} existing items in collection to build lookup maps...`);

        // Process items to build lookup maps
        // Since we're using API method, items should already be in collection, but verify anyway
        for (const itemID of existingItemIDs) {
            try {
                const item = Zotero.Items.get(itemID);
                if (item) {
                    // Map by title
                    const title = item.getField("title");
                    if (title) {
                        const titleKey = title.toLowerCase().trim();
                        existingTitlesMap.set(titleKey, itemID);
                        Zotero.debug(`[DBLP] Mapped title: "${title}" -> itemID ${itemID}`);
                    }

                    // Map by DBLP key
                    const extra = item.getField("extra");
                    if (extra && extra.includes("DBLP:")) {
                        const keyMatch = extra.match(/DBLP:\s*([^\s\n]+)/);
                        if (keyMatch && keyMatch[1]) {
                            const dblpKey = keyMatch[1];
                            existingKeysMap.set(dblpKey, itemID);
                            Zotero.debug(`[DBLP] Mapped DBLP key: "${dblpKey}" -> itemID ${itemID}`);
                        }
                    }
                } else {
                    Zotero.debug(`[DBLP] Warning: Item ${itemID} not found in library`);
                }
            } catch (e) {
                Zotero.debug(`[DBLP] Error processing existing item ${itemID}: ${e}`);
            }
        }

        Zotero.debug(`[DBLP] Collection ${collectionName} currently has ${existingItemIDs.length} items`);
        Zotero.debug(`[DBLP] Built lookup maps: ${existingTitlesMap.size} titles, ${existingKeysMap.size} keys`);

        // Log some sample keys and titles for debugging
        if (existingKeysMap.size > 0) {
            const sampleKeys = Array.from(existingKeysMap.keys()).slice(0, 3);
            Zotero.debug(`[DBLP] Sample DBLP keys in collection: ${sampleKeys.join(", ")}`);
        }
        if (existingTitlesMap.size > 0) {
            const sampleTitles = Array.from(existingTitlesMap.keys()).slice(0, 3);
            Zotero.debug(`[DBLP] Sample titles in collection: ${sampleTitles.join(", ")}`);
        }

        // Import papers and add to collection
        Zotero.debug(`[DBLP] ========== Starting to import ${uniquePapers.length} papers to collection "${collectionName}" (ID: ${collection.id}) ==========`);
        Zotero.debug(`[DBLP] Collection currently has ${existingItemIDs.length} items`);
        Zotero.debug(`[DBLP] Existing item IDs set size: ${existingItemIDsSet.size}`);
        Zotero.debug(`[DBLP] Existing titles map size: ${existingTitlesMap.size}`);
        Zotero.debug(`[DBLP] Existing keys map size: ${existingKeysMap.size}`);

        for (const paper of uniquePapers) {
            try {
                Zotero.debug(`[DBLP] \n========== Processing paper: "${paper.title}" ==========`);
                Zotero.debug(`[DBLP] Paper key: ${paper.key || "N/A"}`);
                Zotero.debug(`[DBLP] Paper title: ${paper.title || "N/A"}`);

                let shouldSkip = false;
                let skipReason = "";

                // Check 1: Check by DBLP key (most reliable)
                if (paper.key) {
                    Zotero.debug(`[DBLP] [Check 1] Checking by DBLP key: "${paper.key}"`);
                    if (existingKeysMap.has(paper.key)) {
                        const existingItemID = existingKeysMap.get(paper.key)!;
                        Zotero.debug(`[DBLP] [Check 1] Found key in map! existingItemID: ${existingItemID}`);
                        // Check if item is in the existingItemIDs set (from API, most reliable)
                        if (existingItemIDsSet.has(existingItemID)) {
                            Zotero.debug(`[DBLP] [Check 1] ✓ Found match by DBLP key! Skipping paper: ${paper.title} (key: ${paper.key}, existing itemID: ${existingItemID})`);
                            shouldSkip = true;
                            skipReason = "same DBLP key";
                        } else {
                            Zotero.debug(`[DBLP] [Check 1] DBLP key match found but item ${existingItemID} NOT in existingItemIDsSet (set size: ${existingItemIDsSet.size}), will import`);
                            // Remove from map since it's not actually in collection
                            existingKeysMap.delete(paper.key);
                        }
                    } else {
                        Zotero.debug(`[DBLP] [Check 1] No match found for DBLP key: "${paper.key}" in existingKeysMap (map size: ${existingKeysMap.size})`);
                    }
                } else {
                    Zotero.debug(`[DBLP] [Check 1] Paper has no DBLP key, skipping key check`);
                }

                // Check 2: Check by title (case-insensitive)
                if (!shouldSkip && paper.title) {
                    const titleKey = paper.title.toLowerCase().trim();
                    Zotero.debug(`[DBLP] [Check 2] Checking by title: "${titleKey}"`);
                    if (existingTitlesMap.has(titleKey)) {
                        const existingItemID = existingTitlesMap.get(titleKey)!;
                        Zotero.debug(`[DBLP] [Check 2] Found title in map! existingItemID: ${existingItemID}`);
                        // Check if item is in the existingItemIDs set (from API, most reliable)
                        if (existingItemIDsSet.has(existingItemID)) {
                            Zotero.debug(`[DBLP] [Check 2] ✓ Found match by title! Skipping paper: ${paper.title} (existing itemID: ${existingItemID})`);
                            shouldSkip = true;
                            skipReason = "same title";
                        } else {
                            Zotero.debug(`[DBLP] [Check 2] Title match found but item ${existingItemID} NOT in existingItemIDsSet (set size: ${existingItemIDsSet.size}), will import`);
                            // Remove from map since it's not actually in collection
                            existingTitlesMap.delete(titleKey);
                        }
                    } else {
                        Zotero.debug(`[DBLP] [Check 2] No match found for title: "${titleKey}" in existingTitlesMap (map size: ${existingTitlesMap.size})`);
                    }
                } else {
                    if (shouldSkip) {
                        Zotero.debug(`[DBLP] [Check 2] Skipped (already marked to skip)`);
                    } else {
                        Zotero.debug(`[DBLP] [Check 2] Paper has no title, skipping title check`);
                    }
                }

                // Check 3: If paper exists in library, check if it's in collection
                // Note: If paper exists in library but not in collection, importPaperToZoteroWithCollection will add it
                // So we only skip if it's already in the collection
                if (!shouldSkip) {
                    Zotero.debug(`[DBLP] [Check 3] Checking if paper exists in library...`);
                    const existingItem = await checkPaperExists(paper);
                    if (existingItem) {
                        Zotero.debug(`[DBLP] [Check 3] Paper exists in library! Item ID: ${existingItem.id}`);
                        // First check the set we built earlier (fastest)
                        if (existingItemIDsSet.has(existingItem.id)) {
                            Zotero.debug(`[DBLP] [Check 3] ✓ Found existing item in library and collection (via set)! Skipping paper: ${paper.title} (ID: ${existingItem.id})`);
                            shouldSkip = true;
                            skipReason = "existing item in library and collection";
                        } else {
                            Zotero.debug(`[DBLP] [Check 3] Item ${existingItem.id} NOT in existingItemIDsSet, checking DB...`);
                            // Double-check using DB query (most reliable)
                            try {
                                // @ts-ignore
                                const dbCheck = await Zotero.DB.queryAsync(
                                    "SELECT itemID FROM collectionItems WHERE collectionID = ? AND itemID = ?",
                                    [collection.id, existingItem.id]
                                );
                                Zotero.debug(`[DBLP] [Check 3] DB query result: ${JSON.stringify(dbCheck)}`);

                                if (Array.isArray(dbCheck) && dbCheck.length > 0) {
                                    Zotero.debug(`[DBLP] [Check 3] ✓ Found existing item in library and collection (verified via DB)! Skipping paper: ${paper.title} (ID: ${existingItem.id})`);
                                    shouldSkip = true;
                                    skipReason = "existing item in library and collection";
                                } else {
                                    Zotero.debug(`[DBLP] [Check 3] DB query shows item NOT in collection, checking API...`);
                                    // Also check using collection API
                                    // @ts-ignore
                                    const collectionItemIDs: number[] = collection.getChildItems ? collection.getChildItems() : [];
                                    Zotero.debug(`[DBLP] [Check 3] Collection API returned ${collectionItemIDs.length} items`);
                                    if (collectionItemIDs.includes(existingItem.id)) {
                                        Zotero.debug(`[DBLP] [Check 3] ✓ Found existing item in library and collection (verified via API)! Skipping paper: ${paper.title} (ID: ${existingItem.id})`);
                                        shouldSkip = true;
                                        skipReason = "existing item in library and collection";
                                    } else {
                                        // Paper exists in library but not in collection
                                        // importPaperToZoteroWithCollection will add it, so we don't skip here
                                        Zotero.debug(`[DBLP] [Check 3] Paper exists in library (ID: ${existingItem.id}) but NOT in collection, will add to collection: ${paper.title}`);
                                    }
                                }
                            } catch (e) {
                                Zotero.debug(`[DBLP] [Check 3] Error checking collection for existing item: ${e}`);
                                // Fallback: check the set we built earlier
                                if (existingItemIDsSet.has(existingItem.id)) {
                                    Zotero.debug(`[DBLP] [Check 3] ✓ Found existing item in library and collection (via set fallback)! Skipping paper: ${paper.title} (ID: ${existingItem.id})`);
                                    shouldSkip = true;
                                    skipReason = "existing item in library and collection";
                                }
                            }
                        }
                    } else {
                        Zotero.debug(`[DBLP] [Check 3] Paper does NOT exist in library, will create new item`);
                    }
                } else {
                    Zotero.debug(`[DBLP] [Check 3] Skipped (already marked to skip)`);
                }

                if (shouldSkip) {
                    Zotero.debug(`[DBLP] ========== SKIPPING paper (${skipReason}): "${paper.title}" ==========`);
                    continue; // Skip this paper, don't count as success or failure
                }

                // Import paper (will skip if already in collection, or add if exists but not in collection, or create new)
                Zotero.debug(`[DBLP] ========== Calling importPaperToZoteroWithCollection for: "${paper.title}" ==========`);
                const item = await importPaperToZoteroWithCollection(paper, collection.id);
                if (item) {
                    Zotero.debug(`[DBLP] ========== importPaperToZoteroWithCollection returned item: ID=${item.id}, Title="${item.getField('title')}" ==========`);
                    // Count as success only if item was actually imported/added
                    success++;

                    // Refresh collection items to get the latest state
                    // Use DB query as it's more reliable than API
                    try {
                        // @ts-ignore
                        const dbResult = await Zotero.DB.queryAsync(
                            "SELECT itemID FROM collectionItems WHERE collectionID = ?",
                            [collection.id]
                        );
                        let refreshedItemIDs: number[] = [];
                        if (Array.isArray(dbResult)) {
                            refreshedItemIDs = dbResult.map((row: any) => {
                                if (Array.isArray(row)) {
                                    return row[0];
                                } else if (row && typeof row === 'object' && 'itemID' in row) {
                                    return row.itemID;
                                } else {
                                    return row;
                                }
                            }).filter((id: any) => id != null && !isNaN(Number(id)));
                        }
                        // Update the set with all current items in collection
                        refreshedItemIDs.forEach(id => existingItemIDsSet.add(id));
                        Zotero.debug(`[DBLP] Refreshed collection items: ${refreshedItemIDs.length} items now in collection (via DB query)`);
                    } catch (e) {
                        Zotero.debug(`[DBLP] Error refreshing collection items: ${e}`);
                        // Fallback to API if DB query fails
                        try {
                            // @ts-ignore
                            const refreshedCollection = Zotero.Collections.get(collection.id);
                            if (refreshedCollection) {
                                // @ts-ignore
                                const refreshedItemIDs: number[] = refreshedCollection.getChildItems ? refreshedCollection.getChildItems() : [];
                                refreshedItemIDs.forEach(id => existingItemIDsSet.add(id));
                                Zotero.debug(`[DBLP] Refreshed collection items: ${refreshedItemIDs.length} items now in collection (via API fallback)`);
                            }
                        } catch (apiError) {
                            Zotero.debug(`[DBLP] Error refreshing collection items via API: ${apiError}`);
                        }
                    }

                    // Update the maps and set to track newly added items (for subsequent checks in this batch)
                    existingItemIDsSet.add(item.id);

                    // Update title map
                    if (paper.title) {
                        existingTitlesMap.set(paper.title.toLowerCase().trim(), item.id);
                    }

                    // Update key map
                    if (paper.key) {
                        existingKeysMap.set(paper.key, item.id);
                    }

                    Zotero.debug(`[DBLP] Successfully imported paper: ${paper.title} (ID: ${item.id})`);
                } else {
                    // Item is null - this means it was skipped (already in collection)
                    Zotero.debug(`[DBLP] Paper was skipped (already in collection): ${paper.title}`);
                }
            } catch (e) {
                Zotero.debug(`[DBLP] Error importing paper ${paper.title}: ${e}`);
                failed++;
            }
        }

        Zotero.debug(`[DBLP] ========== Import completed ==========`);
        Zotero.debug(`[DBLP] Successfully imported: ${success} papers`);
        Zotero.debug(`[DBLP] Failed: ${failed} papers`);
        Zotero.debug(`[DBLP] Collection: "${collectionName}" (ID: ${collection?.id || "N/A"})`);
        Zotero.debug(`[DBLP] =========================================`);
    } catch (e) {
        Zotero.debug(`[DBLP] Error in importPapersToCollection: ${e}`);
        Zotero.debug(`[DBLP] Error stack: ${(e as Error).stack}`);
    }

    return { success, failed, collection };
}

