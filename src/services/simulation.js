/**
 * Motor da simulação. Nada aqui usa GPS ou drones reais: a cada "tick" os drones em voo
 * avançam em linha reta até o alvo, gastam bateria, pousam, recarregam, e a fila é despachada.
 *
 * step(ctx, realSeconds) é puro em relação ao relógio (recebe o delta), então os testes
 * conseguem avançar a simulação de forma determinística.
 */
const { moveToward, haversineKm } = require('../lib/geo');
const { iso, addEvent, publishDelivery } = require('./log');
const { freeSlots, pickReturnBase } = require('./fleet');
const { arriveAtDestination, dock } = require('./flightops');
const { dispatchPending, startDelivery } = require('./dispatch');
const { raiseIncident } = require('./incidents');

/** Entregas em preparo cujo horário de decolagem automática chegou. */
function autoStart(ctx) {
  if (ctx.cfg.sim.autoStartDelayS < 0) return;
  const due = ctx.db
    .prepare(`SELECT id FROM deliveries WHERE status = 'PREPARING' AND ready_at IS NOT NULL AND ready_at <= ?`)
    .all(iso());
  for (const { id } of due) {
    try {
      startDelivery(ctx, id);
    } catch {
      // drone indisponível no momento: tenta de novo no próximo tick
    }
  }
}

function applyMovement(ctx, drone, target, simSeconds) {
  const { db, cfg } = ctx;
  const distKm = (drone.speed_kmh * drone.speed_factor * simSeconds) / 3600;
  const move = moveToward({ lat: drone.lat, lng: drone.lng }, target, distKm);
  const battery = Math.max(0, drone.battery - move.movedKm * cfg.drone.drainPerKm);
  db.prepare('UPDATE drones SET lat = ?, lng = ?, battery = ? WHERE id = ?').run(move.lat, move.lng, battery, drone.id);
  if (drone.flight_id) {
    db.prepare('UPDATE flights SET distance_km = distance_km + ? WHERE id = ?').run(move.movedKm, drone.flight_id);
  }
  return { ...drone, lat: move.lat, lng: move.lng, battery, arrived: move.arrived };
}

/** Bateria baixa durante o voo gera ocorrência automática (uma vez por voo). */
function checkLowBattery(ctx, drone) {
  if (!drone.flight_id || drone.battery >= ctx.cfg.drone.lowBatteryPct) return;
  const flight = ctx.db.prepare('SELECT * FROM flights WHERE id = ?').get(drone.flight_id);
  if (!flight) return;
  const already = ctx.db
    .prepare(
      `SELECT 1 FROM incidents WHERE drone_id = ? AND category = 'BATTERY_PROBLEM' AND created_at >= ?`
    )
    .get(drone.id, flight.started_at);
  if (already) return;
  raiseIncident(
    ctx,
    {
      category: 'BATTERY_PROBLEM',
      droneId: drone.id,
      deliveryId: flight.delivery_id, // vale também no retorno, quando a entrega já foi concluída
      source: 'AUTO',
      description: `Bateria do drone ${drone.code} em ${Math.round(drone.battery)}% durante o voo.`
    },
    { applyEffect: false }
  );
}

function moveDelivering(ctx, simSeconds) {
  const drones = ctx.db.prepare(`SELECT * FROM drones WHERE status = 'DELIVERING'`).all();
  for (const drone of drones) {
    const delivery = ctx.db
      .prepare(`SELECT * FROM deliveries WHERE drone_id = ? AND status = 'IN_TRANSIT'`)
      .get(drone.id);
    if (!delivery) continue; // estado inconsistente: nada a fazer
    const moved = applyMovement(ctx, drone, { lat: delivery.dest_lat, lng: delivery.dest_lng }, simSeconds);
    checkLowBattery(ctx, moved);
    if (moved.arrived) arriveAtDestination(ctx, delivery, moved);
  }
}

