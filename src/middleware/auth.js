const jwt = require('jsonwebtoken');
const { unauthorized, forbidden } = require('../lib/http');

function signToken(ctx, user) {
  return jwt.sign({ sub: user.id, role: user.role }, ctx.cfg.jwtSecret, {
    expiresIn: ctx.cfg.jwtExpiresIn
  });
}

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role };
}

/**
 * required(['OPERATOR', ...]) exige login (e, se informado, um dos perfis).
 * Com allowQueryToken, aceita ?token=... (necessário para EventSource, que não envia headers).
 */
function makeAuth(ctx) {
  function required(roles = [], { allowQueryToken = false } = {}) {
    return (req, res, next) => {
      let token = null;
      const header = req.headers.authorization || '';
      if (header.startsWith('Bearer ')) token = header.slice(7).trim();
      else if (allowQueryToken && req.query.token) token = String(req.query.token);

      if (!token) return next(unauthorized('Faça login para continuar.'));

      let payload;
      try {
        payload = jwt.verify(token, ctx.cfg.jwtSecret);
      } catch {
        return next(unauthorized('Sessão inválida ou expirada. Faça login novamente.'));
      }

      const user = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
      if (!user) return next(unauthorized('Usuário não encontrado.'));

      req.user = publicUser(user);
      if (roles.length && !roles.includes(user.role)) return next(forbidden());
      next();
    };
  }
  return { required };
}

module.exports = { makeAuth, signToken, publicUser };
