const express = require('express');
const { wrap, parsePaging, conflict } = require('../lib/http');
const { ROLES } = require('../constants');
const svc = require('../services/deliveries');
const { startDelivery, dispatchPending } = require('../services/dispatch');
const { routeDTO, flightDTO, FLIGHT_SELECT, deliveryDTO } = require('../services/presenters');

const { MERCHANT, OPERATOR, AUTHORITIES } = ROLES;

module.exports = (ctx, auth) => {
  const router = express.Router();

  // Lista (comerciante: só as dele; operador/autoridades: todas).
  // Filtros: ?status=PENDING_GROUP|IN_TRANSIT|DELIVERED|...  ?q=texto  ?priority=HIGH  ?delayed=true  ?hasIncident=true
  router.get(
    '/',
    auth.required([MERCHANT, OPERATOR, AUTHORITIES]),
    wrap((req, res) => {
      res.json(svc.listDeliveries(ctx, req.user, req.query, parsePaging(req.query)));
    })
  );

  // Indicadores dos cards de topo.
  router.get(
    '/stats',
    auth.required([MERCHANT, OPERATOR, AUTHORITIES]),
    wrap((req, res) => res.json(svc.deliveryStats(ctx, req.user)))
  );

  // Comerciante cadastra uma nova entrega (já tenta atribuir drone e base).
  router.post(
    '/',
    auth.required([MERCHANT]),
    wrap((req, res) => {
      const delivery = svc.createDelivery(ctx, req.user, req.body || {});
      res.status(201).json(deliveryDTO(ctx, delivery));
    })
  );

  // Detalhe completo: entrega + rota atual + voo + histórico de eventos.
  router.get(
    '/:ref',
    auth.required([MERCHANT, OPERATOR, AUTHORITIES]),
    wrap((req, res) => {
      const row = svc.findDelivery(ctx, req.params.ref);
      svc.assertCanView(req.user, row);
      const route = ctx.db
        .prepare(`SELECT * FROM routes WHERE delivery_id = ? AND status != 'CANCELLED' ORDER BY id DESC LIMIT 1`)
        .get(row.id);
      const flight = ctx.db.prepare(`${FLIGHT_SELECT} WHERE f.delivery_id = ? ORDER BY f.id DESC LIMIT 1`).get(row.id);
      const events = ctx.db
        .prepare('SELECT type, message, lat, lng, created_at FROM tracking_events WHERE delivery_id = ? ORDER BY id DESC')
        .all(row.id)
        .map((e) => ({ type: e.type, message: e.message, lat: e.lat, lng: e.lng, createdAt: e.created_at }));
      res.json({
        ...deliveryDTO(ctx, row),
        route: route ? routeDTO(ctx, route) : null,
        flight: flight ? flightDTO(flight) : null,
        events
      });
    })
  );

  // Operador manda o drone atribuído decolar (PREPARING -> IN_TRANSIT).
  router.post(
    '/:ref/start',
    auth.required([OPERATOR]),
    wrap((req, res) => {
      const row = svc.findDelivery(ctx, req.params.ref);
      ctx.db.transaction(() => startDelivery(ctx, row.id))();
      res.json(deliveryDTO(ctx, svc.findDelivery(ctx, row.id)));
    })
  );

  // Cancelamento: comerciante (própria, antes de decolar) ou operador (inclusive em voo).
  router.post(
    '/:ref/cancel',
    auth.required([MERCHANT, OPERATOR]),
    wrap((req, res) => {
      const updated = svc.cancelDelivery(ctx, req.user, req.params.ref, req.body && req.body.reason);
      ctx.db.transaction(() => dispatchPending(ctx))(); // drone liberado pode atender a fila
      res.json(deliveryDTO(ctx, updated));
    })
  );

  // Histórico de eventos da entrega.
  router.get(
    '/:ref/events',
    auth.required([MERCHANT, OPERATOR, AUTHORITIES]),
    wrap((req, res) => {
      const row = svc.findDelivery(ctx, req.params.ref);
      svc.assertCanView(req.user, row);
      const events = ctx.db
        .prepare('SELECT type, message, lat, lng, created_at FROM tracking_events WHERE delivery_id = ? ORDER BY id DESC')
        .all(row.id)
        .map((e) => ({ type: e.type, message: e.message, lat: e.lat, lng: e.lng, createdAt: e.created_at }));
      res.json({ data: events });
    })
  );

  return router;
};
