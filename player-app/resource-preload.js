'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('edulockDocument', {
    descriptor: () => ipcRenderer.invoke('resource-descriptor'),
    page: number => ipcRenderer.invoke('resource-page', number),
    close: () => ipcRenderer.send('resource-close'),
    onInvalidate: callback => ipcRenderer.on('resource-invalidated', (_event, message) => callback(String(message || 'Documento cerrado.'))),
    onLease: callback => ipcRenderer.on('resource-lease', (_event, milliseconds) => callback(milliseconds)),
});
