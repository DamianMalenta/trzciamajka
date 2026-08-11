/**
 * server.js — aplikacja Express dla akcji promocyjnej "Trzciamajka".
 *
 * Widoki (EJS):
 *   GET  /                  — strona główna (mapa Leaflet + wylosowany bilet / gratulacje)
 *   GET  /admin             — panel admina (lub formularz logowania)
 *
 * API:
 *   POST /api/found         — uczestnik potwierdza znalezienie swojego biletu
 *   POST /admin/login       — logowanie hasłem z .env (formularz)
 *   GET  /admin/logout      — wylogowanie
 *   POST /admin/toggle/:id  — przełącza status is_found
 *   POST /admin/gps/:id     — zapisuje współrzędne lat/lng
 *   POST /admin/hint/:id    — zapisuje tekst wskazówki
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const express = require('express');
const session = require('express-session');
const exifr = require('exifr');

const { loadTickets, saveTickets, generateTickets } = require('./exif-reader');
const githubSync = require('./github-sync');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const TICKETS_FILE = path.join(__dirname, 'tickets.json');
const PHOTOS_DIR = path.join(__dirname, 'zdjecia');

// --- Konfiguracja middleware -------------------------------------------------

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    name: 'trzciamajka.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 dni
    },
  })
);

// Serwowanie zdjęć pod /zdjecia/... (zgodnie z photo_path w tickets.json)
app.use('/zdjecia', express.static(PHOTOS_DIR));

// Jawne zezwolenie na geolokalizację — niektóre przeglądarki wymagają tego
// nagłówka, żeby w ogóle pokazać prompt o lokalizację na zewnętrznym hostingu.
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'geolocation=(self)');
  // Pozwól osadzać własną stronę w iframe'ach tylko z tego samego originu
  // (zapobiega problemom z geolokalizacją w kontekście iframe).
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// --- Pomocnicze --------------------------------------------------------------

/** Bilety dostępne do losowania: nieodnalezione i z poprawnymi współrzędnymi. */
function getDrawableTickets(tickets) {
  return tickets.filter(
    (t) =>
      !t.is_found &&
      typeof t.lat === 'number' && isFinite(t.lat) && t.lat != null &&
      typeof t.lng === 'number' && isFinite(t.lng) && t.lng != null
  );
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect('/admin');
}

/** Odległość między dwoma punktami GPS w metrach (wzór Haversine). */
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000; // promień Ziemi w metrach
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// --- Strona główna -----------------------------------------------------------
//
// Stany strony głównej (view = co pokazać w index.ejs):
//   'ticket'        — uczestnik ma bilet, nie znalazł jeszcze → mapa + przycisk „Znalazłem”
//   'congrats'      — uczestnik potwierdził znalezienie → ekran gratulacji
//   'taken'         — bilet uczestnika został w międzyczasie znaleziony przez kogoś innego
//   'allFound'      — wszystkie bilety znalezione (dla nowych uczestników)
//   'noCoordinates' — brak współrzędnych GPS (konfiguracja niegotowa)

app.get('/', (req, res) => {
  const tickets = loadTickets() || [];
  const drawable = getDrawableTickets(tickets);

  const foundCount = tickets.filter((t) => t.is_found).length;
  const totalTickets = tickets.length;
  const allFound = totalTickets > 0 && drawable.length === 0 && foundCount === totalTickets;

  let view = 'ticket';
  let ticket = null;

  if (req.session.assignedTicketId != null) {
    const assigned = tickets.find((t) => t.id === req.session.assignedTicketId);

    if (assigned && assigned.lat != null && assigned.lng != null) {
      ticket = assigned;

      if (req.session.foundConfirmed) {
        // Uczestnik potwierdził znalezienie — ekran gratulacji.
        view = 'congrats';
      } else if (assigned.is_found) {
        // Bilet został oznaczony jako znaleziony przez kogoś innego (admin lub inny uczestnik).
        view = 'taken';
      } else {
        // Bilet nadal do znalezienia — pokaż mapę + przycisk.
        view = 'ticket';
      }
    } else {
      // Przypisany bilet nie istnieje lub stracił współrzędne — wyczyść i wylosuj nowy.
      delete req.session.assignedTicketId;
      delete req.session.foundConfirmed;
    }
  }

  // Pierwsza wizyta (brak przypisanego biletu) — wylosuj jeden i zapamiętaj.
  if (!ticket && view === 'ticket' && drawable.length > 0) {
    ticket = drawable[Math.floor(Math.random() * drawable.length)];
    req.session.assignedTicketId = ticket.id;
    view = 'ticket';
  }

  // Brak przypisanego biletu i brak drawable — zdecyduj który komunikat pokazać.
  if (!ticket && drawable.length === 0) {
    view = allFound ? 'allFound' : 'noCoordinates';
  }

  res.render('index', {
    view,
    ticket,
    allFound,
    foundCount,
    totalTickets,
    noCoordinates: view === 'noCoordinates',
    congrats: view === 'congrats',
    taken: view === 'taken',
  });
});

