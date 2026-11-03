/**
 * Rastreamento público (perfil CONSUMIDOR): consulta por código, sem login.
 * Tudo é simulado: posição, progresso e previsão vêm do motor de simulação.
 */
const { LABELS } = require('../constants');
const { round } = require('../lib/geo');
const { DELIVERY_SELECT } = require('./presenters');

// Eventos que o consumidor pode ver (os demais são internos da operação).
const PUBLIC_EVENT_TYPES = ['CREATED', 'WAITING', 'DRONE_ASSIGNED', 'DEPARTED', 'REQUEUED', 'DELIVERED', 'CANCELLED'];

const STEPS = [
  { key: 'RECEIVED', title: 'Pedido recebido', done: 'Pedido confirmado' },
  { key: 'PREPARED', title: 'Pedido preparado', done: 'Encomenda pronta' },
  { key: 'IN_ROUTE', title: 'Drone em rota', done: 'A caminho do destino' },
  { key: 'DELIVERED', title: 'Entrega concluída', done: 'Entregue ao destinatário' }
];

// índice da etapa "atual" por status da entrega
const CURRENT_STEP = { PENDING: 0, PREPARING: 1, IN_TRANSIT: 2, DELIVERED: 4, CANCELLED: -1 };

const PENDING_STEP_TEXT = ['Aguardando confirmação', 'Preparando a encomenda', 'Aguardando decolagem', 'Aguardando entrega'];

function buildTimeline(status, events) {
  const current = CURRENT_STEP[status];
  const stampFor = {
    RECEIVED: 'CREATED',
    PREPARED: 'DRONE_ASSIGNED',
    IN_ROUTE: 'DEPARTED',
    DELIVERED: 'DELIVERED'
  };
  return STEPS.map((s, idx) => {
    let state = 'pending';
    if (status !== 'CANCELLED') {
      if (idx < current) state = 'complete';
      else if (idx === current) state = 'current';
    }
    // pega o horário da última ocorrência do evento correspondente
    const ev = [...events].reverse().find((e) => e.type === stampFor[s.key]);
    return {
      key: s.key,
      title: s.title,
      description: state === 'pending' ? PENDING_STEP_TEXT[idx] : s.done,
      state,
      at: state === 'pending' ? null : ev ? ev.createdAt : null
    };
  });
}

function getTracking(ctx, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  const row = ctx.db.prepare(`${DELIVERY_SELECT} WHERE d.tracking_code = ?`).get(code);
  if (!row) return null;
  const { db } = ctx;

  const route = db
    .prepare(`SELECT * FROM routes WHERE delivery_id = ? AND status != 'CANCELLED' ORDER BY id DESC LIMIT 1`)
    .get(row.id);
  const flight = db.prepare('SELECT * FROM flights WHERE delivery_id = ? ORDER BY id DESC LIMIT 1').get(row.id);
  const drone = row.drone_id ? db.prepare('SELECT * FROM drones WHERE id = ?').get(row.drone_id) : null;
  const origin = row.origin_base_id ? db.prepare('SELECT * FROM bases WHERE id = ?').get(row.origin_base_id) : null;

  const dest = { lat: row.dest_lat, lng: row.dest_lng };
  const speedKmh = drone ? drone.speed_kmh * drone.speed_factor : ctx.cfg.drone.defaultSpeedKmh;

  // posição e progresso (0..1) do trecho de ida
  let dronePosition = null;
  let progress = 0;
  let remainingKm = null;
  if (row.status === 'IN_TRANSIT' && drone && route) {
    dronePosition = { lat: drone.lat, lng: drone.lng };
    const flown = flight ? flight.distance_km : 0;
    progress = Math.max(0, Math.min(1, flown / route.outbound_km));
    remainingKm = Math.max(0, route.outbound_km - flown);
  } else if (row.status === 'PREPARING' && origin) {
    dronePosition = { lat: origin.lat, lng: origin.lng };
    remainingKm = route ? route.outbound_km : null;
  } else if (row.status === 'DELIVERED') {
    progress = 1;
    remainingKm = 0;
  }

  // previsão (tempo da demo: considera o multiplicador de simulação)
  let eta = null;
  let etaSeconds = null;
  let estimatedMinutes = null;
  if (remainingKm !== null && row.status !== 'DELIVERED') {
    const flightSeconds = ((remainingKm / speedKmh) * 3600) / ctx.sim.speed;
    const waitSeconds =
      row.status === 'PREPARING' && row.ready_at ? Math.max(0, (Date.parse(row.ready_at) - Date.now()) / 1000) : 0;
    etaSeconds = Math.round(flightSeconds + waitSeconds);
    eta = new Date(Date.now() + etaSeconds * 1000).toISOString();
    estimatedMinutes = Math.max(1, Math.round((remainingKm / speedKmh) * 60)); // "tempo real" de um voo de verdade
  }

  const allEvents = db
    .prepare('SELECT * FROM tracking_events WHERE delivery_id = ? ORDER BY id ASC')
    .all(row.id)
    .map((e) => ({ type: e.type, message: e.message, createdAt: e.created_at }));
  const publicEvents = allEvents.filter((e) => PUBLIC_EVENT_TYPES.includes(e.type));

  return {
    trackingCode: row.tracking_code,
    deliveryCode: row.code,
    status: row.status,
    statusLabel: LABELS.delivery[row.status],
    currentStep: row.status === 'CANCELLED' ? null : STEPS[Math.min(CURRENT_STEP[row.status], 3)].title,
    isDelayed: row.status === 'IN_TRANSIT' && row.planned_eta_at ? Date.now() > Date.parse(row.planned_eta_at) : false,
    recipientName: row.recipient_name,
    address: row.address,
    neighborhood: row.neighborhood,
    priority: row.priority,
    priorityLabel: LABELS.priority[row.priority],
    cancelReason: row.cancel_reason,
    eta,
    etaSeconds,
    estimatedMinutes,
    progress: round(progress, 3),
    origin: origin ? { name: origin.name, lat: origin.lat, lng: origin.lng } : null,
    destination: dest,
    dronePosition,
    droneCode: drone ? drone.code : null,
    timeline: buildTimeline(row.status, allEvents.map((e) => ({ ...e }))),
    events: publicEvents.reverse(),
    simulated: true,
    disclaimer: 'Demonstração acadêmica: posição, progresso e horários são simulados, sem GPS nem drones reais.'
  };
}

module.exports = { getTracking };
