/** Drones e bases. */
const express = require('express');
const { wrap, notFound, badRequest, conflict, reqString, reqNumber, oneOf, optString } = require('../lib/http');
const { ROLES, BASE_STATUS } = require('../constants');
const { droneDTO, baseDTO } = require('../services/presenters');
const { freeSlots } = require('../services/fleet');
const { dispatchPending } = require('../services/dispatch');

const { OPERATOR, AUTHORITIES, MERCHANT, CONSUMER } = ROLES;

module.exports = (ctx, auth) => {
  const drones = express.Router();
  const bases = express.Router();

  // ---------------------------- DRONES ----------------------------

  const getDrone = (ref) => {
    const clean = String(ref).trim().toUpperCase();
    const row = /^\d+$/.test(clean)
      ? ctx.db.prepare('SELECT * FROM drones WHERE id = ?').get(Number(clean))
      : ctx.db.prepare('SELECT * FROM drones WHERE code = ?').get(clean);
    if (!row) throw notFound('Drone não encontrado.');
    return row;
  };

  drones.get(
    '/',
    auth.required([OPERATOR, AUTHORITIES]),
    wrap((req, res) => {
      const where = [];
      const params = [];
      if (req.query.status) {
        where.push('status = ?');
        params.push(oneOf(req.query.status, ['READY', 'DELIVERING', 'RETURNING', 'CHARGING'], 'status'));
      }
      const sql = `SELECT * FROM drones ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY code`;
      res.json({ data: ctx.db.prepare(sql).all(...params).map((d) => droneDTO(ctx, d)) });
    })
  );

  drones.get(
    '/:ref',
    auth.required([OPERATOR, AUTHORITIES]),
    wrap((req, res) => res.json(droneDTO(ctx, getDrone(req.params.ref))))
  );

  // Cadastra um drone novo, já estacionado em uma base.
  drones.post(
    '/',
    auth.required([OPERATOR]),
    wrap((req, res) => {
      const code = reqString(req.body.code, 'code', { min: 2, max: 20 }).toUpperCase();
      const model = optString(req.body.model, 'model', { max: 60 }) || 'ROVIX-S1';
      const baseId = reqNumber(req.body.baseId, 'baseId', { min: 1 });
      const base = ctx.db.prepare('SELECT * FROM bases WHERE id = ?').get(baseId);
      if (!base) throw badRequest('Base não encontrada.');
      if (base.status !== 'ACTIVE') throw conflict('A base informada está inativa.');
      if (freeSlots(ctx, base) <= 0) throw conflict('A base informada não tem vaga livre.');
      if (ctx.db.prepare('SELECT 1 FROM drones WHERE code = ?').get(code)) throw conflict('Já existe um drone com esse código.');

      const info = ctx.db
        .prepare(
          `INSERT INTO drones (code, model, status, battery, base_id, lat, lng, speed_kmh, created_at)
           VALUES (?, ?, 'READY', 100, ?, ?, ?, ?, ?)`
        )
        .run(code, model, base.id, base.lat, base.lng, ctx.cfg.drone.defaultSpeedKmh, new Date().toISOString());
      ctx.db.transaction(() => dispatchPending(ctx))();
      res.status(201).json(droneDTO(ctx, ctx.db.prepare('SELECT * FROM drones WHERE id = ?').get(info.lastInsertRowid)));
    })
  );

  // Atualização operacional: só com o drone estacionado (não dá para mexer em drone voando).
  // Campos: status (READY|CHARGING), battery (0-100), baseId (mover de base).
  drones.patch(
    '/:ref',
    auth.required([OPERATOR]),
    wrap((req, res) => {
      const drone = getDrone(req.params.ref);
      if (!drone.base_id || drone.flight_id) throw conflict('Só é possível alterar drones estacionados em uma base.');
      const busy = ctx.db
        .prepare(`SELECT 1 FROM deliveries WHERE drone_id = ? AND status IN ('PREPARING','IN_TRANSIT')`)
        .get(drone.id);

      const fields = [];
      const params = [];
      if (req.body.status !== undefined) {
        const status = oneOf(req.body.status, ['READY', 'CHARGING'], 'status');
        if (busy) throw conflict('O drone tem uma entrega atribuída; cancele-a antes de mudar o status.');
        fields.push('status = ?');
        params.push(status);
      }
      if (req.body.battery !== undefined) {
        fields.push('battery = ?');
        params.push(reqNumber(req.body.battery, 'battery', { min: 0, max: 100 }));
      }
      if (req.body.baseId !== undefined) {
        if (busy) throw conflict('O drone tem uma entrega atribuída; não pode trocar de base agora.');
        const base = ctx.db.prepare('SELECT * FROM bases WHERE id = ?').get(reqNumber(req.body.baseId, 'baseId', { min: 1 }));
        if (!base) throw badRequest('Base não encontrada.');
        if (base.status !== 'ACTIVE') throw conflict('A base de destino está inativa.');
        if (base.id !== drone.base_id && freeSlots(ctx, base) <= 0) throw conflict('A base de destino não tem vaga livre.');
        fields.push('base_id = ?', 'lat = ?', 'lng = ?');
        params.push(base.id, base.lat, base.lng);
      }
      if (!fields.length) throw badRequest('Informe ao menos um campo: status, battery ou baseId.');

      ctx.db.prepare(`UPDATE drones SET ${fields.join(', ')} WHERE id = ?`).run(...params, drone.id);
      ctx.db.transaction(() => dispatchPending(ctx))();
      ctx.hub.publish('drone.updated', { droneId: drone.id });
      res.json(droneDTO(ctx, ctx.db.prepare('SELECT * FROM drones WHERE id = ?').get(drone.id)));
    })
  );

  // ----------------------------- BASES -----------------------------

  const getBase = (id) => {
    const row = ctx.db.prepare('SELECT * FROM bases WHERE id = ?').get(Number(id));
    if (!row) throw notFound('Base não encontrada.');
    return row;
  };

  bases.get(
    '/',
    auth.required([OPERATOR, AUTHORITIES, MERCHANT, CONSUMER]),
    wrap((req, res) => {
      res.json({ data: ctx.db.prepare('SELECT * FROM bases ORDER BY id').all().map((b) => baseDTO(ctx, b)) });
    })
  );

  bases.get(
    '/:id',
    auth.required([OPERATOR, AUTHORITIES]),
    wrap((req, res) => res.json(baseDTO(ctx, getBase(req.params.id))))
  );

  bases.post(
    '/',
    auth.required([OPERATOR]),
    wrap((req, res) => {
      const name = reqString(req.body.name, 'name', { min: 2, max: 80 });
      const lat = reqNumber(req.body.lat, 'lat', { min: -90, max: 90 });
      const lng = reqNumber(req.body.lng, 'lng', { min: -180, max: 180 });
      const capacity = reqNumber(req.body.capacity ?? 3, 'capacity', { min: 1, max: 50 });
      const info = ctx.db
        .prepare(`INSERT INTO bases (name, lat, lng, capacity, status, created_at) VALUES (?, ?, ?, ?, 'ACTIVE', ?)`)
        .run(name, lat, lng, Math.round(capacity), new Date().toISOString());
      ctx.hub.publish('base.updated', { baseId: info.lastInsertRowid });
      res.status(201).json(baseDTO(ctx, getBase(info.lastInsertRowid)));
    })
  );

  // Ativar/desativar base e ajustar capacidade.
  // Base inativa não recebe novos despachos e os drones que voltavam para ela são redirecionados.
  bases.patch(
    '/:id',
    auth.required([OPERATOR]),
    wrap((req, res) => {
      const base = getBase(req.params.id);
      const fields = [];
      const params = [];
      if (req.body.status !== undefined) {
        fields.push('status = ?');
        params.push(oneOf(req.body.status, BASE_STATUS, 'status'));
      }
      if (req.body.capacity !== undefined) {
        const capacity = Math.round(reqNumber(req.body.capacity, 'capacity', { min: 1, max: 50 }));
        const docked = ctx.db.prepare('SELECT COUNT(*) AS c FROM drones WHERE base_id = ?').get(base.id).c;
        if (capacity < docked) throw conflict(`Há ${docked} drones estacionados nesta base; a capacidade não pode ser menor.`);
        fields.push('capacity = ?');
        params.push(capacity);
      }
      if (req.body.name !== undefined) {
        fields.push('name = ?');
        params.push(reqString(req.body.name, 'name', { min: 2, max: 80 }));
      }
      if (!fields.length) throw badRequest('Informe ao menos um campo: status, capacity ou name.');

      ctx.db.prepare(`UPDATE bases SET ${fields.join(', ')} WHERE id = ?`).run(...params, base.id);
      ctx.db.transaction(() => dispatchPending(ctx))();
      ctx.hub.publish('base.updated', { baseId: base.id });
      res.json(baseDTO(ctx, getBase(base.id)));
    })
  );

  return { drones, bases };
};