/** Uczestnik potwierdza znalezienie swojego biletu.
 *
 *  Obsługiwane metody weryfikacji (wystarczy JEDNA):
 *    1. GPS  — { lat, lng } w promieniu GEOFENCE_RADIUS od biletu (główna metoda)
 *    2. KOD  — { code } zgodny z ticket.code (alternatywa gdy GPS niedostępny,
 *              np. Brave z włączonymi Shields)
 */
app.post('/api/found', (req, res) => {
  const tickets = loadTickets() || [];
  const id = req.session.assignedTicketId;

  if (id == null) {
    return res.json({ success: false, message: 'Nie masz przypisanego biletu.' });
  }

  const ticket = tickets.find((t) => t.id === id);
  if (!ticket) {
    return res.json({ success: false, message: 'Bilet nie istnieje.' });
  }

  if (ticket.is_found) {
    return res.json({ success: false, message: 'Ten bilet został już odnaleziony przez kogoś innego.' });
  }

  const { lat: userLat, lng: userLng, code } = req.body || {};

  // --- Metoda 2: kod z biletu (alternatywa gdy GPS nie działa) ---
  if (typeof code === 'string' && code.trim()) {
    const expected = String(ticket.code || '').trim().toUpperCase();
    const provided = code.trim().toUpperCase();

    if (!expected) {
      return res.json({ success: false, message: 'Ten bilet nie ma ustawionego kodu. Skontaktuj się z organizatorem.' });
    }
    if (provided !== expected) {
      return res.json({ success: false, message: 'Nieprawidłowy kod. Sprawdź kod na bilecie i spróbuj ponownie.' });
    }
    // Kod OK — oznacz bilet jako znaleziony.
    ticket.is_found = true;
    req.session.foundConfirmed = true;
    saveTickets(tickets);
    githubSync.enqueueCommit(`Bilet #${ticket.id} odebrany kodem [auto]`).catch(() => {});
    return res.json({ success: true, method: 'code' });
  }

  // --- Metoda 1: GPS (główna) ---
  if (typeof userLat !== 'number' || typeof userLng !== 'number' ||
      !isFinite(userLat) || !isFinite(userLng)) {
    return res.json({
      success: false,
      message: 'Brak lokalizacji. Zezwól na dostęp do GPS lub wpisz kod z biletu.',
    });
  }

  const distance = haversine(userLat, userLng, ticket.lat, ticket.lng);
  const GEOFENCE_RADIUS = 30; // metry

  if (distance > GEOFENCE_RADIUS) {
    return res.json({
      success: false,
      message: `Jesteś ${Math.round(distance)} m od biletu. Podejdź bliżej (max ${GEOFENCE_RADIUS} m) lub wpisz kod z biletu.`,
      distance: Math.round(distance),
    });
  }

  // Odległość OK — oznacz bilet jako znaleziony.
  ticket.is_found = true;
  req.session.foundConfirmed = true;
  saveTickets(tickets);
  githubSync.enqueueCommit(`Bilet #${ticket.id} odebrany przez uczestnika [auto]`).catch(() => {});
  res.json({ success: true, method: 'gps', distance: Math.round(distance) });
});

// --- Panel admina ------------------------------------------------------------

app.get('/admin', (req, res) => {
  if (!req.session || !req.session.isAdmin) {
    return res.render('admin-login', { error: null });
  }
  const tickets = loadTickets() || [];
  res.render('admin', { tickets });
});

