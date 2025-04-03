const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  scrapEntreprises: (location, category, maxPages, outputDir) => ipcRenderer.invoke('scrap-entreprises', location, category, maxPages, outputDir),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  startScraping: (location, category, maxPages, outputDir) => ipcRenderer.send('start-scraping', { location, category, maxPages, outputDir }),
  onProgressUpdate: (callback) => ipcRenderer.on('progress-update', (event, progress) => callback(progress)),
  onScrapingComplete: (callback) => ipcRenderer.on('scraping-complete', (event) => callback()),
  onScrapingError: (callback) => ipcRenderer.on('scraping-error', (event, message) => callback(message)),
  getScrapedData: (outputDir, category, location) => ipcRenderer.invoke('get-scraped-data', outputDir, category, location)
});