const { app, BrowserWindow, ipcMain, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const sqlite3 = require('sqlite3').verbose();
const XLSX = require('xlsx'); // Importer la bibliothèque xlsx

puppeteer.use(StealthPlugin());

let db;

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      enableRemoteModule: false
    }
  });

  win.loadFile('index.html');
}

app.whenReady().then(() => {
  db = new sqlite3.Database('scraping.db', (err) => {
    if (err) {
      console.error(err.message);
    }
    console.log('Connected to the scraping database.');
  });

  db.run(`CREATE TABLE IF NOT EXISTS entreprises (
    id INTEGER PRIMARY KEY,
    nom TEXT,
    adresse TEXT,
    telephone TEXT,
    siteWeb TEXT,
    urlAffichee TEXT,
    email TEXT
  )`);

  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    db.close((err) => {
      if (err) {
        console.error(err.message);
      }
      console.log('Closed the database connection.');
    });
    app.quit();
  }
});

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  });
  if (result.canceled) {
    return null;
  } else {
    return result.filePaths[0];
  }
});

ipcMain.handle('get-scraped-data', async (event, outputDir, category, location) => {
  const dateStr = new Date().toISOString().slice(0, 10);
  const filePrefix = path.join(outputDir, `${category}_${location}_${dateStr}`);
  const dataFilePath = `${filePrefix}_toutes_entreprises.json`;

  if (!fs.existsSync(dataFilePath)) {
    return [];
  }

  const rawData = fs.readFileSync(dataFilePath);
  return JSON.parse(rawData);
});

