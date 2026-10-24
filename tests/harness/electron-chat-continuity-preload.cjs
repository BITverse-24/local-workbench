const { contextBridge, ipcRenderer } = require('electron');
const methods = ['getOnboardingStatus','getChatHistory','getSetting','setSetting','getHealth','getExecutionCapabilities','getCurrentWorkspace','getMessages','getRunSnapshot','getRunHistory','createChat','sendMessage','registerAttachment','startRun','resumeRun','createMessageAttempt','renameChat','archiveChat','kbListDocs','kbStats','getVerificationReport','notifyResponse'];
const workbench = Object.fromEntries(methods.map(method => [method, (...args) => ipcRenderer.invoke('continuity:call', method, args)]));
for (const name of ['Run','Chat','Workspace']) workbench[`on${name}Event`] = listener => {
  const handler = (_event, data) => listener(data);
  ipcRenderer.on(`continuity:${name}`, handler);
  return () => ipcRenderer.removeListener(`continuity:${name}`, handler);
};
contextBridge.exposeInMainWorld('workbench', workbench);
contextBridge.exposeInMainWorld('continuityFixture', { fail: (method, value) => ipcRenderer.invoke('continuity:fail', method, value), state: () => ipcRenderer.invoke('continuity:state') });
