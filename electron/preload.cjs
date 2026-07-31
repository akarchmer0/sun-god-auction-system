const { contextBridge, ipcRenderer } = require("electron");

const hostToken = process.argv.find((argument) => argument.startsWith("--sun-god-host-token="))?.slice("--sun-god-host-token=".length) || "";
contextBridge.exposeInMainWorld("sunGod", Object.freeze({
  hostToken,
  isDesktop: true,
  credentials: Object.freeze({ set: (value) => ipcRenderer.invoke("credentials:set", value) }),
  relaySession: Object.freeze({ get: () => ipcRenderer.invoke("relay-session:get"), set: (value) => ipcRenderer.invoke("relay-session:set", value) }),
  diagnostics: Object.freeze({ export: () => ipcRenderer.invoke("diagnostics:export") })
}));