// Nouvelle fonction pour convertir JSON en Excel
function convertJsonToExcel(jsonData, outputFilePath) {
  const ws = XLSX.utils.json_to_sheet(jsonData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Entreprises');
  XLSX.writeFile(wb, outputFilePath);
}

async function scrapEntreprises(window, location, category, maxPages = 5, outputDir = '.') {
  console.log(`🔍 Recherche des entreprises "${category}" à/en "${location}"...`);

  let browser = await puppeteer.launch({
    headless: true, // Exécuter en arrière-plan
    args: ['--no-sandbox', '--window-size=1920x1080']
  });
  let page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/111.0.0.0 Safari/537.36');

  let toutesEntreprises = [];
  let totalEntreprises = 0;
  let totalPagesScrapped = 0;

  try {
    let baseUrl = `https://www.pagesjaunes.fr/annuaire/chercherlespros?quoiqui=${encodeURIComponent(category)}&ou=${encodeURIComponent(location)}`;

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      const pageUrl = pageNum > 1 ? `${baseUrl}&page=${pageNum}` : baseUrl;
      console.log(`📄 Navigation vers la Page ${pageNum}/${maxPages}`);
      console.log(`🔗 URL: ${pageUrl}`);

      await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 120000 });

      let captchaPresent = await page.evaluate(() => {
        const captchaElement = document.querySelector('.cf-captcha-container');
        return !!captchaElement;
      });

      if (captchaPresent) {
        console.log("🔑 CAPTCHA détecté. Relance du navigateur en mode visible...");
        await browser.close();
        browser = await puppeteer.launch({
          headless: false,
          args: ['--no-sandbox', '--window-size=1920x1080']
        });
        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/111.0.0.0 Safari/537.36');
        await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 120000 });

        let captchaResolved = false;
        while (!captchaResolved) {
          console.log("🔑 Résolvez le CAPTCHA manuellement dans le navigateur ouvert...");
          await new Promise(resolve => setTimeout(resolve, 180000));

          captchaResolved = await page.evaluate(() => {
            const captchaElement = document.querySelector('.cf-captcha-container');
            return !captchaElement;
          });

          if (!captchaResolved) {
            console.log("🔄 Le CAPTCHA est toujours présent. Veuillez le résoudre à nouveau.");
          }
        }
      }

      try {
        await page.waitForSelector('#didomi-notice-agree-button', { timeout: 10000 });
        console.log("🍪 Acceptation des cookies...");
        await page.click('#didomi-notice-agree-button');
        await new Promise(resolve => setTimeout(resolve, 3000));
      } catch (e) {
        console.log("Pas de popup de cookies ou déjà accepté");
      }

      const detailLinks = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.bi-denomination'))
		  .slice(0, 20) // ✅ Limite à 20 résultats par page
          .map(el => {
            let link = null;
            if (el.tagName === 'A') {
              link = el.href;
            } else {
              const parent = el.closest('a');
              if (parent) link = parent.href;
            }

            const name = el.textContent.trim();

            return { link, name };
          })
          .filter(item => item.link && item.name);
      });

      console.log(`🔗 ${detailLinks.length} liens d'entreprises trouvés sur cette page`);

      totalEntreprises += detailLinks.length;
      totalPagesScrapped++;

      for (let i = 0; i < detailLinks.length; i++) {
        const { link, name } = detailLinks[i];
        console.log(`🏢 Visite de ${name} (${i + 1}/${detailLinks.length})`);

        try {
          await page.goto(link, { waitUntil: 'networkidle2', timeout: 60000 });

          const detailsInfo = await page.evaluate(async () => {
            const cleanText = text => {
              if (!text) return '';
              return text.replace(/Contenu édité par le professionnel.*$/g, '')
                .replace(/Localisation|Y aller|En savoir plus|Ouvrir la tooltip/g, '')
                .replace(/Voir le plan/g, '')
                .replace(/\s+/g, ' ')
                .trim();
            };

            const nameElement = document.querySelector('h1');
            const name = nameElement ? cleanText(nameElement.textContent) : '';

            const addressElement = document.querySelector('.address-container') ||
              document.querySelector('.address') ||
              document.querySelector('.bi-address');
            const address = addressElement ? cleanText(addressElement.textContent) : '';

            let phone = '';
            const phoneButton = document.querySelector('a[title="Afficher le N°"]');

            if (phoneButton) {
              phoneButton.click();
              await new Promise(resolve => setTimeout(resolve, 500));
              const phoneNumberElement = document.querySelector('.coord-numero');
              if (phoneNumberElement) {
                phone = cleanText(phoneNumberElement.textContent);
              }
            } else {
              const phoneElement = document.querySelector('.coord-numero');
              if (phoneElement) {
                phone = cleanText(phoneElement.textContent);
              }
            }

            const websiteLink = document.querySelector('a[title="Site internet du professionnel nouvelle fenêtre"]');
            let siteWeb = 'Non';
            let displayUrl = '';

            if (websiteLink) {
              siteWeb = websiteLink.href;

              const valueSpan = websiteLink.querySelector('.value');
              if (valueSpan) {
                displayUrl = valueSpan.textContent.trim();
              }
            }

            let email = '';
            const emailElement = document.querySelector('a[href^="mailto:"]');
            if (emailElement) {
              email = emailElement.href.replace('mailto:', '');
            }

            return {
              nom: name,
              adresse: address,
              telephone: phone,
              siteWeb: siteWeb,
              urlAffichee: displayUrl,
              email: email
            };
          });

          toutesEntreprises.push(detailsInfo);

          const progress = Math.round(((totalPagesScrapped / maxPages) * 0.5 + (toutesEntreprises.length / totalEntreprises) * 0.5) * 100);
          window.webContents.send('progress-update', progress);

          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (detailError) {
          console.log(`⚠️ Erreur lors de la visite de ${name}: ${detailError.message}`);
        }
      }

      if (pageNum < maxPages) {
        console.log(`✅ Page ${pageNum} terminée, passage à la page suivante...`);
        console.log(`⏭️ Navigation vers la page ${pageNum + 1}/${maxPages}`);
      } else {
        console.log("🏁 Nombre maximum de pages atteint");
        break;
      }
    }

    if (toutesEntreprises.length === 0) {
      console.log("❌ Aucune entreprise trouvée.");
      await browser.close();
      window.webContents.send('scraping-error', "Aucune entreprise trouvée.");
      return [];
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    const filePrefix = path.join(outputDir, `${category}_${location}_${dateStr}`);

    fs.writeFileSync(
      `${filePrefix}_toutes_entreprises.json`,
      JSON.stringify(toutesEntreprises, null, 2)
    );

    const entreprisesSansSite = toutesEntreprises.filter(e => e.siteWeb === 'Non');
    let txtContent = "ENTREPRISES SANS SITE WEB:\n\n";

    entreprisesSansSite.forEach((e, index) => {
      txtContent += `#${index + 1} - ${e.nom}\n`;
      if (e.adresse) txtContent += `Adresse: ${e.adresse}\n`;
      if (e.telephone) txtContent += `Téléphone: ${e.telephone}\n`;
      txtContent += `-----------------------------------\n\n`;
    });

    fs.writeFileSync(`${filePrefix}_entreprises_sans_site.txt`, txtContent);

    let allTxtContent = "TOUTES LES ENTREPRISES:\n\n";

    toutesEntreprises.forEach((e, index) => {
      allTxtContent += `#${index + 1} - ${e.nom}\n`;
      if (e.adresse) allTxtContent += `Adresse: ${e.adresse}\n`;
      if (e.telephone) allTxtContent += `Téléphone: ${e.telephone}\n`;

      if (e.siteWeb !== 'Non') {
        allTxtContent += `Site web: ${e.urlAffichee || e.siteWeb}\n`;
      }

      if (e.email) {
        allTxtContent += `Email: ${e.email}\n`;
      }

      allTxtContent += `-----------------------------------\n\n`;
    });

    fs.writeFileSync(`${filePrefix}_liste_complete.txt`, allTxtContent);

    // Convertir le fichier JSON en fichier Excel
    const excelFilePath = `${filePrefix}_toutes_entreprises.xlsx`;
    convertJsonToExcel(toutesEntreprises, excelFilePath);

    console.log(`\n📊 RÉSULTATS:`);
    console.log(`📋 Total des entreprises trouvées: ${toutesEntreprises.length}`);
    console.log(`🔍 Entreprises sans site web: ${entreprisesSansSite.length}`);
    console.log(`🌐 Entreprises avec site web: ${toutesEntreprises.length - entreprisesSansSite.length}`);

    console.log(`\n📁 Fichiers créés:`);
    console.log(`   1. ${filePrefix}_toutes_entreprises.json`);
    console.log(`   2. ${filePrefix}_entreprises_sans_site.txt`);
    console.log(`   3. ${filePrefix}_liste_complete.txt`);
    console.log(`   4. ${excelFilePath}`);

    await browser.close();
    window.webContents.send('scraping-complete');
    return toutesEntreprises;
  } catch (error) {
    console.log(`❌ Erreur: ${error.message}`);
    await browser.close();
    window.webContents.send('scraping-error', error.message);
  }

  return [];
}

ipcMain.on('start-scraping', async (event, { location, category, maxPages, outputDir }) => {
  const window = BrowserWindow.getFocusedWindow();
  await scrapEntreprises(window, location, category, maxPages, outputDir);
});