const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const fs = require("fs/promises");
const watchFs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { loadFolderData } = require("../shared/media");

const folderWatchers = new Map();

async function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#050507",
    title: "Media Wall",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  await win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

function createDesktopItem({ fullPath, name, type }) {
  return {
    id: fullPath,
    name,
    type,
    path: fullPath,
    url: pathToFileURL(fullPath).href,
    fallbackUrl: null
  };
}

function createDesktopSubfolder({ fullPath, name }) {
  return {
    name,
    path: fullPath
  };
}

function loadDesktopFolderData(folder) {
  return loadFolderData(folder, createDesktopItem, createDesktopSubfolder);
}

ipcMain.handle("choose-folder", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose a media folder",
    properties: ["openDirectory"]
  });

  if (result.canceled || result.filePaths.length === 0) return null;

  const folder = result.filePaths[0];
  return loadDesktopFolderData(folder);
});

ipcMain.handle("scan-folder", async (_event, folder) => {
  if (!folder) return null;
  try {
    await fs.access(folder);
    return loadDesktopFolderData(folder);
  } catch {
    return null;
  }
});

ipcMain.handle("watch-folder", (event, folder) => {
  const senderId = event.sender.id;
  const existing = folderWatchers.get(senderId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.watcher.close();
    folderWatchers.delete(senderId);
  }

  if (!folder) return false;

  const watcherState = { watcher: null, timer: null };
  const rescan = () => {
    clearTimeout(watcherState.timer);
    watcherState.timer = setTimeout(async () => {
      try {
        const folderData = await loadDesktopFolderData(folder);
        if (!event.sender.isDestroyed()) {
          event.sender.send("folder-media-updated", folderData);
        }
      } catch {
        // Folder changes can arrive while files are still being copied.
      }
    }, 650);
  };

  try {
    watcherState.watcher = watchFs.watch(folder, { recursive: true }, rescan);
  } catch {
    return false;
  }
  folderWatchers.set(senderId, watcherState);

  event.sender.once("destroyed", () => {
    clearTimeout(watcherState.timer);
    watcherState.watcher.close();
    folderWatchers.delete(senderId);
  });

  return true;
});

ipcMain.handle("toggle-fullscreen", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  win.setFullScreen(!win.isFullScreen());
  return win.isFullScreen();
});

ipcMain.handle("quit-app", () => {
  app.quit();
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) await createWindow();
});
