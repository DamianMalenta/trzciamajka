/**
 * github-sync.js — synchronizuje tickets.json z GitHub przez REST API.
 *
 * Kiedy uczestnik odbierze bilet albo admin zmieni status, ten moduł
 * commituje zaktualizowany tickets.json do repo na GitHub. Render wykrywa
 * push i auto-redeplojuje — zmiana staje się trwała.
 *
 * Wymaga zmiennej środowiskowej GITHUB_TOKEN (Personal Access Token
 * z uprawnieniem Contents: Read and write dla repo trzciamajka).
 *
 * Jeśli GITHUB_TOKEN nie jest ustawiony, moduł jest nieaktywny (no-op)
 * — aplikacja działa dalej, ale zmiany nie są synchronizowane z GitHub.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const TICKETS_FILE = path.join(__dirname, 'tickets.json');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'DamianMalenta';
const GITHUB_REPO = process.env.GITHUB_REPO || 'trzciamajka';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const FILE_PATH = 'tickets.json';

let isEnabled = !!GITHUB_TOKEN;
let commitQueue = [];
let isProcessing = false;

if (!isEnabled) {
  console.log('[github-sync] Wyłączony — brak GITHUB_TOKEN. Zmiany nie są synchronizowane z GitHub.');
} else {
  console.log(`[github-sync] Włączony — repo: ${GITHUB_OWNER}/${GITHUB_REPO}`);
}

/** Pobiera aktualny SHA pliku z GitHub (potrzebne do PUT). */
function getFileSha() {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}?ref=${GITHUB_BRANCH}`,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        'User-Agent': 'trzciamajka-app',
        Accept: 'application/vnd.github+json',
      },
    };
    const req = https.request(opts, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(buf).sha);
          } catch (e) {
            reject(new Error('Nie udało się sparsować odpowiedzi GitHub'));
          }
        } else if (res.statusCode === 404) {
          resolve(null); // plik nie istnieje na GitHub — pierwszy commit
        } else {
          reject(new Error(`GitHub GET ${res.statusCode}: ${buf.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Commituje plik do GitHub. */
function commitFile(content, message, sha) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      message,
      content: Buffer.from(content).toString('base64'),
      sha: sha || undefined,
      branch: GITHUB_BRANCH,
    });

    const opts = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}`,
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        'User-Agent': 'trzciamajka-app',
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(opts, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          resolve(JSON.parse(buf));
        } else {
          reject(new Error(`GitHub PUT ${res.statusCode}: ${buf.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Kolejkuje commit — przetwarza jeden po drugim, żeby uniknąć konfliktów SHA. */
function enqueueCommit(message) {
  if (!isEnabled) return Promise.resolve({ skipped: true });

  return new Promise((resolve, reject) => {
    commitQueue.push({ message, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (isProcessing || commitQueue.length === 0) return;
  isProcessing = true;

  while (commitQueue.length > 0) {
    const { message, resolve, reject } = commitQueue.shift();
    try {
      const content = fs.readFileSync(TICKETS_FILE, 'utf-8');
      const sha = await getFileSha();
      const result = await commitFile(content, message, sha);
      console.log(`[github-sync] ✅ Commit: "${message}"`);
      resolve(result);
    } catch (err) {
      console.error(`[github-sync] ❌ Błąd commitu: ${err.message}`);
      reject(err);
      // Przerwij kolejkę — następny commit spróbuje od nowa
      break;
    }
  }

  isProcessing = false;
}

module.exports = { enqueueCommit, isEnabled: () => isEnabled };
