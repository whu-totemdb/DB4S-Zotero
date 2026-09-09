import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { MCPClient } from "./mcp";

interface MCPServerConfig {
    name: string;
    url: string;
    apiKey?: string;
}

// Custom alert function that displays at the top of the page
function showTopAlert(win: Window, message: string, type: "success" | "error" | "info" = "info") {
    const doc = win.document;

    // Try to use page-inline alert box first
    try {
        const alertBox = doc.getElementById("ai-alert-box") as any;
        const alertContent = doc.getElementById("ai-alert-content") as any;
        const alertClose = doc.getElementById("ai-alert-close") as any;

        if (!alertBox) {
            Zotero.debug(`[AI Settings] Alert box element not found in DOM`);
            throw new Error("Alert box element not found");
        }

        // Update content
        if (alertContent) {
            // Try different methods to set content
            try {
                if (alertContent.textContent !== undefined) {
                    alertContent.textContent = message;
                } else if (alertContent.text !== undefined) {
                    alertContent.text = message;
                } else if (alertContent.innerHTML !== undefined) {
                    alertContent.innerHTML = message.replace(/\n/g, "<br/>");
                } else {
                    alertContent.setAttribute("value", message);
                }
            } catch (e) {
                Zotero.debug(`[AI Settings] Failed to set alert content: ${e}`);
            }
        }

        // Remove type classes and add new one
        if (alertBox.classList) {
            alertBox.classList.remove("success", "error", "info", "show");
            alertBox.classList.add(type);
            alertBox.classList.add("show");
        } else {
            // Fallback for XUL elements without classList
            const classAttr = alertBox.getAttribute("class") || "";
            alertBox.setAttribute("class", `${classAttr} ${type} show`.trim());
        }

        // Remove hidden attribute and ensure it's visible
        alertBox.removeAttribute("hidden");

        // Set display style directly using multiple methods
        try {
            if (alertBox.style) {
                alertBox.style.display = "block";
                alertBox.style.visibility = "visible";
            }
            // Also set via setAttribute for XUL
            const currentStyle = alertBox.getAttribute("style") || "";
            if (!currentStyle.includes("display: block")) {
                alertBox.setAttribute("style", `${currentStyle}; display: block !important; visibility: visible !important;`.trim());
            }
        } catch (e) {
            Zotero.debug(`[AI Settings] Failed to set display style: ${e}`);
        }

        // Bind close button if it exists
        if (alertClose) {
            // Remove existing listeners by cloning
            const newClose = alertClose.cloneNode(true);
            alertClose.parentNode?.replaceChild(newClose, alertClose);

            // Add new listener
            newClose.addEventListener("command", () => {
                if (alertBox) {
                    alertBox.setAttribute("hidden", "true");
                    alertBox.classList.remove("show");
                    if (alertBox.style) {
                        alertBox.style.display = "none";
                    }
                }
            });

            // Also support click for HTML elements
            newClose.addEventListener("click", () => {
                if (alertBox) {
                    alertBox.setAttribute("hidden", "true");
                    alertBox.classList.remove("show");
                    if (alertBox.style) {
                        alertBox.style.display = "none";
                    }
                }
            });
        }

        // Ensure window is focused
        try {
            win.focus();
        } catch (e) {
            // Ignore focus errors
        }

        // Auto-close after delay
        const closeDelay = type === "error" ? 5000 : 3000;
        setTimeout(() => {
            try {
                if (alertBox) {
                    alertBox.setAttribute("hidden", "true");
                    alertBox.classList.remove("show");
                    if (alertBox.style) {
                        alertBox.style.display = "none";
                    }
                }
            } catch (e) {
                // Ignore
            }
        }, closeDelay);

        Zotero.debug(`[AI Settings] Alert displayed: ${type} - ${message.substring(0, 50)}...`);
        return;
    } catch (e) {
        Zotero.debug(`[AI Settings] Inline alert failed: ${e}`);
        Zotero.debug(`[AI Settings] Error stack: ${(e as Error).stack}`);
    }

    // Fallback to native alert
    try {
        win.focus();
        win.alert(message);
    } catch (e2) {
        Zotero.debug(`[AI Settings] Alert also failed: ${e2}`);
        Zotero.log(`[AI Settings] ${type.toUpperCase()}: ${message}`);
    }
}

