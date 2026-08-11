/**
 * manage.js — prosty CLI do zarządzania biletami z auto-commit + push.
 *
 * Użycie:
 *   node manage.js status          — lista wszystkich biletów
 *   node manage.js found <id>      — oznacz bilet jako znaleziony + commit + push
 *   node manage.js free <id>       — cofnij bilet do wolnego + commit + push
 *   node manage.js found-all       — oznacz wszystkie jako znalezione
 *   node manage.js free-all        — oznacz wszystkie jako wolne
 *
 * Skróty w package.json:
 *   npm run status
 *   npm run found 3
 *   npm run free 3
 *   npm run found-all
 *   npm run free-all
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const TICKETS_FILE = path.join(__dirname, 'tickets.json');

function loadTickets() {
  return JSON.parse(fs.readFileSync(TICKETS_FILE, 'utf-8'));
}

function saveTickets(tickets) {
  fs.writeFileSync(TICKETS_FILE, JSON.stringify(tickets, null, 2), 'utf-8');
}

function gitCommitPush(message) {
  try {
    execSync('git add tickets.json', { stdio: 'inherit' });
    execSync(`git commit -m "${message}"`, { stdio: 'inherit' });
    execSync('git push', { stdio: 'inherit' });
    console.log('\n✅ Zmiany wypchnięte na GitHub. Render auto-redeplojuje (~1-2 min).');
  } catch (err) {
    console.error('\n❌ Błąd git push:', err.message);
    console.error('Sprawdź czy masz połączenie z GitHub (git remote -v).');
    process.exit(1);
  }
}

function setStatus(id, isFound) {
  const tickets = loadTickets();
  const ticket = tickets.find((t) => t.id === Number(id));
  if (!ticket) {
    console.error(`❌ Bilet #${id} nie istnieje. Dostępne: ${tickets.map((t) => t.id).join(', ')}`);
    process.exit(1);
  }

  if (ticket.is_found === isFound) {
    console.log(`Bilet #${id} już ma status ${isFound ? 'znaleziony' : 'wolny'}. Nic do zmiany.`);
    return;
  }

  ticket.is_found = isFound;
  saveTickets(tickets);

  const action = isFound ? 'oznaczony jako znaleziony' : 'cofnięty do wolnego';
  console.log(`\n🎟️  Bilet #${id} ${action}.`);
  gitCommitPush(`Bilet #${id} ${isFound ? 'znaleziony' : 'wolny'} [manage.js]`);
}

function setStatusAll(isFound) {
  const tickets = loadTickets();
  tickets.forEach((t) => (t.is_found = isFound));
  saveTickets(tickets);
  console.log(`\n🎟️  Wszystkie ${tickets.length} bilety ${isFound ? 'oznaczone jako znalezione' : 'cofnięte do wolnych'}.`);
  gitCommitPush(`Wszystkie bilety ${isFound ? 'znalezione' : 'wolne'} [manage.js]`);
}

function showStatus() {
  const tickets = loadTickets();
  const found = tickets.filter((t) => t.is_found).length;
  console.log(`\n🎟️  Trzciamajka — status biletów (${found}/${tickets.length} znalezione)\n`);
  tickets.forEach((t) => {
    const status = t.is_found ? '✅ Znaleziony' : '🎯 Wolny';
    const gps = t.lat != null ? `${t.lat.toFixed(6)}, ${t.lng.toFixed(6)}` : 'brak GPS';
    console.log(`  #${String(t.id).padEnd(2)} ${status.padEnd(16)} ${gps}`);
  });
  console.log('');
}

// --- CLI ---
const [cmd, arg] = process.argv.slice(2);

switch (cmd) {
  case 'status':
    showStatus();
    break;
  case 'found':
    if (!arg) { console.error('Użycie: node manage.js found <id>'); process.exit(1); }
    setStatus(arg, true);
    break;
  case 'free':
    if (!arg) { console.error('Użycie: node manage.js free <id>'); process.exit(1); }
    setStatus(arg, false);
    break;
  case 'found-all':
    setStatusAll(true);
    break;
  case 'free-all':
    setStatusAll(false);
    break;
  default:
    console.log('Zarządzanie biletami Trzciamajka\n');
    console.log('Użycie:');
    console.log('  node manage.js status        — lista biletów');
    console.log('  node manage.js found <id>    — oznacz bilet jako znaleziony + push');
    console.log('  node manage.js free <id>     — cofnij bilet do wolnego + push');
    console.log('  node manage.js found-all     — wszystkie znalezione + push');
    console.log('  node manage.js free-all      — wszystkie wolne + push');
    console.log('\nSkróty: npm run status | npm run found 3 | npm run free 3 | npm run found-all | npm run free-all');
    process.exit(0);
}
