// ============================================================================
// SKYBOUND — desktop shell bridge.
//
// The game needs to know and change the real window fullscreen state. The
// browser Fullscreen API cannot see it: the OS window comes up fullscreen at
// launch and F11 toggles the window, so document.fullscreenElement stays null
// and the options row would report "Off" while the player is looking at a
// fullscreen game.
// ============================================================================
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopShell', {
  isFullscreen: () => ipcRenderer.invoke('shell:fullscreen'),
  setFullscreen: (on) => ipcRenderer.invoke('shell:set-fullscreen', !!on),
  // Returns an unsubscribe function, so nothing is left listening.
  onFullscreenChange: (fn) => {
    const handler = (_event, on) => fn(!!on);
    ipcRenderer.on('shell:fullscreen-changed', handler);
    return () => ipcRenderer.removeListener('shell:fullscreen-changed', handler);
  },
});