export async function registerPrefsScripts(_window: Window) {
    // This function is called when the prefs window is opened
    if (!addon.data.prefs) {
        addon.data.prefs = {
            window: _window,
            columns: [],
            rows: []
        };
    } else {
        addon.data.prefs.window = _window;
    }

    bindPrefEvents();
    updateProviderSettingsUI();
    updateEmbeddingSettingsUI(); // Init embedding UI
    loadMCPServers();
}

function updateProviderSettingsUI() {
    const doc = addon.data.prefs!.window.document;
    // Get the provider menulist
    const providerMenu = doc.getElementById(`zotero-prefpane-${config.addonRef}-provider`) as XUL.MenuList;
    if (!providerMenu) return;

    const provider = providerMenu.value;

    const groups = ["OpenAI", "DeepSeek", "Gemini", "Claude", "Custom"];

    // Ensure all groups are hidden first
    groups.forEach(group => {
        const vbox = doc.getElementById(`group-${group}`);
        if (vbox) {
            vbox.setAttribute("hidden", "true");
        }
    });

    // Show the selected group
    if (provider) {
        const vbox = doc.getElementById(`group-${provider}`);
        if (vbox) {
            vbox.removeAttribute("hidden");
        }
    }
}

function updateEmbeddingSettingsUI() {
    const doc = addon.data.prefs!.window.document;
    const embeddingMenu = doc.getElementById(`zotero-prefpane-${config.addonRef}-embeddingProvider`) as XUL.MenuList;
    if (!embeddingMenu) return;

    const prefsPrefix = config.prefsPrefix;

    // Get current value, default to Local if not set
    let provider = embeddingMenu.value;
    if (!provider || provider === "default") {
        provider = "Local";
        embeddingMenu.value = "Local";
        // Save the default
        Zotero.Prefs.set(`${prefsPrefix}.embeddingProvider`, "Local");
    }

    const customGroup = doc.getElementById("group-Embedding-Custom");
    const localGroup = doc.getElementById("group-Embedding-Local");

    // Show/hide Custom group
    if (customGroup) {
        if (provider === "Custom") {
            customGroup.removeAttribute("hidden");
        } else {
            customGroup.setAttribute("hidden", "true");
        }
    }

    // Show/hide Local group
    if (localGroup) {
        if (provider === "Local" || provider === "Simple" || provider === "TF-IDF") {
            localGroup.removeAttribute("hidden");
        } else {
            localGroup.setAttribute("hidden", "true");
        }
    }
}

function loadMCPServers() {
    const doc = addon.data.prefs!.window.document;
    const list = doc.getElementById("mcp-server-list") as HTMLSelectElement;
    if (!list) return;

    list.innerHTML = "";
    const prefsPrefix = config.prefsPrefix;
    let serversStr = Zotero.Prefs.get(`${prefsPrefix}.mcpServers`) as string;
    let servers: MCPServerConfig[] = [];
    try {
        servers = JSON.parse(serversStr || "[]");
    } catch (e) {
        Zotero.debug(`Error parsing MCP servers: ${e}`);
    }

    servers.forEach((server, index) => {
        const option = doc.createElement("option");
        option.value = index.toString();
        option.text = `${server.name} (${server.url})`;
        list.appendChild(option);
    });
}

function saveMCPServers(servers: MCPServerConfig[]) {
    const prefsPrefix = config.prefsPrefix;
    Zotero.Prefs.set(`${prefsPrefix}.mcpServers`, JSON.stringify(servers));
    loadMCPServers();
}

