/**
 * Dados iniciais: usuários de cada perfil, bases, drones e (opcional) um histórico de
 * entregas/voos/ocorrências para o painel das autoridades não começar vazio.
 *
 *   npm run seed   -> apaga o banco e recria tudo
 */
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { haversineKm, pseudoGeocode } = require('./lib/geo');
const { deliveryCode, trackingCode, flightCode, incidentCode } = require('./lib/codes');

const DEMO_PASSWORD = 'rovix123';

const USERS = [
  { name: 'Loja Aurora', email: 'merchant@rovix.demo', role: 'MERCHANT' },
  { name: 'Mercado Parque das Águas', email: 'merchant2@rovix.demo', role: 'MERCHANT' },
  { name: 'Operador Central', email: 'operator@rovix.demo', role: 'OPERATOR' },
  { name: 'Autoridade Municipal', email: 'authority@rovix.demo', role: 'AUTHORITIES' },
  { name: 'Consumidor Demo', email: 'consumer@rovix.demo', role: 'CONSUMER' }
];

// Coordenadas em torno do centro (Curitiba, simulada): ~3-4 km entre as bases.
const BASES = [
  { name: 'Base Central', lat: -25.4284, lng: -49.2733, capacity: 3 },
  { name: 'Base Norte', lat: -25.3935, lng: -49.2655, capacity: 2 },
  { name: 'Base Leste', lat: -25.4345, lng: -49.2285, capacity: 3 }
];

const DRONES = [
  { code: 'DR-01', base: 0, battery: 100, status: 'READY' },
  { code: 'DR-02', base: 0, battery: 96, status: 'READY' },
  { code: 'DR-03', base: 0, battery: 41, status: 'CHARGING' },
  { code: 'DR-04', base: 1, battery: 100, status: 'READY' },
  { code: 'DR-05', base: 1, battery: 74, status: 'READY' },
  { code: 'DR-06', base: 2, battery: 88, status: 'READY' }
];

