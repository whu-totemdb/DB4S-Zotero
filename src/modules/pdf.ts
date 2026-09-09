// Based on papersgpt-for-zotero-main/src/modules/Meet/papersgpt.ts

import { config } from "../../package.json";

// Polyfill for Promise.withResolvers (needed for newer PDF.js on older Zotero/Firefox)
if (!Promise.withResolvers) {
    // @ts-ignore
    Promise.withResolvers = function () {
        let resolve, reject;
        const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });
        return { promise, resolve, reject };
    };
}

declare const ztoolkit: any;

export interface PDFLine {
    x: number;
    y: number;
    text: string;
    height: number;
    _height: number[];
    width: number;
    url?: string;
}

export interface PDFItem {
    str: string;
    transform: number[];
    height: number;
    width: number;
    url?: string;
    // ... other properties we don't strictly need
}

/**
 * Merge items on the same line
 */
function mergeSameLine(items: PDFItem[]): PDFLine[] {
    let toLine = (item: PDFItem) => {
        let line: PDFLine = {
            x: parseFloat(item.transform[4].toFixed(1)),
            y: parseFloat(item.transform[5].toFixed(1)),
            text: item.str || "",
            height: item.height,
            width: item.width,
            url: item?.url,
            _height: [item.height]
        };
        if (line.width < 0) {
            line.x += line.width;
            line.width = -line.width;
        }
        return line;
    };

    if (items.length === 0) return [];

    let j = 0;
    let lines: PDFLine[] = [toLine(items[j])];
    for (j = 1; j < items.length; j++) {
        let line = toLine(items[j]);
        let lastLine = lines[lines.length - 1];
        // Consider superscript and subscript
        if (
            line.y == lastLine.y ||
            (line.y >= lastLine.y && line.y < lastLine.y + lastLine.height) ||
            (line.y + line.height > lastLine.y && line.y + line.height <= lastLine.y + lastLine.height)
        ) {
            lastLine.text += (" " + line.text);
            lastLine.width += line.width;
            lastLine.url = lastLine.url || line.url;
            // Record all altitudes
            lastLine._height.push(line.height);
        } else {
            let hh = lastLine._height;
            const num: any = {};
            for (let i = 0; i < hh.length; i++) {
                num[String(hh[i])] ??= 0;
                num[String(hh[i])] += 1;
            }
            lastLine.height = Number(
                Object.keys(num).sort((h1: string, h2: string) => {
                    return num[h2] - num[h1];
                })[0]
            );
            lines.push(line);
        }
    }
    return lines;
}

/**
 * Get PDF title from metadata or first page
 */
