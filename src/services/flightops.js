/**
 * Operações de voo: decolar, concluir entrega, pousar e abortar.
 * Cada função mantém consistentes os status INDEPENDENTES de entrega, drone, rota e voo.
 * (Ex.: a entrega fica DELIVERED enquanto o drone ainda está RETURNING.)
 */
const { haversineKm } = require('../lib/geo');
const { flightCode } = require('../lib/codes');
const { iso, addEvent, publishDelivery } = require('./log');
const { pickReturnBase } = require('./fleet');

const getBase = (ctx, id) => ctx.db.prepare('SELECT * FROM bases WHERE id = ?').get(id);

/** PREPARING -> IN_TRANSIT: o drone decola da base de origem. */
function startFlight(ctx, delivery, drone, route) {
  const { db } = ctx;
  const now = iso();
  const origin = getBase(ctx, route.origin_base_id);

  const flightId = db
    .prepare(
      `INSERT INTO flights (code, drone_id, delivery_id, route_id, origin_base_id, return_base_id,
                            started_at, distance_km, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'IN_PROGRESS')`
    )
    .run(
      flightCode(db),
      drone.id,
      delivery.id,
      route.id,
      route.origin_base_id,
      route.return_base_id,
      now
    ).lastInsertRowid;

  db.prepare(`UPDATE routes SET status = 'IN_PROGRESS', started_at = ? WHERE id = ?`).run(now, route.id);

  db.prepare(
    `UPDATE drones SET status = 'DELIVERING', base_id = NULL, target_base_id = NULL,
                       flight_id = ?, speed_factor = 1 WHERE id = ?`
  ).run(flightId, drone.id);

  // Prazo para considerar "atrasada": tempo ideal de ida + folga de 25% + 5 s.
  const idealSeconds = ((route.outbound_km / drone.speed_kmh) * 3600) / ctx.sim.speed;
  const deadline = new Date(Date.now() + (idealSeconds * 1.25 + 5) * 1000).toISOString();

  db.prepare(
    `UPDATE deliveries SET status = 'IN_TRANSIT', planned_eta_at = ?, ready_at = NULL, updated_at = ?
     WHERE id = ?`
  ).run(deadline, now, delivery.id);

  addEvent(ctx, delivery.id, 'DEPARTED', `Drone ${drone.code} decolou da ${origin.name} rumo ao destino.`, {
    lat: origin.lat,
    lng: origin.lng
  });
  publishDelivery(ctx, delivery.id);
  ctx.hub.publish('drone.updated', { droneId: drone.id });
  return flightId;
}

/** Drone chegou ao destino: entrega concluída e início do retorno a uma base disponível. */
function arriveAtDestination(ctx, delivery, drone) {
  const { db } = ctx;
  const now = iso();
  const dest = { lat: delivery.dest_lat, lng: delivery.dest_lng };

  db.prepare(
    `UPDATE deliveries SET status = 'DELIVERED', delivered_at = ?, updated_at = ?, planned_eta_at = NULL
     WHERE id = ?`
  ).run(now, now, delivery.id);
  addEvent(ctx, delivery.id, 'DELIVERED', `Entrega concluída para ${delivery.recipient_name}.`, dest);

  // Reavalia a base de retorno AGORA (a planejada pode ter ficado inativa ou lotada).
  const returnBase = pickReturnBase(ctx, dest, { selfDroneId: drone.id });
  db.prepare(
    `UPDATE drones SET status = 'RETURNING', target_base_id = ?, lat = ?, lng = ? WHERE id = ?`
  ).run(returnBase ? returnBase.id : null, dest.lat, dest.lng, drone.id);

  if (returnBase) {
    const returnKm = haversineKm(dest, returnBase);
    db.prepare(
      `UPDATE routes SET return_base_id = ?, return_km = ?
       WHERE delivery_id = ? AND status = 'IN_PROGRESS'`
    ).run(returnBase.id, returnKm, delivery.id);
    db.prepare('UPDATE flights SET return_base_id = ? WHERE id = ?').run(returnBase.id, drone.flight_id);
    db.prepare('UPDATE deliveries SET return_base_id = ? WHERE id = ?').run(returnBase.id, delivery.id);
    addEvent(ctx, delivery.id, 'RETURNING', `Drone ${drone.code} retornando para a ${returnBase.name}.`, dest);
  }

  publishDelivery(ctx, delivery.id);
  ctx.hub.publish('drone.updated', { droneId: drone.id });
}

/** Drone pousou em uma base: fecha voo e rota, e vai carregar (ou fica pronto). */
function dock(ctx, drone, base) {
  const { db } = ctx;
  const now = iso();
  const flight = drone.flight_id ? db.prepare('SELECT * FROM flights WHERE id = ?').get(drone.flight_id) : null;

  const status = drone.battery >= 99.5 ? 'READY' : 'CHARGING';
  db.prepare(
    `UPDATE drones SET status = ?, base_id = ?, target_base_id = NULL, flight_id = NULL,
                       lat = ?, lng = ?, speed_factor = 1 WHERE id = ?`
  ).run(status, base.id, base.lat, base.lng, drone.id);

  if (flight) {
    if (flight.status === 'IN_PROGRESS') {
      db.prepare(
        `UPDATE flights SET status = 'COMPLETED', ended_at = ?, return_base_id = ? WHERE id = ?`
      ).run(now, base.id, flight.id);
    } else {
      db.prepare('UPDATE flights SET return_base_id = ? WHERE id = ?').run(base.id, flight.id);
    }
    if (flight.route_id) {
      db.prepare(
        `UPDATE routes SET status = 'COMPLETED', completed_at = ?, return_base_id = ?
         WHERE id = ? AND status = 'IN_PROGRESS'`
      ).run(now, base.id, flight.route_id);
    }
    if (flight.delivery_id) {
      addEvent(ctx, flight.delivery_id, 'DOCKED', `Drone ${drone.code} pousou na ${base.name}.`, {
        lat: base.lat,
        lng: base.lng
      });
      publishDelivery(ctx, flight.delivery_id);
    }
  }
  ctx.hub.publish('drone.updated', { droneId: drone.id });
  ctx.hub.publish('base.updated', { baseId: base.id });
}

/**
 * Interrompe o voo de um drone em entrega (falha técnica, cancelamento pelo operador...).
 * - requeue = true : a entrega volta para a fila (PENDING) e será despachada com outro drone.
 * - requeue = false: a entrega é CANCELADA.
 * O drone faz um retorno de emergência à base mais próxima.
 */
function abortFlight(ctx, drone, reason, { requeue = true } = {}) {
  const { db } = ctx;
  const now = iso();
  const pos = { lat: drone.lat, lng: drone.lng };
  const delivery = db
    .prepare(`SELECT * FROM deliveries WHERE drone_id = ? AND status = 'IN_TRANSIT'`)
    .get(drone.id);

  if (drone.flight_id) {
    db.prepare(`UPDATE flights SET status = 'INTERRUPTED', ended_at = ? WHERE id = ?`).run(now, drone.flight_id);
  }

  if (delivery) {
    db.prepare(
      `UPDATE routes SET status = 'CANCELLED', completed_at = ?
       WHERE delivery_id = ? AND status IN ('PLANNED','IN_PROGRESS')`
    ).run(now, delivery.id);

    if (requeue) {
      db.prepare(
        `UPDATE deliveries SET status = 'PENDING', drone_id = NULL, origin_base_id = NULL, return_base_id = NULL,
                               planned_eta_at = NULL, ready_at = NULL, updated_at = ? WHERE id = ?`
      ).run(now, delivery.id);
      addEvent(ctx, delivery.id, 'REQUEUED', `Voo interrompido (${reason}). Entrega recolocada na fila para novo drone.`, pos);
    } else {
      db.prepare(
        `UPDATE deliveries SET status = 'CANCELLED', cancel_reason = ?, planned_eta_at = NULL, updated_at = ?
         WHERE id = ?`
      ).run(reason, now, delivery.id);
      addEvent(ctx, delivery.id, 'CANCELLED', `Entrega cancelada (${reason}).`, pos);
    }
    publishDelivery(ctx, delivery.id);
  }

  const base = pickReturnBase(ctx, pos, { selfDroneId: drone.id });
  db.prepare(`UPDATE drones SET status = 'RETURNING', target_base_id = ? WHERE id = ?`).run(
    base ? base.id : null,
    drone.id
  );
  ctx.hub.publish('drone.updated', { droneId: drone.id });
}

/** Cancela uma entrega que ainda não decolou (PENDING ou PREPARING), liberando o drone. */
function cancelBeforeFlight(ctx, delivery, reason) {
  const { db } = ctx;
  const now = iso();
  db.prepare(
    `UPDATE routes SET status = 'CANCELLED', completed_at = ?
     WHERE delivery_id = ? AND status IN ('PLANNED','IN_PROGRESS')`
  ).run(now, delivery.id);
  db.prepare(
    `UPDATE deliveries SET status = 'CANCELLED', cancel_reason = ?, ready_at = NULL, planned_eta_at = NULL,
                           updated_at = ? WHERE id = ?`
  ).run(reason, now, delivery.id);
  addEvent(ctx, delivery.id, 'CANCELLED', `Entrega cancelada (${reason}).`);
  publishDelivery(ctx, delivery.id);
}

module.exports = { startFlight, arriveAtDestination, dock, abortFlight, cancelBeforeFlight };