function bindPrefEvents() {
    const doc = addon.data.prefs!.window.document;
    const providerMenu = doc.getElementById(`zotero-prefpane-${config.addonRef}-provider`) as XUL.MenuList;
    const embeddingMenu = doc.getElementById(`zotero-prefpane-${config.addonRef}-embeddingProvider`) as XUL.MenuList;
    const testButton = doc.getElementById(`zotero-prefpane-${config.addonRef}-test-connection`) as XUL.Button;
    const saveButton = doc.getElementById(`zotero-prefpane-${config.addonRef}-save-connection`) as XUL.Button;
    const testEmbeddingButton = doc.getElementById(`zotero-prefpane-${config.addonRef}-test-embedding`) as XUL.Button;
    const saveEmbeddingButton = doc.getElementById(`zotero-prefpane-${config.addonRef}-save-embedding`) as XUL.Button;

    // MCP Buttons
    const addBtn = doc.getElementById("mcp-add-btn");
    const removeBtn = doc.getElementById("mcp-remove-btn");
    const checkBtn = doc.getElementById("mcp-check-btn");

    if (checkBtn) {
        checkBtn.addEventListener("command", async () => {
            const list = doc.getElementById("mcp-server-list") as HTMLSelectElement;
            if (!list || list.selectedIndex < 0) {
                showTopAlert(addon.data.prefs!.window, "Please select a server to check.", "info");
                return;
            }

            const index = parseInt(list.value);
            const prefsPrefix = config.prefsPrefix;
            let serversStr = Zotero.Prefs.get(`${prefsPrefix}.mcpServers`) as string;
            let servers: MCPServerConfig[] = [];
            try {
                servers = JSON.parse(serversStr || "[]");
            } catch (e) { }

            if (index >= 0 && index < servers.length) {
                const server = servers[index];
                const win = addon.data.prefs!.window;

                // Update UI to show checking
                checkBtn.textContent = "Checking...";
                // @ts-ignore
                checkBtn.disabled = true;

                try {
                    const client = new MCPClient(server.url, server.apiKey);
                    await client.connect();
                    const tools = await client.getTools();
                    const toolNames = tools.tools.map((t: any) => t.name).join(", ");
                    showTopAlert(win, `Success!\nServer: ${server.name}\nTools found: ${tools.tools.length}\n[${toolNames}]`, "success");
                    client.close();
                } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : String(e);
                    showTopAlert(win, `Failed to connect to ${server.name}:\n${msg}`, "error");
                } finally {
                    checkBtn.textContent = "Check Status";
                    // @ts-ignore
                    checkBtn.disabled = false;
                }
            }
        });
    }

    if (addBtn) {
        addBtn.addEventListener("command", () => {
            const win = addon.data.prefs!.window;
            const dialog = doc.getElementById("mcp-add-dialog");
            if (dialog) {
                dialog.removeAttribute("hidden");
                (doc.getElementById("mcp-new-name") as HTMLInputElement).value = "";
                (doc.getElementById("mcp-new-url") as HTMLInputElement).value = "";
                (doc.getElementById("mcp-new-key") as HTMLInputElement).value = "";
                (doc.getElementById("mcp-new-name") as HTMLInputElement).focus();
            } else {
                const name = win.prompt("Enter Server Name:", "Local Tools");
                if (!name) return;
                const url = win.prompt("Enter SSE URL:", "http://localhost:8000/sse");
                if (!url) return;
                const apiKey = win.prompt("Enter API Key (Optional):", "");
                addServer(name, url, apiKey);
            }
        });
    }

    // Helper to add server
    const addServer = (name: string, url: string, apiKey: string | null) => {
        const prefsPrefix = config.prefsPrefix;
        let serversStr = Zotero.Prefs.get(`${prefsPrefix}.mcpServers`) as string;
        let servers: MCPServerConfig[] = [];
        try {
            servers = JSON.parse(serversStr || "[]");
        } catch (e) { }

        servers.push({ name, url, apiKey: apiKey || "" });
        saveMCPServers(servers);
    };

    // Bind Dialog Buttons (Confirm/Cancel)
    const dialogConfirm = doc.getElementById("mcp-dialog-confirm");
    const dialogCancel = doc.getElementById("mcp-dialog-cancel");

    if (dialogConfirm) {
        dialogConfirm.addEventListener("command", () => {
            const name = (doc.getElementById("mcp-new-name") as HTMLInputElement).value;
            const url = (doc.getElementById("mcp-new-url") as HTMLInputElement).value;
            const apiKey = (doc.getElementById("mcp-new-key") as HTMLInputElement).value;

            if (name && url) {
                addServer(name, url, apiKey);
                const dialog = doc.getElementById("mcp-add-dialog");
                if (dialog) dialog.setAttribute("hidden", "true");
            } else {
                showTopAlert(addon.data.prefs!.window, "Name and URL are required.", "error");
            }
        });
    }

    if (dialogCancel) {
        dialogCancel.addEventListener("command", () => {
            const dialog = doc.getElementById("mcp-add-dialog");
            if (dialog) dialog.setAttribute("hidden", "true");
        });
    }

    if (removeBtn) {
        removeBtn.addEventListener("command", () => {
            const list = doc.getElementById("mcp-server-list") as HTMLSelectElement;
            if (!list || list.selectedIndex < 0) return;

            const win = addon.data.prefs!.window;
            const index = parseInt(list.value);
            const prefsPrefix = config.prefsPrefix;
            let serversStr = Zotero.Prefs.get(`${prefsPrefix}.mcpServers`) as string;
            let servers: MCPServerConfig[] = [];
            try {
                servers = JSON.parse(serversStr || "[]");
            } catch (e) { }

            if (index >= 0 && index < servers.length) {
                if (win.confirm(`Remove server "${servers[index].name}"?`)) {
                    servers.splice(index, 1);
                    saveMCPServers(servers);
                }
            }
        });
    }

    if (providerMenu) {
        providerMenu.addEventListener("command", () => {
            updateProviderSettingsUI();
        });
        providerMenu.addEventListener("select", () => {
            updateProviderSettingsUI();
        });
    }

    if (embeddingMenu) {
        embeddingMenu.addEventListener("command", () => updateEmbeddingSettingsUI());
        embeddingMenu.addEventListener("select", () => updateEmbeddingSettingsUI());
    }

    if (saveButton) {
        // Use both addEventListener and oncommand for compatibility
        saveButton.addEventListener("command", () => {
            Zotero.debug("[AI Settings] Save button clicked");
            saveConfiguration();
        });
        // @ts-ignore
        saveButton.oncommand = () => {
            Zotero.debug("[AI Settings] Save button clicked (oncommand)");
            saveConfiguration();
        };
    } else {
        Zotero.debug(`[AI Settings] Save button not found! ID: zotero-prefpane-${config.addonRef}-save-connection`);
    }

    if (testButton) {
        testButton.addEventListener("command", async () => {
            Zotero.debug("[AI Settings] Test button clicked");
            await testConnection();
        });
        // @ts-ignore
        testButton.oncommand = async () => {
            Zotero.debug("[AI Settings] Test button clicked (oncommand)");
            await testConnection();
        };
    } else {
        Zotero.debug(`[AI Settings] Test button not found! ID: zotero-prefpane-${config.addonRef}-test-connection`);
    }

    if (saveEmbeddingButton) {
        saveEmbeddingButton.addEventListener("command", () => {
            Zotero.debug("[AI Settings] Save embedding button clicked");
            saveConfiguration();
        });
        // @ts-ignore
        saveEmbeddingButton.oncommand = () => {
            Zotero.debug("[AI Settings] Save embedding button clicked (oncommand)");
            saveConfiguration();
        };
    } else {
        Zotero.debug(`[AI Settings] Save embedding button not found! ID: zotero-prefpane-${config.addonRef}-save-embedding`);
    }

    if (testEmbeddingButton) {
        testEmbeddingButton.addEventListener("command", async () => {
            Zotero.debug("[AI Settings] Test embedding button clicked");
            await testEmbeddingConnection();
        });
        // @ts-ignore
        testEmbeddingButton.oncommand = async () => {
            Zotero.debug("[AI Settings] Test embedding button clicked (oncommand)");
            await testEmbeddingConnection();
        };
    } else {
        Zotero.debug(`[AI Settings] Test embedding button not found! ID: zotero-prefpane-${config.addonRef}-test-embedding`);
    }
}