function moveReturning(ctx, simSeconds) {
  const drones = ctx.db.prepare(`SELECT * FROM drones WHERE status = 'RETURNING'`).all();
  for (const original of drones) {
    let drone = original;
    let base = drone.target_base_id
      ? ctx.db.prepare('SELECT * FROM bases WHERE id = ?').get(drone.target_base_id)
      : null;

    // Base de retorno ficou inativa (ou não existe mais): replaneja para outra disponível.
    if (!base || base.status !== 'ACTIVE') {
      const next = pickReturnBase(ctx, { lat: drone.lat, lng: drone.lng }, { selfDroneId: drone.id });
      if (next && (!base || next.id !== base.id)) {
        ctx.db.prepare('UPDATE drones SET target_base_id = ? WHERE id = ?').run(next.id, drone.id);
        const flight = drone.flight_id ? ctx.db.prepare('SELECT * FROM flights WHERE id = ?').get(drone.flight_id) : null;
        if (flight && flight.delivery_id) {
          addEvent(ctx, flight.delivery_id, 'RETURNING', `Base de retorno alterada para a ${next.name}.`);
        }
        base = next;
      }
    }
    if (!base) continue;

    drone = applyMovement(ctx, drone, { lat: base.lat, lng: base.lng }, simSeconds);
    checkLowBattery(ctx, drone);
    if (drone.arrived) dock(ctx, drone, base);
  }
}

function charge(ctx, simSeconds) {
  const rate = ctx.cfg.drone.chargePctPerSimMin;
  const drones = ctx.db.prepare(`SELECT * FROM drones WHERE status = 'CHARGING'`).all();
  for (const drone of drones) {
    const battery = Math.min(100, drone.battery + rate * (simSeconds / 60));
    const status = battery >= 99.5 ? 'READY' : 'CHARGING';
    ctx.db.prepare('UPDATE drones SET battery = ?, status = ? WHERE id = ?').run(
      status === 'READY' ? 100 : battery,
      status,
      drone.id
    );
    if (status === 'READY') ctx.hub.publish('drone.updated', { droneId: drone.id });
  }
}

/** Ocorrências aleatórias (clima/falha técnica) durante entregas; a taxa é configurável. */
function randomIncidents(ctx, realSeconds) {
  const rate = ctx.cfg.sim.randomIncidentRate;
  if (!rate) return;
  const drones = ctx.db.prepare(`SELECT * FROM drones WHERE status = 'DELIVERING'`).all();
  for (const drone of drones) {
    if (Math.random() >= rate * realSeconds) continue;
    const category = Math.random() < 0.75 ? 'ADVERSE_WEATHER' : 'TECHNICAL_FAILURE';
    // evita empilhar o mesmo clima várias vezes no mesmo voo
    if (category === 'ADVERSE_WEATHER' && drone.speed_factor < 1) continue;
    raiseIncident(ctx, { category, droneId: drone.id, source: 'AUTO' }, { applyEffect: true });
  }
}

function publishPositions(ctx) {
  const flying = ctx.db
    .prepare(
      `SELECT dr.id, dr.code, dr.lat, dr.lng, dr.battery, dr.status,
              d.id AS delivery_id, d.code AS delivery_code, d.tracking_code, d.merchant_id
       FROM drones dr
       LEFT JOIN deliveries d ON d.drone_id = dr.id AND d.status = 'IN_TRANSIT'
       WHERE dr.status IN ('DELIVERING','RETURNING')`
    )
    .all();
  for (const f of flying) {
    ctx.hub.publish('drone.moved', {
      droneId: f.id,
      droneCode: f.code,
      status: f.status,
      lat: f.lat,
      lng: f.lng,
      battery: Math.round(f.battery * 10) / 10,
      deliveryId: f.delivery_id,
      code: f.delivery_code,
      trackingCode: f.tracking_code,
      merchantId: f.merchant_id
    });
  }
}

/** Avança a simulação. `realSeconds` é o tempo real decorrido (convertido pelo multiplicador). */
function step(ctx, realSeconds) {
  const simSeconds = realSeconds * ctx.sim.speed;
  ctx.db.transaction(() => {
    autoStart(ctx);
    moveDelivering(ctx, simSeconds);
    moveReturning(ctx, simSeconds);
    charge(ctx, simSeconds);
    randomIncidents(ctx, realSeconds);
    dispatchPending(ctx);
  })();
  publishPositions(ctx);
}

/** Loop em tempo real (setInterval). */
function createLoop(ctx) {
  let timer = null;
  let last = Date.now();

  function start() {
    if (timer || !ctx.cfg.sim.enabled) return;
    last = Date.now();
    ctx.sim.running = true;
    timer = setInterval(() => {
      const now = Date.now();
      const dt = Math.min((now - last) / 1000, 5); // limita saltos (ex.: máquina em suspensão)
      last = now;
      if (ctx.sim.paused) return;
      try {
        step(ctx, dt);
      } catch (err) {
        console.error('[simulação] erro no tick:', err);
      }
    }, ctx.cfg.sim.tickMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    ctx.sim.running = false;
  }

  return { start, stop };
}

module.exports = { step, createLoop };
