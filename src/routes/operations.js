/** Rotas, voos, ocorrências, simulação, resumo geral e stream de eventos. */
const express = require('express');
const {
  wrap,
  notFound,
  badRequest,
  conflict,
  parsePaging,
  oneOf,
  reqString,
  reqNumber
} = require('../lib/http');
const { ROLES, INCIDENT_CATEGORIES, INCIDENT_STATUS, FLIGHT_STATUS, ROUTE_STATUS, PRIORITIES } = require('../constants');
const {
  routeDTO,
  flightDTO,
  incidentDTO,
  FLIGHT_SELECT,
  INCIDENT_SELECT,
  DELIVERY_SELECT,
  deliveryDTO
} = require('../services/presenters');
const { raiseIncident } = require('../services/incidents');
const { step } = require('../services/simulation');
const { deliveryStats } = require('../services/deliveries');
const { iso } = require('../services/log');

const { OPERATOR, AUTHORITIES, MERCHANT } = ROLES;

module.exports = (ctx, auth) => {
  const routes = express.Router();
  const flights = express.Router();
  const incidents = express.Router();
  const simulation = express.Router();
  const misc = express.Router();

  // ----------------------------- ROTAS -----------------------------

  // Resumo das rotas ativas (cards "Distância estimada / Tempo estimado / Paradas" do operador).
  routes.get(
    '/active/summary',
    auth.required([OPERATOR, AUTHORITIES]),
    wrap((req, res) => {
      const rows = ctx.db
        .prepare(
          `SELECT r.*, d.code AS delivery_code, d.recipient_name, d.address, d.status AS delivery_status, d.priority
           FROM routes r JOIN deliveries d ON d.id = r.delivery_id
           WHERE r.status IN ('PLANNED','IN_PROGRESS')
           ORDER BY (d.priority = 'HIGH') DESC, r.id ASC`
        )
        .all();
      const distance = rows.reduce((s, r) => s + r.outbound_km + r.return_km, 0);
      const minutes = rows.reduce((s, r) => s + r.estimated_minutes, 0);
      res.json({
        totalDistanceKm: Math.round(distance * 10) / 10,
        estimatedMinutes: Math.round(minutes),
        stopsCount: rows.length,
        stops: rows.map((r, i) => ({
          order: i + 1,
          deliveryCode: r.delivery_code,
          recipientName: r.recipient_name,
          address: r.address,
          deliveryStatus: r.delivery_status,
          routeStatus: r.status
        })),
        routes: rows.map((r) => routeDTO(ctx, r))
      });
    })
  );

  routes.get(
    '/',
    auth.required([OPERATOR, AUTHORITIES]),
    wrap((req, res) => {
      const paging = parsePaging(req.query);
      const where = [];
      const params = [];
      if (req.query.status) {
        where.push('status = ?');
        params.push(oneOf(req.query.status, ROUTE_STATUS, 'status'));
      }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = ctx.db.prepare(`SELECT COUNT(*) AS c FROM routes ${w}`).get(...params).c;
      const rows = ctx.db
        .prepare(`SELECT * FROM routes ${w} ORDER BY id DESC LIMIT ? OFFSET ?`)
        .all(...params, paging.pageSize, paging.offset);
      res.json({ data: rows.map((r) => routeDTO(ctx, r)), page: paging.page, pageSize: paging.pageSize, total });
    })
  );

  routes.get(
    '/:id',
    auth.required([OPERATOR, AUTHORITIES]),
    wrap((req, res) => {
      const row = ctx.db.prepare('SELECT * FROM routes WHERE id = ?').get(Number(req.params.id));
      if (!row) throw notFound('Rota não encontrada.');
      res.json(routeDTO(ctx, row));
    })
  );

  // ----------------------------- VOOS ------------------------------

  flights.get(
    '/',
    auth.required([OPERATOR, AUTHORITIES]),
    wrap((req, res) => {
      const paging = parsePaging(req.query);
      const where = [];
      const params = [];
      if (req.query.status) {
        where.push('f.status = ?');
        params.push(oneOf(req.query.status, FLIGHT_STATUS, 'status'));
      }
      if (req.query.q) {
        const like = `%${String(req.query.q).trim()}%`;
        where.push('(f.code LIKE ? OR d.code LIKE ? OR dr.code LIKE ? OR d.neighborhood LIKE ?)');
        params.push(like, like, like, like);
      }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = ctx.db
        .prepare(
          `SELECT COUNT(*) AS c FROM flights f JOIN drones dr ON dr.id = f.drone_id
           LEFT JOIN deliveries d ON d.id = f.delivery_id ${w}`
        )
        .get(...params).c;
      const rows = ctx.db
        .prepare(`${FLIGHT_SELECT} ${w} ORDER BY f.id DESC LIMIT ? OFFSET ?`)
        .all(...params, paging.pageSize, paging.offset);
      res.json({ data: rows.map(flightDTO), page: paging.page, pageSize: paging.pageSize, total });
    })
  );

  flights.get(
    '/:id',
    auth.required([OPERATOR, AUTHORITIES]),
    wrap((req, res) => {
      const row = ctx.db.prepare(`${FLIGHT_SELECT} WHERE f.id = ? OR f.code = ?`).get(Number(req.params.id) || -1, String(req.params.id).toUpperCase());
      if (!row) throw notFound('Voo não encontrado.');
      res.json(flightDTO(row));
    })
  );

  // -------------------------- OCORRÊNCIAS --------------------------

  const findIncident = (ref) => {
    const clean = String(ref).trim().toUpperCase();
    const row = /^\d+$/.test(clean)
      ? ctx.db.prepare(`${INCIDENT_SELECT} WHERE i.id = ?`).get(Number(clean))
      : ctx.db.prepare(`${INCIDENT_SELECT} WHERE i.code = ?`).get(clean);
    if (!row) throw notFound('Ocorrência não encontrada.');
    return row;
  };

  incidents.get(
    '/',
    auth.required([OPERATOR, AUTHORITIES]),
    wrap((req, res) => {
      const paging = parsePaging(req.query);
      const where = [];
      const params = [];
      if (req.query.status) {
        where.push('i.status = ?');
        params.push(oneOf(req.query.status, INCIDENT_STATUS, 'status'));
      }
      if (req.query.category) {
        where.push('i.category = ?');
        params.push(oneOf(req.query.category, INCIDENT_CATEGORIES, 'category'));
      }
      if (req.query.priority) {
        where.push('i.priority = ?');
        params.push(oneOf(req.query.priority, PRIORITIES, 'priority'));
      }
      if (req.query.q) {
        const like = `%${String(req.query.q).trim()}%`;
        where.push('(i.code LIKE ? OR i.description LIKE ? OR d.code LIKE ? OR dr.code LIKE ?)');
        params.push(like, like, like, like);
      }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = ctx.db
        .prepare(
          `SELECT COUNT(*) AS c FROM incidents i
           LEFT JOIN deliveries d ON d.id = i.delivery_id LEFT JOIN drones dr ON dr.id = i.drone_id ${w}`
        )
        .get(...params).c;
      const rows = ctx.db
        .prepare(`${INCIDENT_SELECT} ${w} ORDER BY i.id DESC LIMIT ? OFFSET ?`)
        .all(...params, paging.pageSize, paging.offset);
      res.json({ data: rows.map(incidentDTO), page: paging.page, pageSize: paging.pageSize, total });
    })
  );

  incidents.get('/:ref', auth.required([OPERATOR, AUTHORITIES]), wrap((req, res) => res.json(incidentDTO(findIncident(req.params.ref)))));

  // Autoridade registra uma ocorrência manualmente (não altera a operação, só registra).
  // Vínculos opcionais: deliveryCode, droneCode, baseId.
  incidents.post(
    '/',
    auth.required([AUTHORITIES]),
    wrap((req, res) => {
      const category = oneOf(req.body.category, INCIDENT_CATEGORIES, 'category');
      const description = reqString(req.body.description, 'description', { min: 5, max: 500 });
      const priority = req.body.priority ? oneOf(req.body.priority, PRIORITIES, 'priority') : undefined;

      let deliveryId = null;
      let droneId = null;
      let baseId = null;
      if (req.body.deliveryCode) {
        const d = ctx.db.prepare('SELECT id FROM deliveries WHERE code = ?').get(String(req.body.deliveryCode).replace(/^#/, '').toUpperCase());
        if (!d) throw badRequest('Entrega informada não existe.');
        deliveryId = d.id;
      }
      if (req.body.droneCode) {
        const d = ctx.db.prepare('SELECT id FROM drones WHERE code = ?').get(String(req.body.droneCode).toUpperCase());
        if (!d) throw badRequest('Drone informado não existe.');
        droneId = d.id;
      }
      if (req.body.baseId) {
        const b = ctx.db.prepare('SELECT id FROM bases WHERE id = ?').get(Number(req.body.baseId));
        if (!b) throw badRequest('Base informada não existe.');
        baseId = b.id;
      }

      const created = ctx.db.transaction(() =>
        raiseIncident(
          ctx,
          { category, description, priority, deliveryId, droneId, baseId, source: 'MANUAL', createdBy: req.user.id },
          { applyEffect: false }
        )
      )();
      res.status(201).json(incidentDTO(findIncident(created.id)));
    })
  );

  // Acompanhamento: OPEN -> UNDER_REVIEW -> RESOLVED (também é possível reabrir).
  incidents.patch(
    '/:ref',
    auth.required([AUTHORITIES]),
    wrap((req, res) => {
      const inc = findIncident(req.params.ref);
      const fields = [];
      const params = [];
      if (req.body.status !== undefined) {
        const status = oneOf(req.body.status, INCIDENT_STATUS, 'status');
        fields.push('status = ?', 'resolved_at = ?');
        params.push(status, status === 'RESOLVED' ? iso() : null);
      }
      if (req.body.priority !== undefined) {
        fields.push('priority = ?');
        params.push(oneOf(req.body.priority, PRIORITIES, 'priority'));
      }
      if (req.body.description !== undefined) {
        fields.push('description = ?');
        params.push(reqString(req.body.description, 'description', { min: 5, max: 500 }));
      }
      if (!fields.length) throw badRequest('Informe ao menos um campo: status, priority ou description.');
      ctx.db.prepare(`UPDATE incidents SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`).run(...params, iso(), inc.id);
      ctx.hub.publish('incident.updated', { incidentId: inc.id, code: inc.code });
      res.json(incidentDTO(findIncident(inc.id)));
    })
  );

  // --------------------------- SIMULAÇÃO ---------------------------

  const simState = () => ({
    enabled: ctx.cfg.sim.enabled,
    running: ctx.sim.running && !ctx.sim.paused,
    paused: ctx.sim.paused,
    speed: ctx.sim.speed,
    tickMs: ctx.cfg.sim.tickMs,
    autoStartDelayS: ctx.cfg.sim.autoStartDelayS,
    randomIncidentRate: ctx.cfg.sim.randomIncidentRate,
    city: ctx.cfg.city
  });

  simulation.get('/', auth.required([OPERATOR, AUTHORITIES]), (req, res) => res.json(simState()));

  simulation.post(
    '/speed',
    auth.required([OPERATOR]),
    wrap((req, res) => {
      ctx.sim.speed = reqNumber(req.body.speed, 'speed', { min: 1, max: 500 });
      res.json(simState());
    })
  );

  simulation.post('/pause', auth.required([OPERATOR]), (req, res) => {
    ctx.sim.paused = true;
    res.json(simState());
  });

  simulation.post('/resume', auth.required([OPERATOR]), (req, res) => {
    ctx.sim.paused = false;
    res.json(simState());
  });

  // Avança manualmente N segundos reais (útil com a simulação pausada, ou em testes).
  simulation.post(
    '/step',
    auth.required([OPERATOR]),
    wrap((req, res) => {
      const seconds = reqNumber(req.body.seconds ?? 1, 'seconds', { min: 0.1, max: 600 });
      step(ctx, seconds);
      res.json(simState());
    })
  );

  // Injeta uma ocorrência simulada (para demonstrar o módulo de fiscalização ao vivo).
  // Informe droneCode OU deliveryCode para o efeito operacional (clima = lento; falha técnica = aborta o voo).
  simulation.post(
    '/incidents',
    auth.required([OPERATOR, AUTHORITIES]),
    wrap((req, res) => {
      const category = oneOf(req.body.category, INCIDENT_CATEGORIES, 'category');
      let droneId = null;
      let deliveryId = null;
      if (req.body.droneCode) {
        const d = ctx.db.prepare('SELECT id FROM drones WHERE code = ?').get(String(req.body.droneCode).toUpperCase());
        if (!d) throw badRequest('Drone informado não existe.');
        droneId = d.id;
      }
      if (req.body.deliveryCode) {
        const d = ctx.db.prepare('SELECT id FROM deliveries WHERE code = ?').get(String(req.body.deliveryCode).replace(/^#/, '').toUpperCase());
        if (!d) throw badRequest('Entrega informada não existe.');
        deliveryId = d.id;
      }
      if (!droneId && !deliveryId) {
        // sem alvo: escolhe um drone que esteja em voo de entrega
        const flying = ctx.db.prepare(`SELECT id FROM drones WHERE status = 'DELIVERING' ORDER BY id LIMIT 1`).get();
        if (!flying) throw conflict('Não há nenhum drone em entrega agora. Informe droneCode ou deliveryCode.');
        droneId = flying.id;
      }
      const created = ctx.db.transaction(() =>
        raiseIncident(ctx, { category, droneId, deliveryId, source: 'AUTO', description: req.body.description }, { applyEffect: true })
      )();
      res.status(201).json(incidentDTO(findIncident(created.id)));
    })
  );

  // ------------------------- RESUMO / SSE --------------------------

  // Números dos cards de topo de cada painel.
  misc.get(
    '/overview',
    auth.required([MERCHANT, OPERATOR, AUTHORITIES]),
    wrap((req, res) => {
      const out = { deliveries: deliveryStats(ctx, req.user) };
      if (req.user.role !== MERCHANT) {
        const count = (sql, ...p) => ctx.db.prepare(sql).get(...p).c;
        out.flights = {
          total: count('SELECT COUNT(*) AS c FROM flights'),
          inProgress: count(`SELECT COUNT(*) AS c FROM flights WHERE status = 'IN_PROGRESS'`),
          completed: count(`SELECT COUNT(*) AS c FROM flights WHERE status = 'COMPLETED'`),
          interrupted: count(`SELECT COUNT(*) AS c FROM flights WHERE status = 'INTERRUPTED'`)
        };
        out.incidents = {
          total: count('SELECT COUNT(*) AS c FROM incidents'),
          open: count(`SELECT COUNT(*) AS c FROM incidents WHERE status = 'OPEN'`),
          underReview: count(`SELECT COUNT(*) AS c FROM incidents WHERE status = 'UNDER_REVIEW'`),
          resolved: count(`SELECT COUNT(*) AS c FROM incidents WHERE status = 'RESOLVED'`)
        };
        const byStatus = ctx.db.prepare('SELECT status, COUNT(*) AS c FROM drones GROUP BY status').all();
        out.drones = { total: byStatus.reduce((s, r) => s + r.c, 0), ready: 0, delivering: 0, returning: 0, charging: 0 };
        for (const r of byStatus) out.drones[r.status.toLowerCase()] = r.c;
        out.bases = {
          total: count('SELECT COUNT(*) AS c FROM bases'),
          active: count(`SELECT COUNT(*) AS c FROM bases WHERE status = 'ACTIVE'`)
        };
      }
      res.json(out);
    })
  );

  // Stream de eventos em tempo real (SSE). Como EventSource não envia headers,
  // o token vai na query: /api/events?token=JWT. Comerciantes só recebem eventos das próprias entregas.
  misc.get(
    '/events',
    auth.required([MERCHANT, OPERATOR, AUTHORITIES], { allowQueryToken: true }),
    (req, res) => {
      const user = req.user;
      ctx.hub.openStream(req, res, {
        hello: { user: { id: user.id, role: user.role } },
        filter: (e) => (user.role === 'MERCHANT' ? e.merchantId === user.id : true),
        transform: (e) => {
          const { merchantId, ...safe } = e; // não vaza ids internos
          return safe;
        }
      });
    }
  );

  return { routes, flights, incidents, simulation, misc };
};