function saveConfiguration() {
    const doc = addon.data.prefs!.window.document;
    const prefsPrefix = config.prefsPrefix;

    // Manual mapping of IDs to Pref Keys
    const prefMap: { [key: string]: string } = {
        "pref-openaiApiKey": "openaiApiKey",
        "pref-openaiModel": "openaiModel",
        "pref-openaiBaseUrl": "openaiBaseUrl",
        "pref-deepseekApiKey": "deepseekApiKey",
        "pref-deepseekModel": "deepseekModel",
        "pref-deepseekBaseUrl": "deepseekBaseUrl",
        "pref-geminiApiKey": "geminiApiKey",
        "pref-geminiModel": "geminiModel",
        "pref-claudeApiKey": "claudeApiKey",
        "pref-claudeModel": "claudeModel",
        "pref-claudeBaseUrl": "claudeBaseUrl",
        "pref-customApiKey": "customApiKey",
        "pref-customModel": "customModel",
        "pref-customBaseUrl": "customBaseUrl",
        // Embedding keys
        "pref-embeddingApiKey": "embeddingApiKey",
        "pref-embeddingModel": "embeddingModel",
        "pref-embeddingBaseUrl": "embeddingBaseUrl",
        "pref-embeddingModel-local": "embeddingModel" // Local provider uses same pref key
    };

    let changedCount = 0;

    // Save Provider
    const providerMenu = doc.getElementById(`zotero-prefpane-${config.addonRef}-provider`) as XUL.MenuList;
    if (providerMenu) {
        Zotero.Prefs.set(`${prefsPrefix}.provider`, providerMenu.value);
    }

    // Save Embedding Provider
    const embeddingMenu = doc.getElementById(`zotero-prefpane-${config.addonRef}-embeddingProvider`) as XUL.MenuList;
    if (embeddingMenu) {
        const value = embeddingMenu.value || "Local"; // Default to Local
        Zotero.Prefs.set(`${prefsPrefix}.embeddingProvider`, value);
    }

    // Save MCP Checkbox
    const mcpEnabled = doc.getElementById("pref-mcpEnabled") as any;
    if (mcpEnabled) {
        Zotero.Prefs.set(`${prefsPrefix}.mcpEnabled`, mcpEnabled.checked);
    }

    // Save Inputs
    for (const [id, prefKey] of Object.entries(prefMap)) {
        const input = doc.getElementById(id) as HTMLInputElement;
        if (input) {
            Zotero.Prefs.set(`${prefsPrefix}.${prefKey}`, input.value);
            changedCount++;
        }
    }

    showTopAlert(addon.data.prefs!.window, "Configuration saved successfully.", "success");
}

