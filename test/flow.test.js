/**
 * Testes de integração: sobem a API em memória (SQLite :memory:), sem timers,
 * e avançam a simulação manualmente com step() para ficar determinístico.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createContext } = require('../src/context');
const { createApp } = require('../src/app');
const { seedIfEmpty } = require('../src/seed');
const { step } = require('../src/services/simulation');

async function boot(overrides = {}) {
  const ctx = createContext({
    dbPath: ':memory:',
    staticDir: null,
    seedDemoHistory: false,
    sim: { enabled: false, autoStartDelayS: -1, randomIncidentRate: 0, speed: 25 },
    ...overrides
  });
  seedIfEmpty(ctx);
  const app = createApp(ctx);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;

  async function call(method, path, { token, body } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch { /* sem corpo */ }
    return { status: res.status, body: json };
  }
  const login = async (role) => (await call('POST', '/auth/demo', { body: { role } })).body.token;
  const tokens = {
    merchant: await login('MERCHANT'),
    operator: await login('OPERATOR'),
    authority: await login('AUTHORITIES')
  };
  const close = () => new Promise((r) => server.close(() => { ctx.db.close(); r(); }));
  return { ctx, call, tokens, close };
}

/** Avança a simulação até a condição ser verdadeira (ou estoura). */
function runUntil(ctx, cond, { dt = 1, max = 400 } = {}) {
  for (let i = 0; i < max; i++) {
    if (cond()) return i;
    step(ctx, dt);
  }
  throw new Error('condição não atingida dentro do limite de passos');
}

const newOrder = (extra = {}) => ({
  recipientName: 'Marina Costa',
  address: 'Rua das Palmeiras, 142',
  neighborhood: 'Vila Aurora',
  priority: 'normal',
  ...extra
});