// Nomes/endereços usados no front (mesmo "mundo" da demonstração).
const SAMPLE = [
  ['Marina Costa', 'Rua das Palmeiras, 142', 'Vila Aurora'],
  ['Lucas Ferreira', 'Av. das Acácias, 580', 'Jardim Central'],
  ['Beatriz Almeida', 'Rua do Ipê, 36', 'Parque Horizonte'],
  ['Rafael Nunes', 'Alameda dos Jasmins, 911', 'Centro'],
  ['Camila Ribeiro', 'Travessa do Sol, 75', 'Jardim das Flores'],
  ['Helena Martins', 'Rua dos Pinheiros, 218', 'Jardim Aurora'],
  ['André Lima', 'Av. Horizonte, 640', 'Vila Serena'],
  ['Sofia Mendes', 'Rua do Cedro, 51', 'Parque das Águas'],
  ['Thiago Barros', 'Alameda Verde, 903', 'Centro'],
  ['Isabela Rocha', 'Travessa do Lago, 74', 'Jardim Novo']
];

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedIfEmpty(ctx) {
  const { db, cfg } = ctx;
  if (db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0) return false;

  const now = new Date();
  const iso = (d) => d.toISOString();

  db.transaction(() => {
    const hash = bcrypt.hashSync(DEMO_PASSWORD, 8);
    const insUser = db.prepare('INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const u of USERS) insUser.run(u.name, u.email, hash, u.role, iso(now));

    const baseIds = BASES.map(
      (b) =>
        db
          .prepare(`INSERT INTO bases (name, lat, lng, capacity, status, created_at) VALUES (?, ?, ?, ?, 'ACTIVE', ?)`)
          .run(b.name, b.lat, b.lng, b.capacity, iso(now)).lastInsertRowid
    );

    const droneIds = DRONES.map((d) => {
      const b = BASES[d.base];
      return db
        .prepare(
          `INSERT INTO drones (code, model, status, battery, base_id, lat, lng, speed_kmh, created_at)
           VALUES (?, 'ROVIX-S1', ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(d.code, d.status, d.battery, baseIds[d.base], b.lat, b.lng, cfg.drone.defaultSpeedKmh, iso(now)).lastInsertRowid;
    });

    if (!cfg.seedDemoHistory) return;

    // ---------------- histórico fictício (últimos dias) ----------------
    const rnd = mulberry32(2026);
    const merchantIds = db.prepare(`SELECT id FROM users WHERE role = 'MERCHANT' ORDER BY id`).all().map((r) => r.id);
    const insDelivery = db.prepare(
      `INSERT INTO deliveries (code, tracking_code, merchant_id, recipient_name, address, neighborhood, dest_lat, dest_lng,
                               priority, status, drone_id, origin_base_id, return_base_id, cancel_reason, created_at, updated_at, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insRoute = db.prepare(
      `INSERT INTO routes (delivery_id, origin_base_id, return_base_id, status, outbound_km, return_km, estimated_minutes,
                           created_at, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insFlight = db.prepare(
      `INSERT INTO flights (code, drone_id, delivery_id, route_id, origin_base_id, return_base_id, started_at, ended_at, distance_km, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insEvent = db.prepare(
      `INSERT INTO tracking_events (delivery_id, type, message, created_at) VALUES (?, ?, ?, ?)`
    );
    const insIncident = db.prepare(
      `INSERT INTO incidents (code, category, description, priority, status, source, delivery_id, drone_id, route_id, base_id,
                              created_at, updated_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const TOTAL = 18;
    // índices que terão ocorrência / situação especial
    const special = {
      3: { kind: 'CANCELLED_TECH' }, // falha técnica, voo interrompido, entrega cancelada
      6: { kind: 'BATTERY', status: 'UNDER_REVIEW' },
      9: { kind: 'WEATHER', status: 'OPEN' },
      12: { kind: 'DELIVERY_PROBLEM', status: 'RESOLVED' },
      15: { kind: 'CANCELLED_MERCHANT' }
    };
    const created = [];

    for (let i = 0; i < TOTAL; i++) {
      const [name, address, neighborhood] = SAMPLE[i % SAMPLE.length];
      const dest = pseudoGeocode(`${address} ${neighborhood} #${i}`, cfg.city.center, cfg.city.radiusKm);
      const droneIdx = Math.floor(rnd() * droneIds.length);
      const baseIdx = DRONES[droneIdx].base;
      const origin = BASES[baseIdx];
      // retorno para a base mais próxima do destino
      let retIdx = 0;
      let best = Infinity;
      BASES.forEach((b, idx) => {
        const d = haversineKm(dest, b);
        if (d < best) { best = d; retIdx = idx; }
      });
      const outKm = haversineKm(origin, dest);
      const retKm = haversineKm(dest, BASES[retIdx]);
      const minutes = ((outKm + retKm) / cfg.drone.defaultSpeedKmh) * 60;

      // entregas espalhadas nos últimos ~3 dias, da mais antiga para a mais recente
      const createdAt = new Date(now.getTime() - (TOTAL - i) * 3.5 * 3600 * 1000 - Math.floor(rnd() * 1800) * 1000);
      const startedAt = new Date(createdAt.getTime() + (4 + Math.floor(rnd() * 8)) * 60 * 1000);
      const deliveredAt = new Date(startedAt.getTime() + (outKm / cfg.drone.defaultSpeedKmh) * 3600 * 1000);
      const endedAt = new Date(startedAt.getTime() + minutes * 60 * 1000);
      const sp = special[i];
      const cancelled = sp && sp.kind.startsWith('CANCELLED');
      const priority = rnd() < 0.3 ? 'HIGH' : 'NORMAL';

      const code = deliveryCode(db);
      const tCode = trackingCode(db, code);
      const merchantId = merchantIds[i % merchantIds.length];
      const status = cancelled ? 'CANCELLED' : 'DELIVERED';
      const droneId = sp && sp.kind === 'CANCELLED_MERCHANT' ? null : droneIds[droneIdx];

      const deliveryId = insDelivery.run(
        code, tCode, merchantId, name, address, neighborhood, dest.lat, dest.lng, priority, status,
        droneId,
        droneId ? baseIds[baseIdx] : null,
        droneId ? baseIds[retIdx] : null,
        cancelled ? (sp.kind === 'CANCELLED_TECH' ? 'falha técnica' : 'cancelada pelo comerciante') : null,
        iso(createdAt), iso(cancelled ? startedAt : deliveredAt), cancelled ? null : iso(deliveredAt)
      ).lastInsertRowid;

      insEvent.run(deliveryId, 'CREATED', 'Pedido recebido e confirmado.', iso(createdAt));
      let routeId = null;
      let flightId = null;
      if (droneId) {
        insEvent.run(deliveryId, 'DRONE_ASSIGNED', `Drone ${DRONES[droneIdx].code} atribuído. Saída da ${origin.name}; retorno previsto para a ${BASES[retIdx].name}.`, iso(createdAt));
        insEvent.run(deliveryId, 'DEPARTED', `Drone ${DRONES[droneIdx].code} decolou da ${origin.name} rumo ao destino.`, iso(startedAt));
        routeId = insRoute.run(
          deliveryId, baseIds[baseIdx], baseIds[retIdx], cancelled ? 'CANCELLED' : 'COMPLETED', outKm, retKm, minutes,
          iso(createdAt), iso(startedAt), iso(endedAt)
        ).lastInsertRowid;
        const interrupted = sp && sp.kind === 'CANCELLED_TECH';
        flightId = insFlight.run(
          flightCode(db), droneIds[droneIdx], deliveryId, routeId, baseIds[baseIdx], baseIds[retIdx],
          iso(startedAt), iso(interrupted ? new Date(startedAt.getTime() + 90 * 1000) : endedAt),
          interrupted ? outKm * 0.4 + 0.4 * outKm : outKm + retKm,
          interrupted ? 'INTERRUPTED' : 'COMPLETED'
        ).lastInsertRowid;
        if (!cancelled) insEvent.run(deliveryId, 'DELIVERED', `Entrega concluída para ${name}.`, iso(deliveredAt));
        else insEvent.run(deliveryId, 'CANCELLED', 'Entrega cancelada (falha técnica).', iso(startedAt));
      } else {
        insEvent.run(deliveryId, 'CANCELLED', 'Entrega cancelada (cancelada pelo comerciante).', iso(startedAt));
      }
      created.push({ deliveryId, routeId, droneId, createdAt, startedAt, sp });
    }

    // ocorrências do histórico
    const catByKind = {
      CANCELLED_TECH: ['TECHNICAL_FAILURE', 'HIGH', 'RESOLVED', 'AUTO', 'Falha técnica detectada em voo; entrega cancelada e drone retornou à base.'],
      BATTERY: ['BATTERY_PROBLEM', 'HIGH', 'UNDER_REVIEW', 'AUTO', 'Bateria abaixo do limite de segurança durante o voo.'],
      WEATHER: ['ADVERSE_WEATHER', 'NORMAL', 'OPEN', 'AUTO', 'Condição climática desfavorável na rota; velocidade reduzida.'],
      DELIVERY_PROBLEM: ['DELIVERY_PROBLEM', 'NORMAL', 'RESOLVED', 'MANUAL', 'Destinatário não localizado no primeiro contato; entrega reagendada.']
    };
    for (const c of created) {
      if (!c.sp || !catByKind[c.sp.kind]) continue;
      const [category, priority, status, source, description] = catByKind[c.sp.kind];
      const at = new Date(c.startedAt.getTime() + 60 * 1000);
      insIncident.run(
        incidentCode(db), category, description, priority, c.sp.status || status, source,
        c.deliveryId, c.droneId, c.routeId, null,
        iso(at), iso(at), (c.sp.status || status) === 'RESOLVED' ? iso(new Date(at.getTime() + 3600 * 1000)) : null
      );
    }
    // ocorrência manual de restrição de espaço aéreo, ligada a uma base
    const at = new Date(now.getTime() - 20 * 3600 * 1000);
    insIncident.run(
      incidentCode(db), 'AIRSPACE_RESTRICTION',
      'Restrição temporária de espaço aéreo próxima à Base Leste durante evento público.', 'HIGH', 'RESOLVED', 'MANUAL',
      null, null, null, baseIds[2], iso(at), iso(at), iso(new Date(at.getTime() + 5 * 3600 * 1000))
    );
  })();
  return true;
}

module.exports = { seedIfEmpty, DEMO_PASSWORD, USERS };

// Execução direta: npm run seed  (recria o banco do zero)
if (require.main === module) {
  const { createContext } = require('./context');
  const { loadConfig } = require('./config');
  const { dbPath } = loadConfig();
  if (process.argv.includes('--reset') && dbPath !== ':memory:') {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* ok se não existir */ }
    }
  }
  const ctx = createContext();
  const seeded = seedIfEmpty(ctx);
  console.log(seeded ? `Banco criado e populado em ${dbPath}` : 'O banco já tinha dados; nada foi alterado.');
  console.log(`Logins de demonstração (senha: ${DEMO_PASSWORD}):`);
  for (const u of USERS) console.log(`  ${u.role.padEnd(12)} ${u.email}`);
}
