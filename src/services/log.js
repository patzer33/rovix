const iso = () => new Date().toISOString();

/** Registra um evento de rastreamento (histórico da entrega). */
function addEvent(ctx, deliveryId, type, message, pos = null) {
  ctx.db
    .prepare(
      `INSERT INTO tracking_events (delivery_id, type, message, lat, lng, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(deliveryId, type, message, pos ? pos.lat : null, pos ? pos.lng : null, iso());
}

/** Avisa os clientes conectados (SSE) que uma entrega mudou. */
function publishDelivery(ctx, deliveryId) {
  const d = ctx.db
    .prepare('SELECT id, code, tracking_code, merchant_id, status FROM deliveries WHERE id = ?')
    .get(deliveryId);
  if (!d) return;
  ctx.hub.publish('delivery.updated', {
    deliveryId: d.id,
    code: d.code,
    trackingCode: d.tracking_code,
    merchantId: d.merchant_id,
    status: d.status
  });
}

module.exports = { iso, addEvent, publishDelivery };
