const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("optimizer", {
  chooseFolder: (title) => ipcRenderer.invoke("choose-folder", title),
  start: (settings) => ipcRenderer.invoke("optimizer-start", settings),
  stop: () => ipcRenderer.invoke("optimizer-stop"),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("optimizer-event", listener);
    return () => ipcRenderer.removeListener("optimizer-event", listener);
  },
  onLog: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("optimizer-log", listener);
    return () => ipcRenderer.removeListener("optimizer-log", listener);
  }
});
