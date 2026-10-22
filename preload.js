const { contextBridge, ipcRenderer } = require('electron');

const allowed = [
  'tab:new', 'tab:activate', 'tab:close',
  'nav:go', 'nav:back', 'nav:forward', 'nav:reload', 'nav:home',
  'bookmark:add', 'bookmark:remove', 'bookmark:open',
  'download:open', 'download:folder', 'home:search', 'home:open',
  'panel:visibility'
];

contextBridge.exposeInMainWorld('astrava', {
  send(channel, ...args) {
    if (allowed.includes(channel)) ipcRenderer.send(channel, ...args);
  },
  onState(callback) {
    ipcRenderer.on('browser:state', (_event, state) => callback(state));
  }
});