async function testConnection() {
    const win = addon.data.prefs!.window;
    const doc = win.document;
    const providerMenu = doc.getElementById(`zotero-prefpane-${config.addonRef}-provider`) as XUL.MenuList;

    const prefsPrefix = config.prefsPrefix;

    const provider = providerMenu ? providerMenu.value : Zotero.Prefs.get(`${prefsPrefix}.provider`);

    if (!provider) {
        showTopAlert(win, "Please select a provider first.", "info");
        return;
    }

    const getValue = (id: string, prefKey: string) => {
        const input = doc.getElementById(id) as HTMLInputElement;
        if (input && input.value) return input.value;
        const val = Zotero.Prefs.get(`${prefsPrefix}.${prefKey}`);
        return val ? String(val) : "";
    };

    let baseUrl = "";
    let apiKey = "";
    let model = "";

    switch (provider) {
        case "OpenAI":
            baseUrl = getValue("pref-openaiBaseUrl", "openaiBaseUrl");
            apiKey = getValue("pref-openaiApiKey", "openaiApiKey");
            model = getValue("pref-openaiModel", "openaiModel");
            break;
        case "DeepSeek":
            baseUrl = getValue("pref-deepseekBaseUrl", "deepseekBaseUrl");
            apiKey = getValue("pref-deepseekApiKey", "deepseekApiKey");
            model = getValue("pref-deepseekModel", "deepseekModel");
            break;
        case "Gemini":
            apiKey = getValue("pref-geminiApiKey", "geminiApiKey");
            model = getValue("pref-geminiModel", "geminiModel");
            baseUrl = "https://generativelanguage.googleapis.com/v1beta/models";
            break;
        case "Claude":
            baseUrl = getValue("pref-claudeBaseUrl", "claudeBaseUrl");
            apiKey = getValue("pref-claudeApiKey", "claudeApiKey");
            model = getValue("pref-claudeModel", "claudeModel");
            break;
        case "Custom":
            baseUrl = getValue("pref-customBaseUrl", "customBaseUrl");
            apiKey = getValue("pref-customApiKey", "customApiKey");
            model = getValue("pref-customModel", "customModel");
            break;
    }

    if (!apiKey) {
        showTopAlert(win, `Please set API Key for ${provider}.`, "error");
        return;
    }

    const prompt = "Hello";

    try {
        if (provider === "Gemini") {
            const url = `${baseUrl}/${model}:generateContent?key=${apiKey}`;

            const response = await Zotero.HTTP.request("POST", url, {
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }]
                }),
                responseType: "json"
            });

            if (response.status === 200 && response.response) {
                const data = response.response;
                if (data.candidates && data.candidates.length > 0) {
                    showTopAlert(win, `Connection Test Successful!\nProvider: ${provider}\nResponse: OK`, "success");
                }
            } else {
                throw new Error(`API Error ${response.status}: ${JSON.stringify(response.response)}`);
            }

        } else if (provider === "Claude") {
            // Claude uses a different API format
            const endpoint = `${baseUrl}/messages`.replace(/([^:]\/)\/+/g, "$1");

            const response = await Zotero.HTTP.request("POST", endpoint, {
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": apiKey,
                    "anthropic-version": "2023-06-01"
                },
                body: JSON.stringify({
                    model: model,
                    max_tokens: 5,
                    messages: [
                        { role: "user", content: prompt }
                    ]
                }),
                responseType: "json"
            });

            if (response.status === 200 && response.response) {
                const data = response.response;
                if (data.content && data.content.length > 0) {
                    showTopAlert(win, `Connection Test Successful!\nProvider: ${provider}\nResponse: OK`, "success");
                }
            } else {
                throw new Error(`API Error ${response.status}: ${JSON.stringify(response.response)}`);
            }

        } else {
            let endpoint = `${baseUrl}/chat/completions`;
            endpoint = endpoint.replace(/([^:]\/)\/+/g, "$1");

            const response = await Zotero.HTTP.request("POST", endpoint, {
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: model,
                    messages: [
                        { role: "user", content: prompt }
                    ],
                    max_tokens: 5
                }),
                responseType: "json"
            });

            if (response.status === 200 && response.response) {
                const data = response.response;
                if (data.choices && data.choices.length > 0) {
                    showTopAlert(win, `Connection Test Successful!\nProvider: ${provider}\nResponse: OK`, "success");
                }
            } else {
                throw new Error(`API Error ${response.status}: ${JSON.stringify(response.response)}`);
            }
        }

    } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        showTopAlert(win, `Connection Test Failed:\n${errorMessage}`, "error");
    }
}

