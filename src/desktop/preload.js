const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mediaWall", {
  mode: "desktop",
  chooseFolder: () => ipcRenderer.invoke("choose-folder"),
  scanFolder: (folder) => ipcRenderer.invoke("scan-folder", folder),
  watchFolder: (folder) => ipcRenderer.invoke("watch-folder", folder),
  onMediaUpdated: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("folder-media-updated", listener);
    return () => ipcRenderer.removeListener("folder-media-updated", listener);
  },
  toggleFullscreen: () => ipcRenderer.invoke("toggle-fullscreen"),
  quitApp: () => ipcRenderer.invoke("quit-app")
});
