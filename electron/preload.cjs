const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("streamChatApp", {
  isDesktop: true,
  platform: process.platform,
  openOverlay: () => ipcRenderer.invoke("overlay:open"),
  closeOverlay: () => ipcRenderer.invoke("overlay:close"),
  toggleAlwaysOnTop: () => ipcRenderer.invoke("window:toggle-always-on-top"),
  getAlwaysOnTop: () => ipcRenderer.invoke("window:get-always-on-top"),
  onComposer: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = () => callback();
    ipcRenderer.on("overlay:composer", listener);
    return () => ipcRenderer.removeListener("overlay:composer", listener);
  },
  endComposer: () => ipcRenderer.send("overlay:composer-end"),
  setOverlaySize: (size) => ipcRenderer.invoke("overlay:set-size", size),
  finishOverlayEdit: () => ipcRenderer.invoke("overlay:finish-edit"),
  copyObsUrl: () => ipcRenderer.invoke("overlay:copy-obs"),
});
