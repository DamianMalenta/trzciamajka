const fs = require('fs');
const path = require('path');
const exifr = require('exifr');

const ZDJECIA_DIR = path.join(__dirname, 'zdjecia');
const TICKETS_FILE = path.join(__dirname, 'tickets.json');

function convertDMSToDD(dms, ref) {
  if (!dms) return null;
  const { degrees, minutes, seconds } = dms;
  let dd = degrees + minutes / 60 + seconds / 3600;
  if (ref === 'S' || ref === 'W') dd = -dd;
  return dd;
}

async function readExifFromImage(filePath) {
  try {
    // Sposób 1: exifr.gps() — zwraca gotowe decimal
    const gps = await exifr.gps(filePath);
    if (gps && !isNaN(gps.latitude) && !isNaN(gps.longitude)) {
      return { lat: gps.latitude, lng: gps.longitude };
    }

    // Sposób 2: pełny parse i manualna konwersja DMS
    const exif = await exifr.parse(filePath, { gps: true, tiff: true });
    if (exif) {
      // Sprawdź czy są już gotowe decimal
      if (exif.latitude != null && exif.longitude != null &&
          !isNaN(exif.latitude) && !isNaN(exif.longitude)) {
        return { lat: exif.latitude, lng: exif.longitude };
      }
      // Manualna konwersja z DMS (Google Pixel format)
      if (exif.GPSLatitude != null && exif.GPSLongitude != null) {
        const lat = convertDMSToDD(exif.GPSLatitude, exif.GPSLatitudeRef);
        const lng = convertDMSToDD(exif.GPSLongitude, exif.GPSLongitudeRef);
        if (lat != null && lng != null && !isNaN(lat) && !isNaN(lng)) {
          return { lat, lng };
        }
      }
    }

    // Sposób 3: parse z mergeGps — łączy GPS z TIFF
    const full = await exifr.parse(filePath, true);
    if (full) {
      if (full.latitude != null && full.longitude != null &&
          !isNaN(full.latitude) && !isNaN(full.longitude)) {
        return { lat: full.latitude, lng: full.longitude };
      }
      if (full.GPSLatitude != null && full.GPSLongitude != null) {
        const lat = convertDMSToDD(full.GPSLatitude, full.GPSLatitudeRef);
        const lng = convertDMSToDD(full.GPSLongitude, full.GPSLongitudeRef);
        if (lat != null && lng != null && !isNaN(lat) && !isNaN(lng)) {
          return { lat, lng };
        }
      }
    }

    return null;
  } catch (err) {
    console.warn(`[EXIF] Nie udało się odczytać EXIF z ${path.basename(filePath)}: ${err.message}`);
    return null;
  }
}

async function generateTickets() {
  const files = fs.readdirSync(ZDJECIA_DIR).filter(f => /\.(jpg|jpeg|png|heic|heif)$/i.test(f));
  const tickets = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fullPath = path.join(ZDJECIA_DIR, file);
    console.log(`[EXIF] Odczytywanie ${file}...`);
    const coords = await readExifFromImage(fullPath);

    const ticket = {
      id: i + 1,
      photo_path: `/zdjecia/${file}`,
      photo_file: file,
      lat: coords ? coords.lat : null,
      lng: coords ? coords.lng : null,
      hint_text: `Bilet #${i + 1} — znajdź miejsce ze zdjęcia!`,
      is_found: false
    };

    if (coords) {
      console.log(`[EXIF] ${file}: lat=${coords.lat}, lng=${coords.lng}`);
    } else {
      console.warn(`[EXIF] ${file}: brak danych GPS w EXIF — ustawiono null`);
    }

    tickets.push(ticket);
  }

  fs.writeFileSync(TICKETS_FILE, JSON.stringify(tickets, null, 2));
  console.log(`[EXIF] Zapisano ${tickets.length} biletów do tickets.json`);
  return tickets;
}

function loadTickets() {
  if (!fs.existsSync(TICKETS_FILE)) {
    return null;
  }
  const raw = fs.readFileSync(TICKETS_FILE, 'utf-8');
  return JSON.parse(raw);
}

function saveTickets(tickets) {
  fs.writeFileSync(TICKETS_FILE, JSON.stringify(tickets, null, 2));
}

module.exports = { generateTickets, loadTickets, saveTickets };

// CLI: uruchom bezpośrednio, aby (re)generować tickets.json ze zdjęć.
if (require.main === module) {
  generateTickets().catch((err) => {
    console.error('[EXIF] Błąd:', err);
    process.exit(1);
  });
}
