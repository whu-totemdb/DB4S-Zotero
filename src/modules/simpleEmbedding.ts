/**
 * Simple Local Embedding using TF-IDF
 * No API key needed, no external dependencies
 * Works completely offline
 */

interface TermFrequency {
    [term: string]: number;
}

interface DocumentVector {
    terms: TermFrequency;
    norm: number;
}

/**
 * Simple tokenizer - split text into words
 */
function tokenize(text: string): string[] {
    // Convert to lowercase and split by non-word characters
    return text
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 2); // Filter out very short words
}

/**
 * Calculate term frequency for a document
 */
function calculateTF(text: string): TermFrequency {
    const tokens = tokenize(text);
    const tf: TermFrequency = {};
    const totalTerms = tokens.length;

    for (const token of tokens) {
        tf[token] = (tf[token] || 0) + 1;
    }

    // Normalize by document length
    for (const term in tf) {
        tf[term] = tf[term] / totalTerms;
    }

    return tf;
}

/**
 * Calculate inverse document frequency
 */
function calculateIDF(documents: string[]): { [term: string]: number } {
    const idf: { [term: string]: number } = {};
    const docCount = documents.length;
    const termDocCount: { [term: string]: number } = {};

    // Count in how many documents each term appears
    for (const doc of documents) {
        const tokens = new Set(tokenize(doc));
        for (const token of tokens) {
            termDocCount[token] = (termDocCount[token] || 0) + 1;
        }
    }

    // Calculate IDF
    for (const term in termDocCount) {
        idf[term] = Math.log(docCount / termDocCount[term]);
    }

    return idf;
}

/**
 * Calculate TF-IDF vector for a document
 */
function calculateTFIDF(text: string, idf: { [term: string]: number }): DocumentVector {
    const tf = calculateTF(text);
    const vector: TermFrequency = {};
    let normSquared = 0;

    for (const term in tf) {
        const idfValue = idf[term] || 0;
        vector[term] = tf[term] * idfValue;
        normSquared += vector[term] * vector[term];
    }

    return {
        terms: vector,
        norm: Math.sqrt(normSquared)
    };
}

/**
 * Calculate cosine similarity between two TF-IDF vectors
 */
function cosineSimilarityTFIDF(vec1: DocumentVector, vec2: DocumentVector): number {
    if (vec1.norm === 0 || vec2.norm === 0) {
        return 0;
    }

    let dotProduct = 0;

    // Calculate dot product using terms from both vectors
    const allTerms = new Set([...Object.keys(vec1.terms), ...Object.keys(vec2.terms)]);

    for (const term of allTerms) {
        const val1 = vec1.terms[term] || 0;
        const val2 = vec2.terms[term] || 0;
        dotProduct += val1 * val2;
    }

    return dotProduct / (vec1.norm * vec2.norm);
}

/**
 * Generate a simple "embedding" representation using TF-IDF
 * This returns a vector-like structure that can be used for similarity search
 */
export function generateSimpleEmbedding(text: string, idf?: { [term: string]: number }): DocumentVector {
    // If IDF is not provided, use a simple TF representation
    if (!idf) {
        const tf = calculateTF(text);
        let normSquared = 0;
        for (const term in tf) {
            normSquared += tf[term] * tf[term];
        }
        return {
            terms: tf,
            norm: Math.sqrt(normSquared)
        };
    }

    return calculateTFIDF(text, idf);
}

/**
 * Generate embeddings for multiple texts with shared IDF
 */
export function generateBatchSimpleEmbeddings(texts: string[]): DocumentVector[] {
    // First pass: calculate IDF from all documents
    const idf = calculateIDF(texts);

    // Second pass: calculate TF-IDF for each document
    return texts.map(text => calculateTFIDF(text, idf));
}

/**
 * Calculate similarity between query and document using TF-IDF
 */
export function calculateSimilarity(query: string, document: string, idf?: { [term: string]: number }): number {
    const queryVec = generateSimpleEmbedding(query, idf);
    const docVec = generateSimpleEmbedding(document, idf);
    return cosineSimilarityTFIDF(queryVec, docVec);
}

/**
 * Find most similar documents to a query
 */
export function findMostSimilar(
    query: string,
    documents: string[],
    topK: number = 5
): Array<{ text: string; score: number; index: number }> {
    // Calculate IDF from all documents
    const idf = calculateIDF(documents);

    // Calculate similarity for each document
    const queryVec = generateSimpleEmbedding(query, idf);
    const results: Array<{ text: string; score: number; index: number }> = [];

    for (let i = 0; i < documents.length; i++) {
        const docVec = generateSimpleEmbedding(documents[i], idf);
        const score = cosineSimilarityTFIDF(queryVec, docVec);
        results.push({
            text: documents[i],
            score,
            index: i
        });
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, topK);
}

/**
 * Convert DocumentVector to a simple number array for compatibility
 * This creates a fixed-size vector by hashing terms
 */
export function vectorToArray(vector: DocumentVector, dimension: number = 384): number[] {
    const array = new Array(dimension).fill(0);

    // Simple hash-based embedding
    for (const term in vector.terms) {
        // Simple hash function
        let hash = 0;
        for (let i = 0; i < term.length; i++) {
            hash = ((hash << 5) - hash) + term.charCodeAt(i);
            hash = hash & hash; // Convert to 32-bit integer
        }
        const index = Math.abs(hash) % dimension;
        array[index] += vector.terms[term];
    }

    // Normalize
    const norm = Math.sqrt(array.reduce((sum, val) => sum + val * val, 0));
    if (norm > 0) {
        for (let i = 0; i < array.length; i++) {
            array[i] = array[i] / norm;
        }
    }

    return array;
}