async function testEmbeddingConnection() {
    const win = addon.data.prefs!.window;
    const doc = win.document;
    const prefsPrefix = config.prefsPrefix;

    const embeddingMenu = doc.getElementById(`zotero-prefpane-${config.addonRef}-embeddingProvider`) as XUL.MenuList;
    const provider = embeddingMenu ? embeddingMenu.value : Zotero.Prefs.get(`${prefsPrefix}.embeddingProvider`);

    if (!provider) {
        showTopAlert(win, "Please select an embedding provider.", "info");
        return;
    }

    const getValue = (id: string, prefKey: string) => {
        const input = doc.getElementById(id) as HTMLInputElement;
        if (input && input.value) return input.value;
        const val = Zotero.Prefs.get(`${prefsPrefix}.${prefKey}`);
        return val ? String(val) : "";
    };

    let baseUrl = "";
    let apiKey = "";
    let model = "";

    if (provider === "Local" || provider === "Simple" || provider === "TF-IDF") {
        // Local simple embedding using TF-IDF - no API key needed, works offline
        try {
            showTopAlert(win, "Testing local TF-IDF embedding...", "info");

            // Test simple embedding
            const { findMostSimilar } = await import("../modules/simpleEmbedding");
            const testDocs = [
                "This is a test document about artificial intelligence and machine learning.",
                "Another document discussing natural language processing and embeddings.",
                "A third document about computer science and algorithms."
            ];
            const results = findMostSimilar("artificial intelligence", testDocs, 1);

            if (results && results.length > 0 && results[0].score > 0) {
                showTopAlert(win, `Success! Local TF-IDF embedding is working.\nSimilarity score: ${results[0].score.toFixed(3)}\n\nThis method works completely offline with no API key needed.`, "success");
            } else {
                showTopAlert(win, "Failed: No similarity results generated.", "error");
            }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            showTopAlert(win, `Failed to test local embedding:\n${msg}`, "error");
        }
        return;
    } else if (provider === "OpenAI") {
        apiKey = getValue("pref-openaiApiKey", "openaiApiKey");
        baseUrl = getValue("pref-openaiBaseUrl", "openaiBaseUrl") || "https://api.openai.com/v1";
        model = "text-embedding-3-small";
    } else if (provider === "Gemini") {
        apiKey = getValue("pref-geminiApiKey", "geminiApiKey");
        baseUrl = "https://generativelanguage.googleapis.com/v1beta/models";
        model = "text-embedding-004";
    } else if (provider === "Custom") {
        apiKey = getValue("pref-embeddingApiKey", "embeddingApiKey");
        baseUrl = getValue("pref-embeddingBaseUrl", "embeddingBaseUrl");
        model = getValue("pref-embeddingModel", "embeddingModel");
    }

    if (!apiKey) {
        showTopAlert(win, `Please set API Key for ${provider}.`, "error");
        return;
    }

    const text = "Hello World";

    try {
        if (provider === "Gemini") {
            const url = `${baseUrl}/${model}:embedContent?key=${apiKey}`;
            const response = await Zotero.HTTP.request("POST", url, {
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    content: { parts: [{ text: text }] }
                }),
                responseType: "json"
            });

            if (response.status === 200 && response.response) {
                if (response.response.embedding && response.response.embedding.values) {
                    showTopAlert(win, `Embedding Test Successful!\nProvider: ${provider}\nDimensions: ${response.response.embedding.values.length}`, "success");
                } else {
                    throw new Error("Invalid response format: " + JSON.stringify(response.response));
                }
            } else {
                throw new Error(`API Error ${response.status}: ${JSON.stringify(response.response)}`);
            }

        } else {
            // OpenAI / Custom Compatible
            let url = `${baseUrl}/embeddings`;
            url = url.replace(/([^:]\/)\/+/g, "$1");

            const body: any = {
                input: text
            };
            if (model) body.model = model;

            const response = await Zotero.HTTP.request("POST", url, {
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`
                },
                body: JSON.stringify(body),
                responseType: "json"
            });

            if (response.status === 200 && response.response) {
                const data = response.response;
                if (data.data && data.data.length > 0 && data.data[0].embedding) {
                    showTopAlert(win, `Embedding Test Successful!\nProvider: ${provider}\nDimensions: ${data.data[0].embedding.length}`, "success");
                } else {
                    throw new Error("Invalid response format: " + JSON.stringify(data));
                }
            } else {
                throw new Error(`API Error ${response.status}: ${JSON.stringify(response.response)}`);
            }
        }

    } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        showTopAlert(win, `Embedding Test Failed:\n${errorMessage}`, "error");
    }
}