app.post('/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password && String(password) === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.redirect('/admin');
  }
  res.render('admin-login', { error: 'Nieprawidłowe hasło' });
});

app.get('/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  delete req.session.isAdmin;
  res.redirect('/admin');
});

app.post('/admin/toggle/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const tickets = loadTickets() || [];
  const ticket = tickets.find((t) => t.id === id);
  if (!ticket) return res.json({ success: false, message: 'Bilet nie istnieje' });

  ticket.is_found = !ticket.is_found;
  saveTickets(tickets);
  githubSync.enqueueCommit(`Admin: bilet #${id} ${ticket.is_found ? 'znaleziony' : 'wolny'}`).catch(() => {});
  res.json({ success: true, is_found: ticket.is_found });
});

app.post('/admin/gps/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const tickets = loadTickets() || [];
  const ticket = tickets.find((t) => t.id === id);
  if (!ticket) return res.json({ success: false, message: 'Bilet nie istnieje' });

  const { lat, lng } = req.body || {};
  const latNum = parseFloat(lat);
  const lngNum = parseFloat(lng);
  if (isNaN(latNum) || isNaN(lngNum)) {
    return res.json({ success: false, message: 'Nieprawidłowe współrzędne' });
  }

  ticket.lat = latNum;
  ticket.lng = lngNum;
  saveTickets(tickets);
  githubSync.enqueueCommit(`Admin: GPS biletu #${id}`).catch(() => {});
  res.json({ success: true, lat: ticket.lat, lng: ticket.lng });
});

app.post('/admin/hint/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const tickets = loadTickets() || [];
  const ticket = tickets.find((t) => t.id === id);
  if (!ticket) return res.json({ success: false, message: 'Bilet nie istnieje' });

  const { hint_text } = req.body || {};
  if (typeof hint_text !== 'string') {
    return res.json({ success: false, message: 'Brak tekstu wskazówki' });
  }

  ticket.hint_text = hint_text;
  saveTickets(tickets);
  githubSync.enqueueCommit(`Admin: wskazówka biletu #${id}`).catch(() => {});
  res.json({ success: true });
});

app.post('/admin/code/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const tickets = loadTickets() || [];
  const ticket = tickets.find((t) => t.id === id);
  if (!ticket) return res.json({ success: false, message: 'Bilet nie istnieje' });

  const { code } = req.body || {};
  if (typeof code !== 'string' || !code.trim()) {
    return res.json({ success: false, message: 'Kod nie może być pusty' });
  }

  // Normalizuj do wielkich liter i sprawdź unikalność.
  const normalized = code.trim().toUpperCase();
  const conflict = tickets.find((t) => t.id !== id && String(t.code || '').toUpperCase() === normalized);
  if (conflict) {
    return res.json({ success: false, message: `Kod „${normalized}” jest już użyty przez bilet #${conflict.id}` });
  }

  ticket.code = normalized;
  saveTickets(tickets);
  githubSync.enqueueCommit(`Admin: kod biletu #${id}`).catch(() => {});
  res.json({ success: true, code: ticket.code });
});

// --- Start -------------------------------------------------------------------

async function start() {
  // Jeśli brak tickets.json — wygeneruj ze zdjęć w ./zdjecia.
  if (!fs.existsSync(TICKETS_FILE)) {
    console.log('Brak tickets.json — generuję z folderu ./zdjecia ...');
    await generateTickets();
  }

  const tickets = loadTickets() || [];
  const drawable = getDrawableTickets(tickets).length;
  const found = tickets.filter((t) => t.is_found).length;
  console.log(`Trzciamajka działa na http://localhost:${PORT}`);
  console.log(`Bilety: ${tickets.length}  |  Znalezione: ${found}  |  Dostępne do losowania: ${drawable}`);
  if (drawable === 0 && tickets.length > 0) {
    console.log('Uwaga: żaden bilet nie ma współrzędnych GPS. Dodaj zdjęcia z GPS lub ustaw współrzędne w panelu admina.');
  }

  app.listen(PORT, () => {});
}

start().catch((err) => {
  console.error('Błąd uruchamiania:', err);
  process.exit(1);
});
