const { pseudoGeocode } = require('../lib/geo');
const { deliveryCode, trackingCode } = require('../lib/codes');
const {
  badRequest,
  notFound,
  forbidden,
  conflict,
  reqString,
  optString,
  oneOf,
  reqNumber
} = require('../lib/http');
const { PRIORITIES } = require('../constants');
const { iso, addEvent, publishDelivery } = require('./log');
const { dispatchPending } = require('./dispatch');
const { abortFlight, cancelBeforeFlight } = require('./flightops');
const { DELIVERY_SELECT, deliveryDTO } = require('./presenters');

// Atalhos de status aceitos no filtro (o front usa "Pendentes / Em andamento / Concluídos").
const STATUS_GROUPS = {
  PENDING_GROUP: ['PENDING', 'PREPARING'],
  PENDING: ['PENDING'],
  PREPARING: ['PREPARING'],
  IN_TRANSIT: ['IN_TRANSIT'],
  IN_PROGRESS: ['IN_TRANSIT'],
  DELIVERED: ['DELIVERED'],
  COMPLETED: ['DELIVERED'],
  CANCELLED: ['CANCELLED']
};

/** Aceita id numérico, código da entrega (RV-2049 / #RV-2049) ou código de rastreamento. */
function findDelivery(ctx, ref) {
  const clean = String(ref).trim().replace(/^#/, '').toUpperCase();
  let row;
  if (/^\d+$/.test(clean)) row = ctx.db.prepare(`${DELIVERY_SELECT} WHERE d.id = ?`).get(Number(clean));
  else row = ctx.db.prepare(`${DELIVERY_SELECT} WHERE d.code = ? OR d.tracking_code = ?`).get(clean, clean);
  if (!row) throw notFound('Entrega não encontrada.');
  return row;
}

/** Garante que o usuário pode ver essa entrega (comerciante só vê as próprias). */
function assertCanView(user, row) {
  if (user.role === 'MERCHANT' && row.merchant_id !== user.id) throw forbidden('Esta entrega pertence a outro comerciante.');
}

function createDelivery(ctx, user, body) {
  const recipientName = reqString(body.recipientName ?? body.recipient, 'recipientName', { min: 2, max: 120 });
  const address = reqString(body.address, 'address', { min: 5, max: 200 });
  const neighborhood = optString(body.neighborhood, 'neighborhood', { max: 100 });

  // aceita "normal"/"high" (valores do select do front) ou NORMAL/HIGH
  const priority = oneOf(body.priority ?? 'NORMAL', PRIORITIES, 'priority');

  // Destino: coordenadas informadas ou geocodificação simulada a partir do endereço.
  let dest;
  const given = body.destination;
  if (given && (given.lat !== undefined || given.lng !== undefined)) {
    dest = {
      lat: reqNumber(given.lat, 'destination.lat', { min: -90, max: 90 }),
      lng: reqNumber(given.lng, 'destination.lng', { min: -180, max: 180 })
    };
  } else {
    const key = neighborhood ? `${address} ${neighborhood}` : address;
    dest = pseudoGeocode(key, ctx.cfg.city.center, ctx.cfg.city.radiusKm);
  }

  const run = ctx.db.transaction(() => {
    const code = deliveryCode(ctx.db);
    const tCode = trackingCode(ctx.db, code);
    const now = iso();
    const info = ctx.db
      .prepare(
        `INSERT INTO deliveries (code, tracking_code, merchant_id, recipient_name, address, neighborhood,
                                 dest_lat, dest_lng, priority, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`
      )
      .run(code, tCode, user.id, recipientName, address, neighborhood, dest.lat, dest.lng, priority, now, now);
    const id = info.lastInsertRowid;
    addEvent(ctx, id, 'CREATED', 'Pedido recebido e confirmado.');
    publishDelivery(ctx, id);
    dispatchPending(ctx); // tenta atribuir drone/base já na criação
    return id;
  });
  return findDelivery(ctx, run());
}

function cancelDelivery(ctx, user, ref, reason) {
  const row = findDelivery(ctx, ref);
  assertCanView(user, row);
  const why = (reason && String(reason).trim().slice(0, 200)) || (user.role === 'MERCHANT' ? 'cancelada pelo comerciante' : 'cancelada pelo operador');

  if (['DELIVERED', 'CANCELLED'].includes(row.status)) {
    throw conflict(`Não é possível cancelar uma entrega ${row.status === 'DELIVERED' ? 'já concluída' : 'já cancelada'}.`);
  }
  ctx.db.transaction(() => {
    if (row.status === 'IN_TRANSIT') {
      if (user.role !== 'OPERATOR') {
        throw forbidden('Entrega em voo só pode ser cancelada pelo operador.');
      }
      const drone = ctx.db.prepare('SELECT * FROM drones WHERE id = ?').get(row.drone_id);
      abortFlight(ctx, drone, why, { requeue: false });
    } else {
      cancelBeforeFlight(ctx, row, why);
    }
  })();
  return findDelivery(ctx, row.id);
}

/** Lista com filtros e paginação. O escopo do comerciante é aplicado aqui. */
function listDeliveries(ctx, user, query, paging) {
  const where = [];
  const params = [];

  if (user.role === 'MERCHANT') {
    where.push('d.merchant_id = ?');
    params.push(user.id);
  }

  if (query.status) {
    const wanted = String(query.status)
      .split(',')
      .flatMap((s) => {
        const key = s.trim().toUpperCase();
        if (!STATUS_GROUPS[key]) throw badRequest(`Status inválido: ${s}.`);
        return STATUS_GROUPS[key];
      });
    where.push(`d.status IN (${wanted.map(() => '?').join(',')})`);
    params.push(...wanted);
  }
  if (query.priority) {
    where.push('d.priority = ?');
    params.push(oneOf(query.priority, PRIORITIES, 'priority'));
  }
  if (query.q) {
    const like = `%${String(query.q).trim().replace(/^#/, '')}%`;
    where.push(`(d.code LIKE ? OR d.tracking_code LIKE ? OR d.recipient_name LIKE ? OR d.address LIKE ? OR d.neighborhood LIKE ?)`);
    params.push(like, like, like, like, like);
  }
  if (query.hasIncident === 'true') {
    where.push(`EXISTS (SELECT 1 FROM incidents i WHERE i.delivery_id = d.id AND i.status != 'RESOLVED')`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderSql = 'ORDER BY d.created_at DESC, d.id DESC';

  let rows = ctx.db.prepare(`${DELIVERY_SELECT} ${whereSql} ${orderSql}`).all(...params);
  let dtos = rows.map((r) => deliveryDTO(ctx, r));

  // "atrasada" é calculado (depende do relógio), então filtramos depois.
  if (query.delayed === 'true') dtos = dtos.filter((d) => d.isDelayed);

  const total = dtos.length;
  return { data: dtos.slice(paging.offset, paging.offset + paging.pageSize), page: paging.page, pageSize: paging.pageSize, total };
}

/** Indicadores dos cards de topo (mesma lógica do front: pendentes / em andamento / concluídos). */
function deliveryStats(ctx, user) {
  const scope = user.role === 'MERCHANT' ? 'WHERE d.merchant_id = ?' : '';
  const params = user.role === 'MERCHANT' ? [user.id] : [];
  const rows = ctx.db.prepare(`${DELIVERY_SELECT} ${scope}`).all(...params);

  const stats = { total: rows.length, pending: 0, awaitingDrone: 0, preparing: 0, inProgress: 0, completed: 0, cancelled: 0, delayed: 0, withIncident: 0 };
  for (const r of rows) {
    if (r.status === 'PENDING') { stats.pending++; stats.awaitingDrone++; }
    if (r.status === 'PREPARING') { stats.pending++; stats.preparing++; }
    if (r.status === 'IN_TRANSIT') stats.inProgress++;
    if (r.status === 'DELIVERED') stats.completed++;
    if (r.status === 'CANCELLED') stats.cancelled++;
    if (deliveryDTO(ctx, r).isDelayed) stats.delayed++;
    if (r.open_incidents > 0) stats.withIncident++;
  }
  return stats;
}

module.exports = { findDelivery, assertCanView, createDelivery, cancelDelivery, listDeliveries, deliveryStats };