test('autenticação: login por perfil e proteção de rotas', async () => {
  const { call, tokens, close } = await boot();
  try {
    assert.equal((await call('GET', '/deliveries')).status, 401);
    assert.equal((await call('GET', '/auth/me', { token: tokens.merchant })).body.user.role, 'MERCHANT');

    const ok = await call('POST', '/auth/login', { body: { email: 'operator@rovix.demo', password: 'rovix123' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.role, 'OPERATOR');
    assert.equal((await call('POST', '/auth/login', { body: { email: 'operator@rovix.demo', password: 'errada' } })).status, 401);

    // comerciante não acessa drones nem ocorrências; operador não cria entrega
    assert.equal((await call('GET', '/drones', { token: tokens.merchant })).status, 403);
    assert.equal((await call('GET', '/incidents', { token: tokens.merchant })).status, 403);
    assert.equal((await call('POST', '/deliveries', { token: tokens.operator, body: newOrder() })).status, 403);
  } finally { await close(); }
});

test('fluxo completo: cadastro -> drone/base -> decolagem -> entrega -> retorno -> voo registrado', async () => {
  const { ctx, call, tokens, close } = await boot();
  try {
    // 1) comerciante cadastra
    const created = await call('POST', '/deliveries', { token: tokens.merchant, body: newOrder() });
    assert.equal(created.status, 201);
    const d = created.body;
    assert.match(d.code, /^RV-\d+$/);
    assert.match(d.trackingCode, /^RVX-\d+-[A-Z]{2}$/);
    // 2) já recebe drone + base de origem e rota planejada
    assert.equal(d.status, 'PREPARING');
    assert.ok(d.drone && d.originBase && d.returnBase);

    // 3) consumidor consulta (sem login) — ainda em preparo
    let track = await call('GET', `/track/${d.trackingCode.toLowerCase()}`);
    assert.equal(track.status, 200);
    assert.equal(track.body.status, 'PREPARING');
    assert.equal(track.body.progress, 0);

    // 4) só operador inicia
    assert.equal((await call('POST', `/deliveries/${d.code}/start`, { token: tokens.merchant })).status, 403);
    const started = await call('POST', `/deliveries/${d.code}/start`, { token: tokens.operator });
    assert.equal(started.status, 200);
    assert.equal(started.body.status, 'IN_TRANSIT');
    assert.equal((await call('POST', `/deliveries/${d.code}/start`, { token: tokens.operator })).status, 409);

    // drone em entrega; não pode mais ser alterado pelo operador
    const drone = ctx.db.prepare('SELECT * FROM drones WHERE id = ?').get(ctx.db.prepare('SELECT drone_id FROM deliveries WHERE code = ?').get(d.code).drone_id);
    assert.equal(drone.status, 'DELIVERING');
    assert.equal(drone.base_id, null);

    // 5) voa até a entrega ser concluída; o progresso nunca diminui
    let lastProgress = 0;
    runUntil(ctx, () => {
      const p = ctx.db.prepare('SELECT distance_km FROM flights WHERE delivery_id = ?').get(d.id).distance_km;
      assert.ok(p >= lastProgress);
      lastProgress = p;
      const t = ctx.db.prepare('SELECT status FROM deliveries WHERE code = ?').get(d.code);
      return t.status === 'DELIVERED';
    }, { dt: 0.5 });
    track = await call('GET', `/track/${d.trackingCode}`);
    assert.equal(track.body.status, 'DELIVERED');
    assert.equal(track.body.progress, 1);
    assert.ok(track.body.timeline.every((s) => s.state === 'complete'));

    // status independentes: entrega concluída, drone ainda voltando
    const afterDelivery = ctx.db.prepare('SELECT * FROM drones WHERE id = ?').get(drone.id);
    assert.equal(afterDelivery.status, 'RETURNING');
    assert.ok(afterDelivery.target_base_id);

    // 6) drone pousa; rota e voo se encerram
    runUntil(ctx, () => ctx.db.prepare('SELECT base_id FROM drones WHERE id = ?').get(drone.id).base_id !== null, { dt: 0.5 });
    const docked = ctx.db.prepare('SELECT * FROM drones WHERE id = ?').get(drone.id);
    assert.ok(['READY', 'CHARGING'].includes(docked.status));
    assert.ok(docked.battery < 100 || docked.status === 'READY');

    const full = (await call('GET', `/deliveries/${d.code}`, { token: tokens.merchant })).body;
    assert.equal(full.route.status, 'COMPLETED');
    assert.equal(full.flight.status, 'COMPLETED');
    assert.ok(full.flight.distanceKm > 0);
    assert.ok(full.flight.endedAt);

    // 7) autoridades enxergam o voo no histórico
    const flights = await call('GET', '/flights', { token: tokens.authority });
    assert.equal(flights.body.total, 1);
    assert.equal(flights.body.data[0].deliveryCode, d.code);
    assert.equal(flights.body.data[0].statusLabel, 'Concluído');
  } finally { await close(); }
});

test('modo automático: o drone decola sozinho após o tempo configurado', async () => {
  const { ctx, call, tokens, close } = await boot({ sim: { enabled: false, autoStartDelayS: 0, randomIncidentRate: 0, speed: 25 } });
  try {
    const d = (await call('POST', '/deliveries', { token: tokens.merchant, body: newOrder() })).body;
    assert.equal(d.status, 'PREPARING');
    step(ctx, 0.5); // autoStart dispara no primeiro tick
    const row = ctx.db.prepare('SELECT status FROM deliveries WHERE code = ?').get(d.code);
    assert.equal(row.status, 'IN_TRANSIT');
  } finally { await close(); }
});

test('comerciante só enxerga as próprias entregas', async () => {
  const { call, tokens, close } = await boot();
  try {
    const mine = (await call('POST', '/deliveries', { token: tokens.merchant, body: newOrder() })).body;
    // 2º comerciante via login
    const other = (await call('POST', '/auth/login', { body: { email: 'merchant2@rovix.demo', password: 'rovix123' } })).body.token;
    await call('POST', '/deliveries', { token: other, body: newOrder({ recipientName: 'Lucas Ferreira', address: 'Av. das Acácias, 580' }) });

    const listMine = await call('GET', '/deliveries', { token: tokens.merchant });
    assert.equal(listMine.body.total, 1);
    assert.equal(listMine.body.data[0].code, mine.code);
    assert.equal((await call('GET', '/deliveries', { token: tokens.operator })).body.total, 2);
    assert.equal((await call('GET', `/deliveries/${mine.code}`, { token: other })).status, 403);
  } finally { await close(); }
});

test('validação de entrada e código de rastreamento inexistente', async () => {
  const { call, tokens, close } = await boot();
  try {
    const bad = await call('POST', '/deliveries', { token: tokens.merchant, body: { address: 'Rua X, 1' } });
    assert.equal(bad.status, 400);
    const badPriority = await call('POST', '/deliveries', { token: tokens.merchant, body: newOrder({ priority: 'urgentissima' }) });
    assert.equal(badPriority.status, 400);
    assert.equal((await call('GET', '/track/RVX-0000-ZZ')).status, 404);

    const high = await call('POST', '/deliveries', { token: tokens.merchant, body: newOrder({ priority: 'high' }) });
    assert.equal(high.body.priority, 'HIGH');
  } finally { await close(); }
});

test('prioridade ALTA é despachada antes quando falta drone', async () => {
  // sem drones aptos: a fila acumula; ao liberar um drone, a ALTA sai primeiro
  const { ctx, call, tokens, close } = await boot();
  try {
    ctx.db.prepare(`UPDATE drones SET status = 'CHARGING'`).run(); // ninguém pronto
    const normal = (await call('POST', '/deliveries', { token: tokens.merchant, body: newOrder({ recipientName: 'Normal' }) })).body;
    const high = (await call('POST', '/deliveries', { token: tokens.merchant, body: newOrder({ recipientName: 'Urgente', address: 'Rua B, 20', priority: 'HIGH' }) })).body;
    assert.equal(normal.status, 'PENDING');
    assert.equal(high.status, 'PENDING');

    // libera UM drone
    const patched = await call('PATCH', '/drones/DR-01', { token: tokens.operator, body: { status: 'READY', battery: 100 } });
    assert.equal(patched.status, 200);
    const h = (await call('GET', `/deliveries/${high.code}`, { token: tokens.operator })).body;
    const n = (await call('GET', `/deliveries/${normal.code}`, { token: tokens.operator })).body;
    assert.equal(h.status, 'PREPARING');
    assert.equal(n.status, 'PENDING');
  } finally { await close(); }
});

test('cancelamento: antes da decolagem libera o drone; em voo só operador', async () => {
  const { ctx, call, tokens, close } = await boot();
  try {
    const a = (await call('POST', '/deliveries', { token: tokens.merchant, body: newOrder() })).body;
    const cancelled = await call('POST', `/deliveries/${a.code}/cancel`, { token: tokens.merchant, body: { reason: 'cliente desistiu' } });
    assert.equal(cancelled.body.status, 'CANCELLED');
    assert.equal(ctx.db.prepare(`SELECT status FROM routes WHERE delivery_id = ?`).get(a.id).status, 'CANCELLED');
    assert.equal((await call('POST', `/deliveries/${a.code}/cancel`, { token: tokens.merchant })).status, 409);

    // em voo: comerciante recebe 403, operador consegue (drone volta à base)
    const b = (await call('POST', '/deliveries', { token: tokens.merchant, body: newOrder({ address: 'Rua C, 30' }) })).body;
    await call('POST', `/deliveries/${b.code}/start`, { token: tokens.operator });
    step(ctx, 0.2);
    assert.equal((await call('POST', `/deliveries/${b.code}/cancel`, { token: tokens.merchant })).status, 403);
    const droneId = ctx.db.prepare('SELECT drone_id FROM deliveries WHERE code = ?').get(b.code).drone_id;
    const byOp = await call('POST', `/deliveries/${b.code}/cancel`, { token: tokens.operator, body: { reason: 'ordem da base' } });
    assert.equal(byOp.body.status, 'CANCELLED');
    assert.equal(byOp.body.cancelReason, 'ordem da base');

    // o drone faz retorno de emergência e volta a ficar disponível depois de pousar
    assert.equal(ctx.db.prepare('SELECT status FROM drones WHERE id = ?').get(droneId).status, 'RETURNING');
    runUntil(ctx, () => ctx.db.prepare('SELECT base_id FROM drones WHERE id = ?').get(droneId).base_id !== null, { dt: 0.5 });
    assert.ok(['READY', 'CHARGING'].includes(ctx.db.prepare('SELECT status FROM drones WHERE id = ?').get(droneId).status));
    assert.equal(ctx.db.prepare('SELECT status FROM flights WHERE delivery_id = ?').get(ctx.db.prepare('SELECT id FROM deliveries WHERE code = ?').get(b.code).id).status, 'INTERRUPTED');
  } finally { await close(); }
});

test('falha técnica em voo: voo INTERRUPTED, entrega volta à fila e é refeita por outro drone', async () => {
  const { ctx, call, tokens, close } = await boot();
  try {
    const d = (await call('POST', '/deliveries', { token: tokens.merchant, body: newOrder() })).body;
    await call('POST', `/deliveries/${d.code}/start`, { token: tokens.operator });
    step(ctx, 0.3);
    const firstDroneId = ctx.db.prepare('SELECT drone_id FROM deliveries WHERE code = ?').get(d.code).drone_id;

    const inc = await call('POST', '/simulation/incidents', { token: tokens.operator, body: { category: 'TECHNICAL_FAILURE', deliveryCode: d.code } });
    assert.equal(inc.status, 201);
    assert.equal(inc.body.category, 'TECHNICAL_FAILURE');
    assert.equal(inc.body.source, 'AUTO');

    // a entrega foi recolocada e (se houver drone apto) já ganhou outro drone
    step(ctx, 0.1);
    const after = ctx.db.prepare('SELECT * FROM deliveries WHERE code = ?').get(d.code);
    assert.equal(after.status, 'PREPARING');
    assert.notEqual(after.drone_id, firstDroneId);

    const flights = (await call('GET', '/flights', { token: tokens.authority })).body.data;
    assert.ok(flights.some((f) => f.status === 'INTERRUPTED' && f.statusLabel === 'Interrompido'));

    // drone com defeito volta para uma base
    assert.equal(ctx.db.prepare('SELECT status FROM drones WHERE id = ?').get(firstDroneId).status, 'RETURNING');
    runUntil(ctx, () => ctx.db.prepare('SELECT base_id FROM drones WHERE id = ?').get(firstDroneId).base_id !== null, { dt: 0.5 });

    // ocorrência aparece para as autoridades e pode ser acompanhada
    const list = (await call('GET', '/incidents', { token: tokens.authority })).body;
    assert.equal(list.total, 1);
    const patched = await call('PATCH', `/incidents/${list.data[0].code}`, { token: tokens.authority, body: { status: 'UNDER_REVIEW' } });
    assert.equal(patched.body.status, 'UNDER_REVIEW');
    const resolved = await call('PATCH', `/incidents/${list.data[0].code}`, { token: tokens.authority, body: { status: 'RESOLVED' } });
    assert.ok(resolved.body.resolvedAt);
  } finally { await close(); }
});

test('clima adverso reduz a velocidade e a entrega fica atrasada na checagem', async () => {
  const { ctx, call, tokens, close } = await boot();
  try {
    const d = (await call('POST', '/deliveries', { token: tokens.merchant, body: newOrder() })).body;
    await call('POST', `/deliveries/${d.code}/start`, { token: tokens.operator });
    step(ctx, 0.3);
    await call('POST', '/simulation/incidents', { token: tokens.operator, body: { category: 'ADVERSE_WEATHER', deliveryCode: d.code } });
    const drone = ctx.db.prepare('SELECT * FROM drones WHERE id = (SELECT drone_id FROM deliveries WHERE code = ?)').get(d.code);
    assert.equal(drone.speed_factor, 0.5);
    const t = (await call('GET', `/deliveries/${d.code}`, { token: tokens.operator })).body;
    assert.equal(t.hasOpenIncident, true);
  } finally { await close(); }
});

test('base inativa: drone em retorno é redirecionado e a base deixa de receber despachos', async () => {
  const { ctx, call, tokens, close } = await boot();
  try {
    const d = (await call('POST', '/deliveries', { token: tokens.merchant, body: newOrder() })).body;
    await call('POST', `/deliveries/${d.code}/start`, { token: tokens.operator });
    runUntil(ctx, () => ctx.db.prepare('SELECT status FROM deliveries WHERE code = ?').get(d.code).status === 'DELIVERED', { dt: 0.5 });

    const droneRow = ctx.db.prepare('SELECT * FROM drones WHERE status = ?').get('RETURNING');
    const targetBase = droneRow.target_base_id;
    const off = await call('PATCH', `/bases/${targetBase}`, { token: tokens.operator, body: { status: 'INACTIVE' } });
    assert.equal(off.body.status, 'INACTIVE');

    step(ctx, 0.1);
    const re = ctx.db.prepare('SELECT target_base_id FROM drones WHERE id = ?').get(droneRow.id);
    assert.notEqual(re.target_base_id, targetBase);

    runUntil(ctx, () => ctx.db.prepare('SELECT base_id FROM drones WHERE id = ?').get(droneRow.id).base_id !== null, { dt: 0.5 });
    assert.notEqual(ctx.db.prepare('SELECT base_id FROM drones WHERE id = ?').get(droneRow.id).base_id, targetBase);
  } finally { await close(); }
});

test('bateria baixa gera ocorrência automática de bateria', async () => {
  const { ctx, call, tokens, close } = await boot();
  try {
    const d = (await call('POST', '/deliveries', { token: tokens.merchant, body: newOrder() })).body;
    assert.equal(d.status, 'PREPARING');

    // deixa o drone com bateria "justa": passa na checagem de despacho, mas o voo termina em ~20% (< 25%)
    const route = ctx.db.prepare('SELECT * FROM routes WHERE delivery_id = ?').get(d.id);
    const need = (route.outbound_km + route.return_km) * ctx.cfg.drone.drainPerKm;
    ctx.db.prepare('UPDATE drones SET battery = ? WHERE id = ?').run(need + 20, d.drone.id);

    await call('POST', `/deliveries/${d.code}/start`, { token: tokens.operator });
    runUntil(ctx, () => ctx.db.prepare('SELECT base_id FROM drones WHERE id = ?').get(d.drone.id).base_id !== null, { dt: 0.5 });

    const inc = (await call('GET', '/incidents?category=BATTERY_PROBLEM', { token: tokens.authority })).body;
    assert.equal(inc.total, 1); // exatamente uma por voo, mesmo ficando abaixo do limite por vários ticks
    assert.equal(inc.data[0].source, 'AUTO');
    assert.equal(inc.data[0].priority, 'HIGH');
    assert.equal(inc.data[0].deliveryCode, d.code);
  } finally { await close(); }
});

test('ocorrência manual das autoridades e resumo geral', async () => {
  const { call, tokens, close } = await boot();
  try {
    const d = (await call('POST', '/deliveries', { token: tokens.merchant, body: newOrder() })).body;
    const manual = await call('POST', '/incidents', {
      token: tokens.authority,
      body: { category: 'AIRSPACE_RESTRICTION', description: 'Evento público na região da rota.', deliveryCode: d.code, baseId: 1 }
    });
    assert.equal(manual.status, 201);
    assert.equal(manual.body.source, 'MANUAL');
    assert.equal(manual.body.deliveryCode, d.code);
    assert.equal(manual.body.statusLabel, 'Aberta');

    // operador não registra ocorrência manual; categoria inválida = 400
    assert.equal((await call('POST', '/incidents', { token: tokens.operator, body: { category: 'AIRSPACE_RESTRICTION', description: 'xxxxxx' } })).status, 403);
    assert.equal((await call('POST', '/incidents', { token: tokens.authority, body: { category: 'OVNI', description: 'xxxxxx' } })).status, 400);

    const ov = (await call('GET', '/overview', { token: tokens.authority })).body;
    assert.equal(ov.incidents.open, 1);
    assert.equal(ov.deliveries.total, 1);
    assert.equal(ov.drones.total, 6);
    assert.equal(ov.bases.active, 3);
  } finally { await close(); }
});

test('resumo de rotas ativas para o painel do operador', async () => {
  const { call, tokens, close } = await boot();
  try {
    for (const [i, addr] of ['Rua A, 10', 'Rua B, 20', 'Rua C, 30'].entries()) {
      await call('POST', '/deliveries', { token: tokens.merchant, body: newOrder({ recipientName: `Cliente ${i}`, address: addr }) });
    }
    const s = (await call('GET', '/routes/active/summary', { token: tokens.operator })).body;
    assert.equal(s.stopsCount, 3);
    assert.equal(s.stops[0].order, 1);
    assert.ok(s.totalDistanceKm > 0);
    assert.ok(s.estimatedMinutes > 0);

    const stats = (await call('GET', '/deliveries/stats', { token: tokens.operator })).body;
    assert.equal(stats.total, 3);
    assert.equal(stats.pending, 3); // PENDING + PREPARING = "aguardando coleta"
  } finally { await close(); }
});

test('geocodificação simulada é determinística e coordenadas manuais são aceitas', async () => {
  const { call, tokens, close } = await boot();
  try {
    const a = (await call('POST', '/deliveries', { token: tokens.merchant, body: newOrder() })).body;
    const b = (await call('POST', '/deliveries', { token: tokens.merchant, body: newOrder() })).body;
    assert.deepEqual(a.destination, b.destination);

    const manual = await call('POST', '/deliveries', {
      token: tokens.merchant,
      body: newOrder({ destination: { lat: -25.42, lng: -49.26 } })
    });
    assert.deepEqual(manual.body.destination, { lat: -25.42, lng: -49.26 });
    const badCoord = await call('POST', '/deliveries', { token: tokens.merchant, body: newOrder({ destination: { lat: 999, lng: 0 } }) });
    assert.equal(badCoord.status, 400);
  } finally { await close(); }
});
