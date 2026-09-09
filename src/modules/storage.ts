
// Simple Local JSON Storage for Embeddings Cache
// Adapted for Zotero 7

export class LocalStorage {
  private filename: string;
  private cache: Record<string, any> = {};
  private initialized: Promise<void>;
  private _ready: boolean = false;

  constructor(filename: string) {
    this.filename = filename;
    this.initialized = this.init();
  }

  private async init() {
    try {
      // In Zotero 7, PathUtils is available globally
      // @ts-ignore
      const tempDir = PathUtils.tempDir;
      // @ts-ignore
      const filePath = PathUtils.join(tempDir, `${this.filename}.json`);
      this.filename = filePath;

      // @ts-ignore
      if (await IOUtils.exists(filePath)) {
        // @ts-ignore
        const text = await IOUtils.readUTF8(filePath);
        this.cache = JSON.parse(text);
      }
    } catch (e) {
      Zotero.log(`[Storage] Init error: ${e}`);
      this.cache = {};
    }
    this._ready = true;
  }

  async get(key: string): Promise<any> {
    if (!this._ready) await this.initialized;
    return this.cache[key];
  }

  async set(key: string, value: any): Promise<void> {
    if (!this._ready) await this.initialized;
    this.cache[key] = value;
    this.persist(); // Fire and forget
  }

  private async persist() {
    try {
      // @ts-ignore
      await IOUtils.writeUTF8(this.filename, JSON.stringify(this.cache));
    } catch (e) {
      Zotero.log(`[Storage] Write error: ${e}`);
    }
  }

  // Helper to get item specific cache
  async getItemCache(itemKey: string): Promise<Record<string, any>> {
    const all = await this.get(itemKey);
    return all || {};
  }

  async setItemCache(itemKey: string, data: any) {
    await this.set(itemKey, data);
  }
}

export const embeddingStorage = new LocalStorage("ai_for_science_embeddings");
export const conversationStorage = new LocalStorage("ai_for_science_conversations");
export const paperGroupStorage = new LocalStorage("ai_for_science_paper_groups");


