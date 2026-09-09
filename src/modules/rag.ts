import { embeddingStorage } from "./storage";
import { findMostSimilar } from "./simpleEmbedding";

// --- Types ---

export interface Chunk {
    text: string;
    index: number;
    startPos?: number; // 在原文中的起始位置
    endPos?: number; // 在原文中的结束位置
    embedding?: number[];
}

export interface SearchResult {
    chunk: Chunk;
    score: number;
}

// --- Constants ---
// OpenAI text-embedding-ada-002: 1536 dims
// Gemini text-embedding-004: 768 dims
const CHUNK_SIZE = 1000; // Characters roughly
const CHUNK_OVERLAP = 200;

// --- Helper Functions ---

function cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dot += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function splitText(text: string, chunkSize: number = CHUNK_SIZE, overlap: number = CHUNK_OVERLAP): Array<{ text: string, startPos: number, endPos: number }> {
    const chunks: Array<{ text: string, startPos: number, endPos: number }> = [];
    if (!text) return chunks;

    let start = 0;
    while (start < text.length) {
        let end = start + chunkSize;

        // Don't cut in middle of sentence if possible (simple heuristic)
        if (end < text.length) {
            const nextSpace = text.indexOf(' ', end);
            const nextDot = text.indexOf('.', end);
            const nextNewLine = text.indexOf('\n', end);

            // Try to find nearest natural break
            const candidates = [nextSpace, nextDot, nextNewLine].filter(i => i !== -1 && i - end < 100);
            if (candidates.length > 0) {
                end = Math.min(...candidates) + 1;
            }
        }

        const actualEnd = Math.min(end, text.length);
        const chunkText = text.slice(start, actualEnd).trim();
        chunks.push({
            text: chunkText,
            startPos: start,
            endPos: actualEnd
        });

        start += (chunkSize - overlap);
    }
    return chunks;
}

// --- API Calls ---

async function fetchEmbedding(text: string, provider: string, apiKey: string, baseUrl?: string, model?: string): Promise<number[]> {
    try {
        if (provider === "Local" || provider === "Simple" || provider === "TF-IDF") {
            // Local embedding using TF-IDF - no API key needed, works offline
            // Return empty array as we'll use direct similarity calculation instead
            // This is just for compatibility with the existing interface
            return [];
        } else if (provider === "OpenAI") {
            const url = `${baseUrl || "https://api.openai.com/v1"}/embeddings`;
            const resp = await Zotero.HTTP.request("POST", url, {
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: model || "text-embedding-3-small",
                    input: text
                }),
                responseType: "json",
                timeout: 30000
            });

            if (resp.status === 200 && resp.response?.data?.[0]?.embedding) {
                return resp.response.data[0].embedding;
            }
        } else if (provider === "Gemini") {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`;
            const resp = await Zotero.HTTP.request("POST", url, {
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    content: { parts: [{ text: text }] }
                }),
                responseType: "json",
                timeout: 30000
            });

            if (resp.status === 200 && resp.response?.embedding?.values) {
                return resp.response.embedding.values;
            }
        } else if (provider === "Custom") {
            // Generic OpenAI Compatible
            let url = `${baseUrl}/embeddings`;
            // Remove double slashes if any (except protocol)
            url = url.replace(/([^:]\/)\/+/g, "$1");

            const body: any = {
                input: text
            };
            if (model) body.model = model;

            const resp = await Zotero.HTTP.request("POST", url, {
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`
                },
                body: JSON.stringify(body),
                responseType: "json",
                timeout: 30000
            });

            if (resp.status === 200 && resp.response?.data?.[0]?.embedding) {
                return resp.response.data[0].embedding;
            }
        }
    } catch (e) {
        Zotero.log(`[RAG] Embedding fetch failed: ${e}`);
    }
    return [];
}

async function fetchBatchEmbeddings(texts: string[], provider: string, apiKey: string, baseUrl?: string, model?: string): Promise<number[][]> {
    // For local simple embedding, we don't need to pre-compute embeddings
    // We'll use direct similarity calculation instead
    if (provider === "Local" || provider === "Simple" || provider === "TF-IDF") {
        // Return empty arrays - we'll use findMostSimilar directly
        return texts.map(() => []);
    }

    // Basic implementation: sequential for API providers
    const results: number[][] = [];
    for (const text of texts) {
        // Sleep a bit to avoid rate limits if needed?
        const emb = await fetchEmbedding(text, provider, apiKey, baseUrl, model);
        if (emb.length > 0) results.push(emb);
        else results.push([]); // Placeholder for failed
    }
    return results;
}

// --- Main RAG Class ---

export class RAGEngine {

