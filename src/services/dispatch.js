/**
 * Despacho: associa entregas pendentes a um drone + base de origem, planeja a rota
 * e (quando o operador manda, ou automaticamente) faz o drone decolar.
 */
const { haversineKm } = require('../lib/geo');
const { badRequest, conflict } = require('../lib/http');
const { iso, addEvent, publishDelivery } = require('./log');
const { pickReturnBase } = require('./fleet');
const { startFlight } = require('./flightops');

/** Drones aptos: prontos, estacionados em base ATIVA e ainda sem entrega atribuída. */
function candidateDrones(ctx) {
  return ctx.db
    .prepare(
      `SELECT dr.*, b.lat AS base_lat, b.lng AS base_lng, b.name AS base_name
       FROM drones dr
       JOIN bases b ON b.id = dr.base_id
       WHERE dr.status = 'READY' AND b.status = 'ACTIVE'
         AND NOT EXISTS (
           SELECT 1 FROM deliveries d
           WHERE d.drone_id = dr.id AND d.status IN ('PREPARING','IN_TRANSIT')
         )`
    )
    .all();
}

/**
 * Escolhe o melhor drone para o destino: o de base mais próxima que tenha bateria para
 * ir, voltar a uma base e ainda manter a reserva de segurança.
 */
function pickBestDrone(ctx, dest) {
  const { drone: dcfg } = ctx.cfg;
  let best = null;
  for (const dr of candidateDrones(ctx)) {
    const outboundKm = haversineKm({ lat: dr.base_lat, lng: dr.base_lng }, dest);
    const returnBase = pickReturnBase(ctx, dest, { selfDroneId: dr.id });
    if (!returnBase) continue;
    const returnKm = haversineKm(dest, returnBase);
    const needed = (outboundKm + returnKm) * dcfg.drainPerKm + dcfg.reservePct;
    if (dr.battery < needed) continue;
    const score = outboundKm - dr.battery / 1000; // desempate: mais bateria
    if (!best || score < best.score) {
      best = { drone: dr, outboundKm, returnKm, returnBase, score };
    }
  }
  return best;
}

function assign(ctx, delivery, pick) {
  const { db, cfg } = ctx;
  const now = iso();
  const { drone, outboundKm, returnKm, returnBase } = pick;
  const speed = drone.speed_kmh;
  const estimatedMinutes = ((outboundKm + returnKm) / speed) * 60;

  db.prepare(
    `INSERT INTO routes (delivery_id, origin_base_id, return_base_id, status, outbound_km, return_km,
                         estimated_minutes, created_at)
     VALUES (?, ?, ?, 'PLANNED', ?, ?, ?, ?)`
  ).run(delivery.id, drone.base_id, returnBase.id, outboundKm, returnKm, estimatedMinutes, now);

  const readyAt =
    cfg.sim.autoStartDelayS >= 0 ? new Date(Date.now() + cfg.sim.autoStartDelayS * 1000).toISOString() : null;

  db.prepare(
    `UPDATE deliveries SET status = 'PREPARING', drone_id = ?, origin_base_id = ?, return_base_id = ?,
                           ready_at = ?, updated_at = ? WHERE id = ?`
  ).run(drone.id, drone.base_id, returnBase.id, readyAt, now, delivery.id);

  addEvent(
    ctx,
    delivery.id,
    'DRONE_ASSIGNED',
    `Drone ${drone.code} atribuído. Saída da ${drone.base_name}; retorno previsto para a ${returnBase.name}.`,
    { lat: drone.base_lat, lng: drone.base_lng }
  );
  publishDelivery(ctx, delivery.id);
  ctx.hub.publish('drone.updated', { droneId: drone.id });
}

/** Tenta despachar todas as entregas pendentes (ALTA prioridade primeiro, depois as mais antigas). */
function dispatchPending(ctx) {
  const pending = ctx.db
    .prepare(
      `SELECT * FROM deliveries WHERE status = 'PENDING'
       ORDER BY (priority = 'HIGH') DESC, created_at ASC, id ASC`
    )
    .all();

  let dispatched = 0;
  for (const delivery of pending) {
    const dest = { lat: delivery.dest_lat, lng: delivery.dest_lng };
    const pick = pickBestDrone(ctx, dest);
    if (pick) {
      assign(ctx, delivery, pick);
      dispatched++;
    } else {
      const last = ctx.db
        .prepare('SELECT type FROM tracking_events WHERE delivery_id = ? ORDER BY id DESC LIMIT 1')
        .get(delivery.id);
      if (!last || last.type !== 'WAITING') {
        addEvent(ctx, delivery.id, 'WAITING', 'Aguardando um drone disponível com bateria suficiente.');
      }
    }
  }
  return dispatched;
}

/** Operador (ou o modo automático) manda o drone atribuído decolar. */
function startDelivery(ctx, deliveryId) {
  const { db } = ctx;
  const delivery = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(deliveryId);
  if (!delivery) throw badRequest('Entrega não encontrada.');
  if (delivery.status !== 'PREPARING') {
    throw conflict(`Só é possível iniciar entregas em preparo (status atual: ${delivery.status}).`);
  }

  const drone = db.prepare('SELECT * FROM drones WHERE id = ?').get(delivery.drone_id);
  if (!drone || drone.status !== 'READY' || !drone.base_id) {
    throw conflict('O drone atribuído não está pronto para decolar.');
  }
  const route = db
    .prepare(`SELECT * FROM routes WHERE delivery_id = ? AND status = 'PLANNED' ORDER BY id DESC LIMIT 1`)
    .get(delivery.id);
  if (!route) throw conflict('A entrega não possui rota planejada.');

  // Reconfere a base de retorno no momento da decolagem (pode ter mudado desde o planejamento).
  const returnBase = pickReturnBase(ctx, { lat: delivery.dest_lat, lng: delivery.dest_lng }, { selfDroneId: drone.id });
  if (returnBase && returnBase.id !== route.return_base_id) {
    const returnKm = haversineKm({ lat: delivery.dest_lat, lng: delivery.dest_lng }, returnBase);
    db.prepare('UPDATE routes SET return_base_id = ?, return_km = ? WHERE id = ?').run(returnBase.id, returnKm, route.id);
    route.return_base_id = returnBase.id;
  }

  startFlight(ctx, delivery, drone, route);
}

module.exports = { dispatchPending, startDelivery, pickBestDrone };
