/**
 * dashboard.js — lokalny panel organizatora akcji Trzciamajka.
 *
 * Uruchomienie:  npm run dashboard
 * URL:           http://localhost:3001
 *
 * Panel służy do monitorowania i zarządzania biletami w czasie akcji:
 * - Podgląd wszystkich biletów ze zdjęciami, statusem, GPS
 * - Toggle znaleziony/wolny (z auto-commitem do GitHub)
 * - Reset wszystkich biletów
 * - Status synchronizacji z GitHub
 * - Link do produkcji (Render)
 *
 * Panel działa lokalnie na Twoim komputerze i nie jest deployowany na Render.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const express = require('express');
const session = require('express-session');
const crypto = require('crypto');

const { loadTickets, saveTickets } = require('./exif-reader');
const githubSync = require('./github-sync');

const app = express();
const PORT = 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const PRODUCTION_URL = process.env.PRODUCTION_URL || 'https://trzciamajka.onrender.com';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/zdjecia', express.static(path.join(__dirname, 'zdjecia')));
app.use(
  session({
    name: 'trzciamajka-dashboard.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 },
  })
);

function requireAuth(req, res, next) {
  if (req.session && req.session.isAuth) return next();
  res.redirect('/login');
}

// --- Logowanie ---

app.get('/login', (req, res) => {
  res.render('dashboard-login', { error: null });
});

app.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (password && String(password) === ADMIN_PASSWORD) {
    req.session.isAuth = true;
    return res.redirect('/');
  }
  res.render('dashboard-login', { error: 'Nieprawidłowe hasło' });
});

app.post('/logout', (req, res) => {
  req.session.isAuth = false;
  delete req.session.isAuth;
  res.redirect('/login');
});

// --- Dashboard ---

app.get('/', requireAuth, (req, res) => {
  const tickets = loadTickets() || [];
  const found = tickets.filter((t) => t.is_found).length;
  const free = tickets.length - found;

  // Ostatni commit
  let lastCommit = '';
  try {
    lastCommit = execSync('git log -1 --format="%h %s (%cr)"', { encoding: 'utf-8' }).trim();
  } catch {}

  res.render('dashboard', {
    tickets,
    found,
    free,
    total: tickets.length,
    lastCommit,
    productionUrl: PRODUCTION_URL,
    githubEnabled: githubSync.isEnabled(),
  });
});

// --- API dashboardu ---

app.post('/api/toggle/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const tickets = loadTickets() || [];
  const ticket = tickets.find((t) => t.id === id);
  if (!ticket) return res.json({ success: false, message: 'Bilet nie istnieje' });

  ticket.is_found = !ticket.is_found;
  saveTickets(tickets);

  // Commit przez GitHub API
  githubSync
    .enqueueCommit(`Dashboard: bilet #${id} ${ticket.is_found ? 'znaleziony' : 'wolny'}`)
    .then(() => res.json({ success: true, is_found: ticket.is_found, synced: true }))
    .catch((err) =>
      res.json({ success: true, is_found: ticket.is_found, synced: false, error: err.message })
    );
});

app.post('/api/free-all', requireAuth, (req, res) => {
  const tickets = loadTickets() || [];
  tickets.forEach((t) => (t.is_found = false));
  saveTickets(tickets);

  githubSync
    .enqueueCommit('Dashboard: reset wszystkich biletów na wolne')
    .then(() => res.json({ success: true, synced: true }))
    .catch((err) => res.json({ success: true, synced: false, error: err.message }));
});

app.post('/api/found-all', requireAuth, (req, res) => {
  const tickets = loadTickets() || [];
  tickets.forEach((t) => (t.is_found = true));
  saveTickets(tickets);

  githubSync
    .enqueueCommit('Dashboard: wszystkie bilety znalezione')
    .then(() => res.json({ success: true, synced: true }))
    .catch((err) => res.json({ success: true, synced: false, error: err.message }));
});

// --- Start ---

app.listen(PORT, () => {
  console.log(`\n🎟️  Dashboard Trzciamajka: http://localhost:${PORT}`);
  console.log(`   Produkcja: ${PRODUCTION_URL}`);
  console.log(`   GitHub sync: ${githubSync.isEnabled() ? 'włączony' : 'wyłączony (brak GITHUB_TOKEN)'}`);
  console.log(`   Hasło: ${ADMIN_PASSWORD}\n`);
});
