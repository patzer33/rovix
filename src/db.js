const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('MERCHANT','OPERATOR','CONSUMER','AUTHORITIES')),
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bases (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  lat        REAL NOT NULL,
  lng        REAL NOT NULL,
  capacity   INTEGER NOT NULL DEFAULT 3,
  status     TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drones (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL UNIQUE,
  model          TEXT,
  status         TEXT NOT NULL DEFAULT 'READY' CHECK (status IN ('READY','DELIVERING','RETURNING','CHARGING')),
  battery        REAL NOT NULL DEFAULT 100,
  base_id        INTEGER REFERENCES bases(id),          -- base onde está estacionado (NULL em voo)
  target_base_id INTEGER REFERENCES bases(id),          -- base de destino enquanto RETURNING
  flight_id      INTEGER,                               -- voo em andamento (NULL se estacionado)
  lat            REAL NOT NULL,
  lng            REAL NOT NULL,
  speed_kmh      REAL NOT NULL DEFAULT 50,
  speed_factor   REAL NOT NULL DEFAULT 1,               -- 0.5 = clima ruim reduz a velocidade
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL UNIQUE,                  -- RV-2049
  tracking_code  TEXT NOT NULL UNIQUE,                  -- RVX-2049-AB
  merchant_id    INTEGER NOT NULL REFERENCES users(id),
  recipient_name TEXT NOT NULL,
  address        TEXT NOT NULL,
  neighborhood   TEXT,
  dest_lat       REAL NOT NULL,
  dest_lng       REAL NOT NULL,
  priority       TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('NORMAL','HIGH')),
  status         TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PREPARING','IN_TRANSIT','DELIVERED','CANCELLED')),
  drone_id       INTEGER REFERENCES drones(id),
  origin_base_id INTEGER REFERENCES bases(id),
  return_base_id INTEGER REFERENCES bases(id),
  ready_at       TEXT,                                  -- quando o drone decola sozinho (modo automático)
  planned_eta_at TEXT,                                  -- previsão feita na decolagem (base p/ "atrasada")
  cancel_reason  TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  delivered_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_deliveries_status   ON deliveries(status);
CREATE INDEX IF NOT EXISTS idx_deliveries_merchant ON deliveries(merchant_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_drone    ON deliveries(drone_id);

CREATE TABLE IF NOT EXISTS routes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id      INTEGER NOT NULL REFERENCES deliveries(id),
  origin_base_id   INTEGER NOT NULL REFERENCES bases(id),
  return_base_id   INTEGER REFERENCES bases(id),
  status           TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','IN_PROGRESS','COMPLETED','CANCELLED')),
  outbound_km      REAL NOT NULL,
  return_km        REAL NOT NULL,
  estimated_minutes REAL NOT NULL,
  created_at       TEXT NOT NULL,
  started_at       TEXT,
  completed_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_routes_delivery ON routes(delivery_id);

CREATE TABLE IF NOT EXISTS flights (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL UNIQUE,                  -- FL-0001
  drone_id       INTEGER NOT NULL REFERENCES drones(id),
  delivery_id    INTEGER REFERENCES deliveries(id),
  route_id       INTEGER REFERENCES routes(id),
  origin_base_id INTEGER REFERENCES bases(id),
  return_base_id INTEGER REFERENCES bases(id),
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  distance_km    REAL NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS','COMPLETED','INTERRUPTED'))
);
CREATE INDEX IF NOT EXISTS idx_flights_delivery ON flights(delivery_id);

CREATE TABLE IF NOT EXISTS tracking_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
  type        TEXT NOT NULL,
  message     TEXT NOT NULL,
  lat         REAL,
  lng         REAL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_delivery ON tracking_events(delivery_id);

CREATE TABLE IF NOT EXISTS incidents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,                     -- OC-0001
  category    TEXT NOT NULL CHECK (category IN
              ('TECHNICAL_FAILURE','BATTERY_PROBLEM','ADVERSE_WEATHER','ROUTE_DEVIATION','DELIVERY_PROBLEM','AIRSPACE_RESTRICTION')),
  description TEXT NOT NULL,
  priority    TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('NORMAL','HIGH')),
  status      TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','UNDER_REVIEW','RESOLVED')),
  source      TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('AUTO','MANUAL')),
  delivery_id INTEGER REFERENCES deliveries(id),
  drone_id    INTEGER REFERENCES drones(id),
  route_id    INTEGER REFERENCES routes(id),
  base_id     INTEGER REFERENCES bases(id),
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
`;

function openDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  if (dbPath !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };
