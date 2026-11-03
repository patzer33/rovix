/**
 * Ocorrências: criadas automaticamente pela simulação ou manualmente pelas autoridades.
 * Ocorrências geradas pela simulação (ou injetadas na demo) também têm EFEITO nas operações.
 */
const { INCIDENT_CATEGORIES, LABELS } = require('../constants');
const { badRequest } = require('../lib/http');
const { incidentCode } = require('../lib/codes');
const { iso, addEvent, publishDelivery } = require('./log');
const { abortFlight } = require('./flightops');

const DEFAULTS = {
  TECHNICAL_FAILURE: { priority: 'HIGH', text: 'Falha técnica detectada no drone durante o voo.' },
  BATTERY_PROBLEM: { priority: 'HIGH', text: 'Nível de bateria abaixo do limite de segurança durante o voo.' },
  ADVERSE_WEATHER: { priority: 'NORMAL', text: 'Condição climática desfavorável na rota; velocidade reduzida.' },
  ROUTE_DEVIATION: { priority: 'NORMAL', text: 'Desvio em relação à rota planejada.' },
  DELIVERY_PROBLEM: { priority: 'NORMAL', text: 'Problema registrado durante a entrega.' },
  AIRSPACE_RESTRICTION: { priority: 'HIGH', text: 'Restrição de espaço aéreo identificada na região da rota.' }
};

function getDrone(ctx, id) {
  return ctx.db.prepare('SELECT * FROM drones WHERE id = ?').get(id);
}

/** Insere a ocorrência e avisa os clientes conectados. */
function insertIncident(ctx, data) {
  const { db } = ctx;
  const now = iso();
  const info = db
    .prepare(
      `INSERT INTO incidents (code, category, description, priority, status, source,
                              delivery_id, drone_id, route_id, base_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      incidentCode(db),
      data.category,
      data.description,
      data.priority,
      data.source,
      data.deliveryId ?? null,
      data.droneId ?? null,
      data.routeId ?? null,
      data.baseId ?? null,
      data.createdBy ?? null,
      now,
      now
    );
  const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(info.lastInsertRowid);
  ctx.hub.publish('incident.created', { incidentId: incident.id, code: incident.code, category: incident.category });
  return incident;
}

/**
 * Registra uma ocorrência. Se `applyEffect` for true (simulação/injeção de demo),
 * aplica a consequência operacional da categoria:
 *  - ADVERSE_WEATHER : o drone voa a 50% da velocidade até pousar.
 *  - TECHNICAL_FAILURE: o voo é interrompido; a entrega volta para a fila.
 *  - demais categorias: apenas registro.
 */
function raiseIncident(ctx, input, { applyEffect = true } = {}) {
  if (!INCIDENT_CATEGORIES.includes(input.category)) {
    throw badRequest(`Categoria inválida. Use: ${INCIDENT_CATEGORIES.join(', ')}.`);
  }
  const defaults = DEFAULTS[input.category];
  const { db } = ctx;

  let drone = input.droneId ? getDrone(ctx, input.droneId) : null;
  let delivery = input.deliveryId
    ? db.prepare('SELECT * FROM deliveries WHERE id = ?').get(input.deliveryId)
    : null;

  // Completa os vínculos: drone -> entrega em voo -> rota ativa.
  if (!delivery && drone) {
    delivery = db.prepare(`SELECT * FROM deliveries WHERE drone_id = ? AND status = 'IN_TRANSIT'`).get(drone.id) || null;
  }
  if (!drone && delivery && delivery.drone_id) drone = getDrone(ctx, delivery.drone_id);

  let routeId = input.routeId ?? null;
  if (!routeId && delivery) {
    const route = db
      .prepare(`SELECT id FROM routes WHERE delivery_id = ? AND status != 'CANCELLED' ORDER BY id DESC LIMIT 1`)
      .get(delivery.id);
    routeId = route ? route.id : null;
  }

  const incident = insertIncident(ctx, {
    category: input.category,
    description: input.description || defaults.text,
    priority: input.priority || defaults.priority,
    source: input.source || 'MANUAL',
    deliveryId: delivery ? delivery.id : null,
    droneId: drone ? drone.id : null,
    routeId,
    baseId: input.baseId ?? null,
    createdBy: input.createdBy ?? null
  });

  if (delivery) {
    addEvent(ctx, delivery.id, 'INCIDENT', `Ocorrência registrada: ${LABELS.category[input.category]}.`);
    publishDelivery(ctx, delivery.id);
  }

  if (applyEffect && drone) {
    if (input.category === 'ADVERSE_WEATHER' && ['DELIVERING', 'RETURNING'].includes(drone.status)) {
      db.prepare('UPDATE drones SET speed_factor = 0.5 WHERE id = ?').run(drone.id);
      ctx.hub.publish('drone.updated', { droneId: drone.id });
    }
    if (input.category === 'TECHNICAL_FAILURE' && drone.status === 'DELIVERING') {
      abortFlight(ctx, getDrone(ctx, drone.id), 'falha técnica', { requeue: true });
    }
  }
  return incident;
}

module.exports = { raiseIncident, DEFAULTS };
