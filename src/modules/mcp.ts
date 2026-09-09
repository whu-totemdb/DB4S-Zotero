export class MCPClient {
    private sseUrl: string;
    private apiKey: string;
    private postUrl: string = "";
    private eventSource: EventSource | null = null;
    private _isConnected: boolean = false;

    constructor(sseUrl: string, apiKey: string = "") {
        this.sseUrl = sseUrl;
        this.apiKey = apiKey;
    }

    async connect() {
        if (this._isConnected) return;

        return new Promise<void>((resolve, reject) => {
            try {
                let EventSourceClass: any = null;

                // Try global scope first
                if (typeof EventSource !== 'undefined') {
                    EventSourceClass = EventSource;
                } else if (typeof globalThis !== 'undefined' && (globalThis as any).EventSource) {
                    EventSourceClass = (globalThis as any).EventSource;
                } else {
                    // Fallback to Zotero Main Window
                    const win = Zotero.getMainWindow();
                    if (win && (win as any).EventSource) {
                        EventSourceClass = (win as any).EventSource;
                    }
                }

                if (!EventSourceClass) {
                    reject(new Error("EventSource is not defined."));
                    return;
                }

                const sseUrl = this.withApiKey(this.sseUrl);
                this.eventSource = new EventSourceClass(sseUrl);

                if (!this.eventSource) return;

                this.eventSource.onopen = () => {
                    Zotero.debug(`[MCP] Connected to SSE: ${this.sseUrl}`);
                };

                this.eventSource.addEventListener("endpoint", (event: any) => {
                    const data = event.data;
                    // The data is the URL (relative or absolute)
                    try {
                        const url = new URL(data, this.sseUrl);
                        this.postUrl = url.toString();
                        Zotero.debug(`[MCP] Received POST endpoint: ${this.postUrl}`);
                        this._isConnected = true;
                        resolve();
                    } catch (e) {
                        Zotero.debug(`[MCP] Error parsing endpoint: ${e}`);
                        reject(e);
                    }
                });

                this.eventSource.onerror = (err) => {
                    Zotero.debug(`[MCP] SSE Error: ${JSON.stringify(err)}`);
                    if (!this._isConnected) {
                        // Don't reject immediately here as it might be retrying or just establishing
                        // but if it errors before 'endpoint' event, it's problematic.
                    }
                    if (this._isConnected) {
                        Zotero.debug("[MCP] Connection lost or error occurred.");
                    }
                };

                // Set a timeout for connection
                setTimeout(() => {
                    if (!this._isConnected) {
                        if (this.eventSource) {
                            this.eventSource.close();
                            this.eventSource = null;
                        }
                        reject(new Error("Connection timeout"));
                    }
                }, 10000); // Increased timeout to 10s for remote servers

            } catch (e) {
                reject(e);
            }
        });
    }

    async request(method: string, params?: any, retries: number = 3, retryDelay: number = 1000) {
        if (!this.postUrl) {
            throw new Error("MCP Client not connected or no POST endpoint received.");
        }

        const body = {
            jsonrpc: "2.0",
            id: Date.now(),
            method: method,
            params: params || {}
        };

        const headers: any = { "Content-Type": "application/json" };
        if (this.apiKey) {
            headers["Authorization"] = `Bearer ${this.apiKey}`;
        }

        // Retry logic for handling 202 with null data (server initialization)
        for (let attempt = 0; attempt < retries; attempt++) {
            const response = await Zotero.HTTP.request("POST", this.postUrl, {
                headers: headers,
                body: JSON.stringify(body),
                responseType: "json",
                timeout: 0 // disable default timeout for MCP requests
            });

            if (response.status !== 200 && response.status !== 202) {
                throw new Error(`MCP Request Failed: ${response.status}`);
            }

            const data = response.response;

            // For 202 Accepted, the response body might be null or empty
            // This often means server is still initializing, so we retry
            if (response.status === 202) {
                if (!data || data === null) {
                    // Server is still initializing, retry after delay
                    if (attempt < retries - 1) {
                        Zotero.debug(`[MCP] Server returned 202 with null data (initialization in progress), retrying in ${retryDelay}ms... (attempt ${attempt + 1}/${retries})`);
                        await new Promise(resolve => setTimeout(resolve, retryDelay));
                        // Increase delay for next retry (exponential backoff)
                        retryDelay *= 1.5;
                        continue;
                    } else {
                        // Last attempt failed, return null gracefully
                        Zotero.debug(`[MCP] Server returned 202 with null data after ${retries} attempts, returning null`);
                        return null;
                    }
                }
                // If data exists for 202, check for errors but still return result (might be null)
                if (data.error) {
                    throw new Error(`MCP Error: ${data.error.message}`);
                }
                return data.result !== undefined ? data.result : null;
            }

            // For 200 status, data should exist
            if (!data || data === null) {
                throw new Error(`MCP Request Failed: Response data is null (status ${response.status})`);
            }

            if (data.error) {
                throw new Error(`MCP Error: ${data.error.message}`);
            }

            return data.result;
        }

        // Should not reach here, but just in case
        throw new Error(`MCP Request failed after ${retries} retries`);
    }

    async getTools() {
        return this.request("tools/list");
    }

    async callTool(name: string, args: any) {
        const result = await this.request("tools/call", {
            name: name,
            arguments: args
        }, 3, 1000);
        try {
            const text = JSON.stringify(result);
            const preview = text && text.length > 2000 ? `${text.slice(0, 2000)}...` : text;
            Zotero.debug(`[MCP] Tool ${name} result: ${preview}`);
        } catch (e) {
            Zotero.debug(`[MCP] Tool ${name} result (non-serializable): ${e}`);
        }
        return result;
    }

    close() {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
            this._isConnected = false;
        }
    }

    private withApiKey(urlString: string): string {
        if (!this.apiKey) return urlString;
        try {
            const url = new URL(urlString);
            if (!url.searchParams.has("api_key") && !url.searchParams.has("token")) {
                url.searchParams.set("api_key", this.apiKey);
            }
            return url.toString();
        } catch (e) {
            Zotero.debug(`[MCP] Invalid URL for api key injection: ${e}`);
            return urlString;
        }
    }

}
