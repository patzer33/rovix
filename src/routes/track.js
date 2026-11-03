const express = require('express');
const { wrap, notFound } = require('../lib/http');
const { getTracking } = require('../services/tracking');

/** Rastreamento PÚBLICO (perfil Consumidor): não exige login, só o código de rastreamento. */
module.exports = (ctx) => {
  const router = express.Router();

  router.get(
    '/:code',
    wrap((req, res) => {
      const tracking = getTracking(ctx, req.params.code);
      if (!tracking) throw notFound('Código de rastreamento não encontrado. Confira e tente novamente.');
      res.json(tracking);
    })
  );

  // Atualizações em tempo real (Server-Sent Events). Cada mudança dessa entrega envia o estado completo.
  router.get(
    '/:code/stream',
    wrap((req, res) => {
      const code = String(req.params.code).trim().toUpperCase();
      const initial = getTracking(ctx, code);
      if (!initial) throw notFound('Código de rastreamento não encontrado. Confira e tente novamente.');
      ctx.hub.openStream(req, res, {
        hello: initial,
        filter: (e) => e.trackingCode === code && ['delivery.updated', 'drone.moved'].includes(e.type),
        transform: () => getTracking(ctx, code)
      });
    })
  );

  return router;
};