    static async getRelevantContext(query: string, item: Zotero.Item, fullText: string, topK: number = 5): Promise<string> {
        const prefsPrefix = addon.data.config.prefsPrefix;

        let embeddingProvider = Zotero.Prefs.get(`${prefsPrefix}.embeddingProvider`) as string;
        let apiKey = "";
        let baseUrl = "";
        let model = "";

        // Default to Local if not set
        if (!embeddingProvider || embeddingProvider === "default") {
            embeddingProvider = "Local";
        }

        // Determine effective provider
        if (embeddingProvider === "Local") {
            // Local TF-IDF - no configuration needed
        } else {
            // Explicitly set
            if (embeddingProvider === "Local" || embeddingProvider === "Simple" || embeddingProvider === "TF-IDF") {
                // Local simple embedding using TF-IDF - no API key needed, works offline
                // No initialization needed
            } else if (embeddingProvider === "OpenAI") {
                apiKey = Zotero.Prefs.get(`${prefsPrefix}.openaiApiKey`) as string;
                baseUrl = Zotero.Prefs.get(`${prefsPrefix}.openaiBaseUrl`) as string;
            } else if (embeddingProvider === "Gemini") {
                apiKey = Zotero.Prefs.get(`${prefsPrefix}.geminiApiKey`) as string;
            } else if (embeddingProvider === "Custom") {
                apiKey = Zotero.Prefs.get(`${prefsPrefix}.embeddingApiKey`) as string;
                baseUrl = Zotero.Prefs.get(`${prefsPrefix}.embeddingBaseUrl`) as string;
                model = Zotero.Prefs.get(`${prefsPrefix}.embeddingModel`) as string;

                // If Custom Key is empty, maybe try to use the LLM key?
                if (!apiKey) {
                    const mainProvider = Zotero.Prefs.get(`${prefsPrefix}.provider`) as string;
                    if (mainProvider === "Custom") {
                        apiKey = Zotero.Prefs.get(`${prefsPrefix}.customApiKey`) as string;
                    }
                }
            }
        }

        // For local simple embedding, no API key check needed
        const isLocalSimple = embeddingProvider === "Local" || embeddingProvider === "Simple" || embeddingProvider === "TF-IDF";

        if (!isLocalSimple && !apiKey) {
            return fullText;
        }

        // 1. Get/Create Item Chunks
        const itemKey = item.key;
        let cachedData = await embeddingStorage.getItemCache(itemKey);

        let chunks: Chunk[] = cachedData.chunks || [];

        // If no cache or text changed
        if (chunks.length === 0 || Math.abs((cachedData.textLength || 0) - fullText.length) > 100) {
            Zotero.debug("[RAG] Generating new chunks for item " + itemKey);
            const textChunks = splitText(fullText);

            if (isLocalSimple) {
                // For simple embedding, just store chunks without embeddings
                chunks = textChunks.map((chunk, index) => ({
                    text: chunk.text,
                    index,
                    startPos: chunk.startPos,
                    endPos: chunk.endPos
                }));
            } else {
                // For API-based embedding, generate embeddings
                const chunkTexts = textChunks.map(c => c.text);
                const embeddings = await fetchBatchEmbeddings(chunkTexts, embeddingProvider, apiKey, baseUrl, model);

                chunks = textChunks.map((chunk, index) => ({
                    text: chunk.text,
                    index,
                    startPos: chunk.startPos,
                    endPos: chunk.endPos,
                    embedding: embeddings[index]
                })).filter(c => c.embedding && c.embedding.length > 0);
            }

            await embeddingStorage.setItemCache(itemKey, {
                chunks,
                textLength: fullText.length,
                timestamp: Date.now()
            });
        } else {
            Zotero.debug("[RAG] Using cached chunks for item " + itemKey);
        }

        if (chunks.length === 0) return fullText;

        // 2. Similarity Search
        let topChunks: SearchResult[];

        if (isLocalSimple) {
            // Use TF-IDF based similarity search
            const chunkTexts = chunks.map(c => c.text);
            const similarDocs = findMostSimilar(query, chunkTexts, topK);

            topChunks = similarDocs.map(result => ({
                chunk: chunks[result.index],
                score: result.score
            }));

            Zotero.debug(`[RAG] Top scores (TF-IDF): ${topChunks.map(s => s.score.toFixed(3)).join(", ")}`);
        } else {
            // Use embedding-based similarity search
            const queryEmbedding = await fetchEmbedding(query, embeddingProvider, apiKey, baseUrl, model);
            if (queryEmbedding.length === 0) return fullText;

            const scores: SearchResult[] = chunks.map(chunk => ({
                chunk,
                score: cosineSimilarity(queryEmbedding, chunk.embedding!)
            }));

            scores.sort((a, b) => b.score - a.score);
            topChunks = scores.slice(0, topK);
            Zotero.debug(`[RAG] Top scores: ${topChunks.map(s => s.score.toFixed(3)).join(", ")}`);
        }

        // 4. Construct Context with position information
        const totalLength = fullText.length;
        return topChunks.map((s, idx) => {
            const chunk = s.chunk;
            let positionInfo = "";

            if (chunk.startPos !== undefined && chunk.endPos !== undefined) {
                // 计算在原文中的百分比位置
                const startPercent = Math.round((chunk.startPos / totalLength) * 100);
                const endPercent = Math.round((chunk.endPos / totalLength) * 100);
                positionInfo = `[位置: 约${startPercent}%-${endPercent}%处, Chunk ${chunk.index + 1}/${chunks.length}]\n`;
            }

            return positionInfo + chunk.text;
        }).join("\n\n---\n\n");
    }
}
