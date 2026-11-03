const crypto = require('crypto');

/** Contador persistente (tabela counters). Chame dentro de transação quando possível. */
function nextSeq(db, name, start) {
  const row = db.prepare('SELECT value FROM counters WHERE name = ?').get(name);
  if (!row) {
    db.prepare('INSERT INTO counters (name, value) VALUES (?, ?)').run(name, start);
    return start;
  }
  const value = row.value + 1;
  db.prepare('UPDATE counters SET value = ? WHERE name = ?').run(value, name);
  return value;
}

const pad = (n, size) => String(n).padStart(size, '0');

const deliveryCode = (db) => `RV-${nextSeq(db, 'delivery', 2049)}`;
const flightCode = (db) => `FL-${pad(nextSeq(db, 'flight', 1), 4)}`;
const incidentCode = (db) => `OC-${pad(nextSeq(db, 'incident', 1), 4)}`;

// sem I/O/0/1 para evitar confusão ao digitar o código
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Código de rastreamento no formato do front: RVX-2049-AB. */
function trackingCode(db, deliveryCodeStr) {
  const number = deliveryCodeStr.replace('RV-', '');
  const exists = db.prepare('SELECT 1 FROM deliveries WHERE tracking_code = ?');
  for (let attempt = 0; attempt < 50; attempt++) {
    const suffix =
      LETTERS[crypto.randomInt(LETTERS.length)] + LETTERS[crypto.randomInt(LETTERS.length)];
    const candidate = `RVX-${number}-${suffix}`;
    if (!exists.get(candidate)) return candidate;
  }
  return `RVX-${number}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

module.exports = { deliveryCode, flightCode, incidentCode, trackingCode };
