import {
  BasicExampleFactory,
  HelperExampleFactory,
  KeyExampleFactory,
  PromptExampleFactory,
  UIExampleFactory,
} from "./modules/examples";
import { ChatFactory } from "./modules/chat";
import { getString, initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  // BasicExampleFactory.registerPrefs();
  // We use our own prefs registration via manifest/bootstrap mechanism usually, 
  // but if this template uses manual registration:
  BasicExampleFactory.registerPrefs();

  // BasicExampleFactory.registerNotifier();
  // KeyExampleFactory.registerShortcuts();

  // Remove example UI registrations that might clutter the interface
  // await UIExampleFactory.registerExtraColumn();
  // await UIExampleFactory.registerExtraColumnWithCustomCell();
  // UIExampleFactory.registerItemPaneCustomInfoRow();
  // UIExampleFactory.registerItemPaneSection();
  // UIExampleFactory.registerReaderItemPaneSection();

  // Explicitly unregister if it was previously registered
  // Zotero.ItemPaneManager.unregisterSection("ai-mcp-chat");

  // Disable Sidebar registration as requested by user
  ChatFactory.registerItemPaneSection();
  // ChatFactory.registerRightClickMenu();
  ChatFactory.registerAnnotationPopup();

  // Monitor reader opening to add toolbar button and auto-switch chat
  // @ts-ignore - "render" is not in the official ReaderEventMap but works in runtime
  Zotero.Reader.registerEventListener("render", async (event: any) => {
    const reader = event.reader;
    ChatFactory.registerReaderToolbarButton(reader);

    // Auto-switch chat window to the opened PDF's item
    try {
      const itemID = reader.itemID;
      if (itemID) {
        const attachment = Zotero.Items.get(itemID);
        if (attachment) {
          // Get parent item if this is an attachment
          let displayItem = attachment;
          if (attachment.isAttachment()) {
            const parentID = attachment.parentItemID;
            if (parentID) {
              const parent = Zotero.Items.get(parentID);
              if (parent) displayItem = parent;
            }
          }

          // Check if chat window is open
          if (ChatFactory.isChatWindowOpen()) {
            // Switch to the item and create new conversation
            await Zotero.Promise.delay(500);
            ChatFactory.switchToItem(displayItem);
          }
        }
      }
    } catch (e) {
      Zotero.debug(`Error auto-switching chat window on render: ${e}`);
    }
  });

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  ChatFactory.registerToolbarButton(win);

  // Remove example popup window
  // const popupWin = new ztoolkit.ProgressWindow(...)

  await Zotero.Promise.delay(1000);

  // UIExampleFactory.registerStyleSheet(win);

  // CRITICAL: Comment out these lines to remove example menu items
  // UIExampleFactory.registerRightClickMenuItem();
  // UIExampleFactory.registerRightClickMenuPopup(win);
  // UIExampleFactory.registerWindowMenuWithSeparator();

  // PromptExampleFactory.registerNormalCommandExample();
  // PromptExampleFactory.registerAnonymousCommandExample(win);
  // PromptExampleFactory.registerConditionalCommandExample();

  await Zotero.Promise.delay(1000);

  // addon.hooks.onDialogEvents("dialogExample");
}

async function onMainWindowUnload(win: Window): Promise<void> {
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
}

function onShutdown(): void {
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

// Track last checked tab ID to avoid duplicate checks
let lastCheckedTabID: string | null = null;

async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  // ztoolkit.log("notify", event, type, ids, extraData);
  if (
    event === "select" &&
    type === "tab" &&
    extraData[ids[0]]?.type == "reader"
  ) {
    const tabID = String(ids[0]);

    // Only check once per tab switch (avoid duplicate checks)
    if (tabID === lastCheckedTabID) {
      return;
    }
    lastCheckedTabID = tabID;

    const reader = Zotero.Reader.getByTabID(tabID);
    if (reader) {
      // Add a small delay to ensure DOM is ready
      await Zotero.Promise.delay(500); // Increased delay
      ChatFactory.registerReaderToolbarButton(reader); // Removed await as it's not async anymore

      // Auto-switch chat window to the opened PDF's item (only check once per tab switch)
      try {
        const itemID = reader.itemID;
        if (itemID) {
          const attachment = Zotero.Items.get(itemID);
          if (attachment) {
            // Get parent item if this is an attachment
            let displayItem = attachment;
            if (attachment.isAttachment()) {
              const parentID = attachment.parentItemID;
              if (parentID) {
                const parent = Zotero.Items.get(parentID);
                if (parent) displayItem = parent;
              }
            }

            // Check if chat window is open
            if (ChatFactory.isChatWindowOpen()) {
              // Switch to the item and create new conversation
              // Add delay to ensure reader is fully loaded and chat window is ready
              await Zotero.Promise.delay(500);
              ChatFactory.switchToItem(displayItem);
            }
          }
        }
      } catch (e) {
        Zotero.debug(`Error auto-switching chat window: ${e}`);
      }
    }
  }
}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

function onShortcuts(type: string) {
  // Empty for now to remove example shortcuts
}

function onDialogEvents(type: string) {
  // Empty for now
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
  onDialogEvents,
};
