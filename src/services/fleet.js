const { haversineKm } = require('../lib/geo');

/** Drones estacionados (base_id preenchido) em uma base. */
function dockedCount(ctx, baseId, excludeDroneId = -1) {
  return ctx.db
    .prepare('SELECT COUNT(*) AS c FROM drones WHERE base_id = ? AND id != ?')
    .get(baseId, excludeDroneId).c;
}

/** Drones em voo de retorno cujo destino é esta base (vagas já "reservadas"). */
function inboundCount(ctx, baseId, excludeDroneId = -1) {
  return ctx.db
    .prepare(
      `SELECT COUNT(*) AS c FROM drones
       WHERE status = 'RETURNING' AND target_base_id = ? AND id != ?`
    )
    .get(baseId, excludeDroneId).c;
}

function freeSlots(ctx, base, selfDroneId = -1) {
  return base.capacity - dockedCount(ctx, base.id, selfDroneId) - inboundCount(ctx, base.id, selfDroneId);
}

/**
 * Escolhe a base de retorno: a mais próxima do ponto `from` que esteja ATIVA e com vaga.
 * Se todas as ativas estiverem cheias, usa a ativa mais próxima mesmo assim (sobrelotação
 * temporária é melhor do que deixar o drone sem pouso). Último recurso: qualquer base.
 */
function pickReturnBase(ctx, from, { selfDroneId = -1 } = {}) {
  const bases = ctx.db.prepare('SELECT * FROM bases').all();
  const byDistance = (list) =>
    list
      .map((b) => ({ base: b, dist: haversineKm(from, b) }))
      .sort((a, b) => a.dist - b.dist);

  const active = byDistance(bases.filter((b) => b.status === 'ACTIVE'));
  const withRoom = active.find((x) => freeSlots(ctx, x.base, selfDroneId) > 0);
  if (withRoom) return withRoom.base;
  if (active.length) return active[0].base;
  const any = byDistance(bases);
  return any.length ? any[0].base : null;
}

module.exports = { dockedCount, inboundCount, freeSlots, pickReturnBase };