export async function getPDFTitle(item: Zotero.Item): Promise<string | null> {
    let attachment: Zotero.Item | null = null;

    // Get attachment
    if (item.isAttachment()) {
        attachment = item;
    } else if (item.isRegularItem()) {
        // @ts-expect-error Zotero types
        attachment = await item.getBestAttachment();
    }

    if (!attachment) {
        Zotero.debug(`[PDF] No attachment found for item ${item.id}`);
        return null;
    }

    Zotero.debug(`[PDF] Getting title from attachment ${attachment.id}`);

    // Strategy 1: Try to get from open Reader (most reliable)
    try {
        // Wait a bit for Reader to fully load
        await Zotero.Promise.delay(500);

        // @ts-ignore
        const readers = Zotero.Reader._readers || [];
        Zotero.debug(`[PDF] Found ${readers.length} open readers`);

        for (const reader of readers) {
            if (reader.itemID === attachment.id) {
                Zotero.debug(`[PDF] Found open reader for attachment ${attachment.id}`);

                // Wait for iframeWindow to be available (up to 3 seconds)
                let retries = 15;
                while (retries > 0 && !reader._iframeWindow) {
                    await Zotero.Promise.delay(200);
                    retries--;
                }

                if (!reader._iframeWindow) {
                    Zotero.debug(`[PDF] Reader iframeWindow not available after waiting`);
                    break; // Break to try next strategy
                }

                try {
                    // Access wrappedJSObject safely
                    const iframeWindow = reader._iframeWindow as any;
                    if (!iframeWindow || !iframeWindow.wrappedJSObject) {
                        Zotero.debug(`[PDF] iframeWindow.wrappedJSObject not available`);
                        break;
                    }

                    const app = iframeWindow.wrappedJSObject.PDFViewerApplication;
                    if (!app) {
                        Zotero.debug(`[PDF] PDFViewerApplication not found in reader`);
                        break;
                    }

                    // Wait for PDF to load (with timeout)
                    try {
                        await Promise.race([
                            app.pdfLoadingTask.promise,
                            new Promise((_, reject) =>
                                setTimeout(() => reject(new Error("PDF loading timeout")), 5000)
                            )
                        ]);
                        Zotero.debug(`[PDF] PDF loaded in reader`);
                    } catch (e) {
                        Zotero.debug(`[PDF] PDF loading failed or timeout: ${e}`);
                        break;
                    }

                    // Try metadata first
                    try {
                        const metadata = await app.pdfDocument.getMetadata();
                        if (metadata && metadata.info && metadata.info.Title) {
                            const title = metadata.info.Title.trim();
                            if (title && title.length > 5) {
                                Zotero.debug(`[PDF] Got title from metadata: ${title}`);
                                return title;
                            }
                        }
                    } catch (e) {
                        Zotero.debug(`[PDF] Error getting metadata from reader: ${e}`);
                    }

                    // Try first page text
                    try {
                        await app.pdfViewer.pagesPromise;
                        if (app.pdfViewer._pages && app.pdfViewer._pages.length > 0) {
                            const firstPage = app.pdfViewer._pages[0];
                            if (firstPage && firstPage.pdfPage) {
                                const textContent = await firstPage.pdfPage.getTextContent();
                                const items: PDFItem[] = textContent.items
                                    .filter((item: any) => item.str && item.str.trim().length > 0)
                                    .map((item: any) => ({
                                        str: item.str,
                                        transform: item.transform,
                                        height: item.height,
                                        width: item.width
                                    }));

                                let lines = mergeSameLine(items);

                                // Helper function to detect if a line looks like an author line or email line
                                const isAuthorLine = (text: string): boolean => {
                                    const normalized = text.toLowerCase();
                                    // Check for author line patterns:
                                    // 1. Contains multiple names separated by commas and "and"
                                    // 2. Contains special symbols like †, ∗, ‡, §
                                    // 3. Pattern: "Name1, Name2, and Name3"
                                    // 4. Contains email-like patterns
                                    // 5. Contains affiliation markers
                                    const hasAuthorMarkers = /[†∗‡§¶]/g.test(text);
                                    const hasMultipleCommas = (text.match(/,/g) || []).length >= 2;
                                    const hasAndPattern = /\s+and\s+/i.test(text);
                                    const hasEmailPattern = /@/.test(text);
                                    const hasEmailDomain = /@[a-z0-9.-]+\.(edu|com|org|net|gov|ac\.[a-z]{2})/i.test(text);
                                    const hasAffiliationPattern = /(university|institute|department|college|school)/i.test(text);
                                    const hasBracketEmail = /\[.*@.*\]/.test(text); // [email1, email2]@domain

                                    // Email lines - highest priority to filter
                                    if (hasEmailPattern || hasEmailDomain || hasBracketEmail) {
                                        return true;
                                    }

                                    // If it has author markers and multiple commas/and, it's likely an author line
                                    if ((hasAuthorMarkers && (hasMultipleCommas || hasAndPattern)) ||
                                        (hasMultipleCommas && hasAndPattern && text.length < 200)) {
                                        return true;
                                    }

                                    // If it's very short and has author markers, likely author
                                    if (hasAuthorMarkers && text.length < 150) {
                                        return true;
                                    }

                                    // If it contains affiliation markers and is relatively short, likely author/affiliation line
                                    if (hasAffiliationPattern && text.length < 200) {
                                        return true;
                                    }

                                    return false;
                                };

                                // Get first few lines, filter out common non-title text and author lines
                                if (lines.length > 0) {
                                    const firstLines = lines.slice(0, 20); // Check more lines
                                    const candidateLines = firstLines.filter(line => {
                                        const text = line.text.trim();
                                        // Must be long enough
                                        if (text.length < 15) return false;
                                        // Not just numbers
                                        if (/^\d+$/.test(text)) return false;
                                        // Not common section headers
                                        if (/^(abstract|introduction|references?|acknowledgements?|doi|http|www\.)/i.test(text)) return false;
                                        // Not an author line
                                        if (isAuthorLine(text)) {
                                            Zotero.debug(`[PDF] Filtered out author line: ${text.substring(0, 50)}...`);
                                            return false;
                                        }
                                        return true;
                                    });

                                    if (candidateLines.length > 0) {
                                        // First, try to merge consecutive lines that might be a multi-line title
                                        const mergedTitles: string[] = [];

                                        for (let i = 0; i < Math.min(3, candidateLines.length); i++) {
                                            let mergedTitle = candidateLines[i].text.trim();

                                            // If line ends with colon or is short, try merging with next line
                                            if ((mergedTitle.endsWith(':') || mergedTitle.length < 60) && i + 1 < candidateLines.length) {
                                                const nextLine = candidateLines[i + 1].text.trim();
                                                // Check if next line is likely part of title (not author line, not too short)
                                                if (!isAuthorLine(nextLine) && nextLine.length > 10) {
                                                    // If next line contains the first line, use next line (it's more complete)
                                                    if (nextLine.includes(mergedTitle) || mergedTitle.includes(nextLine.substring(0, Math.min(20, nextLine.length)))) {
                                                        mergedTitle = nextLine.length > mergedTitle.length ? nextLine : mergedTitle + " " + nextLine;
                                                    } else {
                                                        mergedTitle = mergedTitle + " " + nextLine;
                                                    }
                                                }
                                            }

                                            if (!isAuthorLine(mergedTitle) && mergedTitle.length > 15) {
                                                mergedTitles.push(mergedTitle);
                                            }
                                        }

                                        // Also add individual lines as candidates
                                        for (const line of candidateLines.slice(0, 5)) {
                                            const title = line.text.trim();
                                            if (!isAuthorLine(title) && title.length > 15) {
                                                mergedTitles.push(title);
                                            }
                                        }

                                        // Sort by length (prefer longer, more complete titles) and position (prefer earlier)
                                        const sortedTitles = mergedTitles
                                            .map((title, index) => ({
                                                title,
                                                index: candidateLines.findIndex(l => l.text.trim() === title || title.includes(l.text.trim())),
                                                score: title.length - index * 5
                                            }))
                                            .sort((a, b) => {
                                                // Prefer longer titles
                                                if (Math.abs(a.score - b.score) > 20) {
                                                    return b.score - a.score;
                                                }
                                                // If similar length, prefer earlier position
                                                return a.index - b.index;
                                            });

                                        if (sortedTitles.length > 0) {
                                            const bestTitle = sortedTitles[0].title;
                                            Zotero.debug(`[PDF] Got title from first page: ${bestTitle.substring(0, 100)}...`);
                                            return bestTitle;
                                        }
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        Zotero.debug(`[PDF] Error extracting title from first page: ${e}`);
                    }
                } catch (e) {
                    Zotero.debug(`[PDF] Error accessing reader app: ${e}`);
                }
                break;
            }
        }
    } catch (e) {
        Zotero.debug(`[PDF] Error getting title from reader: ${e}`);
    }

    // Strategy 2: Try direct PDF.js access (same method as getPDFText)
    try {
        let pdfjsLib = null;

        // Try dynamic import() first
        try {
            const libUrl = `chrome://${config.addonRef}/content/lib/pdf.mjs`;
            // @ts-ignore
            pdfjsLib = await import(libUrl);
            Zotero.debug(`[PDF] Successfully loaded PDF.js via dynamic import`);
        } catch (e) {
            Zotero.debug(`[PDF] Dynamic import failed: ${e}`);
        }

        // Fallback to standard ChromeUtils import
        if (!pdfjsLib) {
            const paths = [
                "resource://pdf.js/build/pdf.mjs",
                `chrome://${config.addonRef}/content/lib/pdf.mjs`
            ];

            for (const path of paths) {
                try {
                    // @ts-ignore
                    pdfjsLib = ChromeUtils.importESModule(path);
                    if (pdfjsLib) {
                        Zotero.debug(`[PDF] Successfully loaded PDF.js from ${path}`);
                        break;
                    }
                } catch (e) {
                    Zotero.debug(`[PDF] Failed to load PDF.js from ${path}: ${e}`);
                }
            }
        }

        if (!pdfjsLib) {
            Zotero.debug(`[PDF] Could not load PDF.js library from any source`);
        } else {
            // @ts-ignore
            const path = attachment.getFilePath ? attachment.getFilePath() : (await attachment.getFilePathAsync());

            if (!path) {
                Zotero.debug(`[PDF] No file path for attachment ${attachment.id}`);
            } else {
                Zotero.debug(`[PDF] File path: ${path}`);

                // Set worker source
                // @ts-ignore
                if (pdfjsLib.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
                    // @ts-ignore
                    pdfjsLib.GlobalWorkerOptions.workerSrc = `chrome://${config.addonRef}/content/lib/pdf.worker.mjs`;
                }

                // For file paths in Zotero 7, we might need file:// URI
                let docPath = path;
                if (docPath && !docPath.startsWith("file:")) {
                    if (docPath.match(/^[a-zA-Z]:/)) {
                        docPath = "file:///" + docPath.replace(/\\/g, "/");
                    } else {
                        docPath = "file://" + docPath;
                    }
                }

                // Try reading with original path first, then file URI
                let loadingTask;
                try {
                    loadingTask = pdfjsLib.getDocument(path);
                } catch (e) {
                    Zotero.debug(`[PDF] Failed to load with original path, trying file URI: ${e}`);
                    try {
                        loadingTask = pdfjsLib.getDocument(docPath);
                    } catch (e2) {
                        Zotero.debug(`[PDF] Failed to load with file URI: ${e2}`);
                        throw e2;
                    }
                }

                const pdf = await loadingTask.promise;

                // Try to get title from metadata
                try {
                    const metadata = await pdf.getMetadata();
                    if (metadata && metadata.info && metadata.info.Title) {
                        const title = metadata.info.Title.trim();
                        if (title && title.length > 5) {
                            Zotero.debug(`[PDF] Got title from PDF metadata: ${title}`);
                            return title;
                        }
                    }
                } catch (e) {
                    Zotero.debug(`[PDF] Error getting metadata: ${e}`);
                }

                // If no metadata title, try to extract from first page
                try {
                    const firstPage = await pdf.getPage(1);
                    const textContent = await firstPage.getTextContent();
                    const items: PDFItem[] = textContent.items
                        .filter((item: any) => item.str && item.str.trim().length > 0)
                        .map((item: any) => ({
                            str: item.str,
                            transform: item.transform,
                            height: item.height,
                            width: item.width
                        }));

                    let lines = mergeSameLine(items);

                    // Helper function to detect if a line looks like an author line
                    const isAuthorLine = (text: string): boolean => {
                        const normalized = text.toLowerCase();
                        // Check for author line patterns:
                        // 1. Contains multiple names separated by commas and "and"
                        // 2. Contains special symbols like †, ∗, ‡, §
                        // 3. Pattern: "Name1, Name2, and Name3"
                        // 4. Contains email-like patterns
                        // 5. Contains affiliation markers
                        const hasAuthorMarkers = /[†∗‡§¶]/g.test(text);
                        const hasMultipleCommas = (text.match(/,/g) || []).length >= 2;
                        const hasAndPattern = /\s+and\s+/i.test(text);
                        const hasEmailPattern = /@/.test(text);
                        const hasAffiliationPattern = /(university|institute|department|college|school)/i.test(text);

                        // If it has author markers and multiple commas/and, it's likely an author line
                        if ((hasAuthorMarkers && (hasMultipleCommas || hasAndPattern)) ||
                            (hasMultipleCommas && hasAndPattern && text.length < 200)) {
                            return true;
                        }

                        // If it's very short and has author markers, likely author
                        if (hasAuthorMarkers && text.length < 150) {
                            return true;
                        }

                        return false;
                    };

                    if (lines.length > 0) {
                        const firstLines = lines.slice(0, 20); // Check more lines
                        const candidateLines = firstLines.filter(line => {
                            const text = line.text.trim();
                            // Must be long enough
                            if (text.length < 15) return false;
                            // Not just numbers
                            if (/^\d+$/.test(text)) return false;
                            // Not common section headers
                            if (/^(abstract|introduction|references?|acknowledgements?|doi|http|www\.)/i.test(text)) return false;
                            // Not an author line
                            if (isAuthorLine(text)) {
                                Zotero.debug(`[PDF] Filtered out author line: ${text.substring(0, 50)}...`);
                                return false;
                            }
                            return true;
                        });

                        if (candidateLines.length > 0) {
                            // First, try to merge consecutive lines that might be a multi-line title
                            const mergedTitles: string[] = [];

                            for (let i = 0; i < Math.min(3, candidateLines.length); i++) {
                                let mergedTitle = candidateLines[i].text.trim();

                                // If line ends with colon or is short, try merging with next line
                                if ((mergedTitle.endsWith(':') || mergedTitle.length < 60) && i + 1 < candidateLines.length) {
                                    const nextLine = candidateLines[i + 1].text.trim();
                                    // Check if next line is likely part of title (not author line, not too short)
                                    if (!isAuthorLine(nextLine) && nextLine.length > 10) {
                                        // If next line contains the first line, use next line (it's more complete)
                                        if (nextLine.includes(mergedTitle) || mergedTitle.includes(nextLine.substring(0, Math.min(20, nextLine.length)))) {
                                            mergedTitle = nextLine.length > mergedTitle.length ? nextLine : mergedTitle + " " + nextLine;
                                        } else {
                                            mergedTitle = mergedTitle + " " + nextLine;
                                        }
                                    }
                                }

                                if (!isAuthorLine(mergedTitle) && mergedTitle.length > 15) {
                                    mergedTitles.push(mergedTitle);
                                }
                            }

                            // Also add individual lines as candidates
                            for (const line of candidateLines.slice(0, 5)) {
                                const title = line.text.trim();
                                if (!isAuthorLine(title) && title.length > 15) {
                                    mergedTitles.push(title);
                                }
                            }

                            // Sort by length (prefer longer, more complete titles) and position (prefer earlier)
                            const sortedTitles = mergedTitles
                                .map((title, index) => ({
                                    title,
                                    index: candidateLines.findIndex(l => l.text.trim() === title || title.includes(l.text.trim())),
                                    score: title.length - index * 5
                                }))
                                .sort((a, b) => {
                                    // Prefer longer titles
                                    if (Math.abs(a.score - b.score) > 20) {
                                        return b.score - a.score;
                                    }
                                    // If similar length, prefer earlier position
                                    return a.index - b.index;
                                });

                            if (sortedTitles.length > 0) {
                                const bestTitle = sortedTitles[0].title;
                                Zotero.debug(`[PDF] Got title from first page (direct): ${bestTitle.substring(0, 100)}...`);
                                return bestTitle;
                            }
                        }
                    }
                } catch (e) {
                    Zotero.debug(`[PDF] Error extracting from first page: ${e}`);
                }
            }
        }
    } catch (e) {
        Zotero.debug(`[PDF] Error getting PDF title (direct method): ${e}`);
        Zotero.debug(`[PDF] Error stack: ${(e as Error).stack}`);
    }

    Zotero.debug(`[PDF] Failed to get title from PDF for attachment ${attachment.id}`);
    return null;
}

/**
 * Read the full text of the PDF.
 * This function will stop reading when it encounters the reference keyword.
 */
export async function getPDFText(item: Zotero.Item): Promise<string> {
    let attachment: Zotero.Item | null = null;

    if (item.isAttachment()) {
        attachment = item;
    } else if (item.isRegularItem()) {
        // @ts-expect-error Zotero types
        attachment = await item.getBestAttachment();
    }

    if (!attachment) return "";

    // Method 1: Zotero 7 PDF.js direct read (Preferred)
    try {
        let pdfjsLib = null;

        // Try dynamic import() first
        try {
            const libUrl = `chrome://${config.addonRef}/content/lib/pdf.mjs`;
            // @ts-ignore
            pdfjsLib = await import(libUrl);
        } catch (e) {
            Zotero.debug(`[AI for Science] Dynamic import failed: ${e}`);
        }

        // Fallback to standard ChromeUtils import
        if (!pdfjsLib) {
            const paths = [
                "resource://pdf.js/build/pdf.mjs",
                `chrome://${config.addonRef}/content/lib/pdf.mjs`
            ];

            for (const path of paths) {
                try {
                    // @ts-ignore
                    pdfjsLib = ChromeUtils.importESModule(path);
                    if (pdfjsLib) break;
                } catch (e) { }
            }
        }

        if (!pdfjsLib) {
            Zotero.log("PDF.js direct read failed: Could not load pdf.js library.");
            throw new Error("pdf.js not found");
        }

        // @ts-ignore
        const path = attachment.getFilePath ? attachment.getFilePath() : (await attachment.getFilePathAsync());

        // Set worker source
        // @ts-ignore
        if (pdfjsLib.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
            // @ts-ignore
            // Try to use plugin's worker first, falling back to potential system paths or blob URLs is hard in Zotero
            // Ensuring correct path to worker.mjs in the built XPI is critical.
            pdfjsLib.GlobalWorkerOptions.workerSrc = `chrome://${config.addonRef}/content/lib/pdf.worker.mjs`;
        }

        // For file paths in Zotero 7, we might need file:// URI if passing to library loaded in window
        let docPath = path;
        if (docPath && !docPath.startsWith("file:")) {
            // Simple conversion, assuming Windows based on user env
            if (docPath.match(/^[a-zA-Z]:/)) {
                docPath = "file:///" + docPath.replace(/\\/g, "/");
            } else {
                docPath = "file://" + docPath;
            }
        }

        // Try reading with original path first (for ArrayBuffer/System read), then file URI
        let loadingTask;
        try {
            loadingTask = pdfjsLib.getDocument(path);
        } catch (e) {
            loadingTask = pdfjsLib.getDocument(docPath);
        }

        const pdf = await loadingTask.promise;
        const totalPageNum = pdf.numPages;
        let fullText = "";

        for (let pageNum = 1; pageNum <= totalPageNum; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent();

            const items: PDFItem[] = textContent.items
                .filter((item: any) => item.str.trim().length > 0)
                .map((item: any) => ({
                    str: item.str,
                    transform: item.transform,
                    height: item.height,
                    width: item.width,
                    url: item.url
                }));

            let lines = mergeSameLine(items);

            // Remove references logic
            let index = lines.findIndex(line => /(r?eferences?|acknowledgements)$/i.test(line.text.trim()));
            let stopReading = false;
            if (index != -1) {
                lines = lines.slice(0, index);
                stopReading = true;
            }

            let pageText = lines.map(l => l.text).join(" ");
            fullText += pageText + "\n\n";

            if (stopReading && pageNum / totalPageNum >= .75) {
                break;
            }
        }
        Zotero.debug("[AI for Science] Strategy 1: PDF.js direct read successful.");
        return fullText;

    } catch (e) {
        Zotero.log("PDF.js direct read failed: " + e);
    }

    // Strategy 0: Try to get text from an open Zotero Reader (Most reliable for Zotero 7)
    try {
        // Find reader via Zotero.Reader._readers (Zotero 7 internal API)
        let reader = null;
        // @ts-ignore
        const readers = Zotero.Reader._readers;
        if (readers) {
            for (const r of readers) {
                if (r.itemID === attachment.id) {
                    reader = r;
                    break;
                }
            }
        }

        if (reader) {
            const app = (reader._iframeWindow as any).wrappedJSObject.PDFViewerApplication;
            if (app) {
                await app.pdfLoadingTask.promise;
                await app.pdfViewer.pagesPromise;
                const pages = app.pdfViewer._pages;
                let fullText = "";
                for (let i = 0; i < pages.length; i++) {
                    const pdfPage = pages[i].pdfPage;
                    const textContent = await pdfPage.getTextContent();
                    const items: PDFItem[] = textContent.items.filter((item: PDFItem) => item.str.trim().length);
                    let lines = mergeSameLine(items);

                    // Filter references
                    let index = lines.findIndex(line => /(r?eferences?|acknowledgements)$/i.test(line.text.trim()));
                    if (index != -1) {
                        lines = lines.slice(0, index);
                    }

                    fullText += lines.map(l => l.text).join(" ") + "\n\n";

                    if (index != -1 && i / pages.length >= 0.75) break;
                }
                if (fullText.length > 50) {
                    Zotero.debug("[AI for Science] Strategy 0: Reader extraction successful.");
                    return fullText;
                }
            }
        }
    } catch (e) {
        Zotero.debug(`[AI for Science] Reader extraction failed: ${e}`);
    }

    try {
        // Check if we can use the reader
        // First, try to use Zotero's Fulltext API which is more robust and doesn't require the reader to be open
        try {
            // @ts-ignore - Fulltext.get may not be in types but exists at runtime
            const fulltextResult = await (Zotero.Fulltext as any).get(attachment.id);
            const fulltext =
                (fulltextResult && (fulltextResult as any).fulltext) || "";
            if (fulltext) {
                Zotero.debug("[AI for Science] Strategy 2: Fulltext index successful.");
                return fulltext;
            }
        } catch (e) {
            Zotero.log("Fulltext index not available: " + e);
        }

        // Fallback: try to use the reader if it is open
        // @ts-ignore
        let reader = null;
        try {
            reader = await ztoolkit.Reader.getReader();
        } catch (e) { /* ignore */ }

        // Only proceed if reader is valid and matches our item
        if (reader && (reader.itemID === attachment.id || reader.itemID === item.id)) {
            const PDFViewerApplication = (reader._iframeWindow as any).wrappedJSObject.PDFViewerApplication;
            if (!PDFViewerApplication || !PDFViewerApplication.pdfViewer) {
                return "";
            }
            await PDFViewerApplication.pdfLoadingTask.promise;
            await PDFViewerApplication.pdfViewer.pagesPromise;
            let pages = PDFViewerApplication.pdfViewer._pages;
            let totalPageNum = pages.length;

            let fullText = "";

            // Read all lines of the page
            for (let pageNum = 0; pageNum < totalPageNum; pageNum++) {
                let pdfPage = pages[pageNum].pdfPage;
                // Zotero 7 Reader might load pages lazily. Ensure page is loaded.
                if (!pdfPage) {
                    // Try to get page from PDFDocumentProxy if needed, or skip
                    // const page = await PDFViewerApplication.pdfDocument.getPage(pageNum + 1);
                    // But sticking to viewer structure for now.
                    continue;
                }
                let textContent = await pdfPage.getTextContent();
                let items: PDFItem[] = textContent.items.filter((item: PDFItem) => item.str.trim().length);
                let lines = mergeSameLine(items);

                // Remove references
                let index = lines.findIndex(line => /(r?eferences?|acknowledgements)$/i.test(line.text.trim()));
                let stopReading = false;
                if (index != -1) {
                    lines = lines.slice(0, index);
                    stopReading = true;
                }

                // Simple text joining for now
                let pageText = lines.map(l => l.text).join(" ");
                fullText += pageText + "\n\n";

                if (stopReading && pageNum / totalPageNum >= .75) {
                    break;
                }
            }
            Zotero.debug("[AI for Science] Strategy 3: Fallback Reader successful.");
            return fullText;
        }

        // If we reach here, we couldn't get text from Fulltext or Reader.
        return "";

    } catch (e) {
        Zotero.log("Error reading PDF: " + e);
        return "";
    }
}
