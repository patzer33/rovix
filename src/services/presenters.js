/**
 * Converte linhas do banco em JSON camelCase pronto para o front (com rótulos em português).
 */
const { LABELS } = require('../constants');
const { round } = require('../lib/geo');
const { freeSlots, dockedCount, inboundCount } = require('./fleet');

const DELIVERY_SELECT = `
  SELECT d.*,
         dr.code AS drone_code,
         ob.name AS origin_base_name,
         rb.name AS return_base_name,
         u.name  AS merchant_name,
         (SELECT COUNT(*) FROM incidents i WHERE i.delivery_id = d.id AND i.status != 'RESOLVED') AS open_incidents
  FROM deliveries d
  LEFT JOIN drones dr ON dr.id = d.drone_id
  LEFT JOIN bases  ob ON ob.id = d.origin_base_id
  LEFT JOIN bases  rb ON rb.id = d.return_base_id
  LEFT JOIN users  u  ON u.id  = d.merchant_id`;

function isDelayed(ctx, row, now = Date.now()) {
  if (row.status === 'IN_TRANSIT' && row.planned_eta_at) return now > Date.parse(row.planned_eta_at);
  if (row.status === 'PENDING') return now - Date.parse(row.created_at) > ctx.cfg.sim.pendingDelayS * 1000;
  return false;
}

function deliveryDTO(ctx, row) {
  return {
    id: row.id,
    code: row.code,
    trackingCode: row.tracking_code,
    recipientName: row.recipient_name,
    address: row.address,
    neighborhood: row.neighborhood,
    destination: { lat: row.dest_lat, lng: row.dest_lng },
    priority: row.priority,
    priorityLabel: LABELS.priority[row.priority],
    status: row.status,
    statusLabel: LABELS.delivery[row.status],
    isDelayed: isDelayed(ctx, row),
    hasOpenIncident: row.open_incidents > 0,
    merchant: row.merchant_name ? { id: row.merchant_id, name: row.merchant_name } : undefined,
    drone: row.drone_id ? { id: row.drone_id, code: row.drone_code } : null,
    originBase: row.origin_base_id ? { id: row.origin_base_id, name: row.origin_base_name } : null,
    returnBase: row.return_base_id ? { id: row.return_base_id, name: row.return_base_name } : null,
    cancelReason: row.cancel_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at
  };
}

function baseDTO(ctx, b) {
  const docked = dockedCount(ctx, b.id);
  const inbound = inboundCount(ctx, b.id);
  return {
    id: b.id,
    name: b.name,
    lat: b.lat,
    lng: b.lng,
    capacity: b.capacity,
    status: b.status,
    statusLabel: LABELS.base[b.status],
    dockedDrones: docked,
    inboundDrones: inbound,
    freeSlots: freeSlots(ctx, b)
  };
}

function droneDTO(ctx, d) {
  const delivery = ctx.db
    .prepare(`SELECT id, code, tracking_code FROM deliveries WHERE drone_id = ? AND status IN ('PREPARING','IN_TRANSIT')`)
    .get(d.id);
  const base = d.base_id ? ctx.db.prepare('SELECT id, name FROM bases WHERE id = ?').get(d.base_id) : null;
  const target = d.target_base_id ? ctx.db.prepare('SELECT id, name FROM bases WHERE id = ?').get(d.target_base_id) : null;
  return {
    id: d.id,
    code: d.code,
    model: d.model,
    status: d.status,
    statusLabel: LABELS.drone[d.status],
    battery: round(d.battery, 1),
    position: { lat: d.lat, lng: d.lng },
    base: base ? { id: base.id, name: base.name } : null,
    targetBase: target ? { id: target.id, name: target.name } : null,
    speedKmh: d.speed_kmh,
    weatherSlowdown: d.speed_factor < 1,
    currentDelivery: delivery ? { id: delivery.id, code: delivery.code, trackingCode: delivery.tracking_code } : null
  };
}

function routeDTO(ctx, r) {
  const delivery = ctx.db.prepare('SELECT code, recipient_name, address FROM deliveries WHERE id = ?').get(r.delivery_id);
  const baseName = (id) => (id ? ctx.db.prepare('SELECT name FROM bases WHERE id = ?').get(id)?.name ?? null : null);
  return {
    id: r.id,
    deliveryId: r.delivery_id,
    deliveryCode: delivery?.code ?? null,
    recipientName: delivery?.recipient_name ?? null,
    address: delivery?.address ?? null,
    status: r.status,
    statusLabel: LABELS.route[r.status],
    originBase: r.origin_base_id ? { id: r.origin_base_id, name: baseName(r.origin_base_id) } : null,
    returnBase: r.return_base_id ? { id: r.return_base_id, name: baseName(r.return_base_id) } : null,
    outboundKm: round(r.outbound_km, 2),
    returnKm: round(r.return_km, 2),
    distanceKm: round(r.outbound_km + r.return_km, 2),
    estimatedMinutes: Math.round(r.estimated_minutes),
    createdAt: r.created_at,
    startedAt: r.started_at,
    completedAt: r.completed_at
  };
}

const FLIGHT_SELECT = `
  SELECT f.*, dr.code AS drone_code, d.code AS delivery_code, d.neighborhood AS region, d.address AS delivery_address,
         ob.name AS origin_base_name, rb.name AS return_base_name
  FROM flights f
  JOIN drones dr ON dr.id = f.drone_id
  LEFT JOIN deliveries d ON d.id = f.delivery_id
  LEFT JOIN bases ob ON ob.id = f.origin_base_id
  LEFT JOIN bases rb ON rb.id = f.return_base_id`;

function flightDTO(f) {
  return {
    id: f.id,
    code: f.code,
    droneCode: f.drone_code,
    deliveryCode: f.delivery_code,
    region: f.region,
    originBase: f.origin_base_id ? { id: f.origin_base_id, name: f.origin_base_name } : null,
    returnBase: f.return_base_id ? { id: f.return_base_id, name: f.return_base_name } : null,
    startedAt: f.started_at,
    endedAt: f.ended_at,
    distanceKm: round(f.distance_km, 2),
    status: f.status,
    statusLabel: LABELS.flight[f.status]
  };
}

const INCIDENT_SELECT = `
  SELECT i.*, d.code AS delivery_code, dr.code AS drone_code, b.name AS base_name, u.name AS created_by_name
  FROM incidents i
  LEFT JOIN deliveries d ON d.id = i.delivery_id
  LEFT JOIN drones dr ON dr.id = i.drone_id
  LEFT JOIN bases b ON b.id = i.base_id
  LEFT JOIN users u ON u.id = i.created_by`;

function incidentDTO(i) {
  return {
    id: i.id,
    code: i.code,
    category: i.category,
    categoryLabel: LABELS.category[i.category],
    description: i.description,
    priority: i.priority,
    priorityLabel: LABELS.priority[i.priority],
    status: i.status,
    statusLabel: LABELS.incident[i.status],
    source: i.source,
    deliveryCode: i.delivery_code,
    droneCode: i.drone_code,
    routeId: i.route_id,
    baseName: i.base_name,
    createdBy: i.created_by_name,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    resolvedAt: i.resolved_at
  };
}

module.exports = {
  DELIVERY_SELECT,
  FLIGHT_SELECT,
  INCIDENT_SELECT,
  isDelayed,
  deliveryDTO,
  baseDTO,
  droneDTO,
  routeDTO,
  flightDTO,
  incidentDTO
};
