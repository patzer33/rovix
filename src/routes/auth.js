const express = require('express');
const bcrypt = require('bcryptjs');
const { wrap, reqString, oneOf, unauthorized, forbidden } = require('../lib/http');
const { ROLES } = require('../constants');
const { signToken, publicUser } = require('../middleware/auth');

module.exports = (ctx, auth) => {
  const router = express.Router();

  // Login com e-mail e senha.
  router.post(
    '/login',
    wrap((req, res) => {
      const email = reqString(req.body.email, 'email').toLowerCase();
      const password = reqString(req.body.password, 'password', { max: 100 });
      const user = ctx.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        throw unauthorized('E-mail ou senha incorretos.');
      }
      res.json({ token: signToken(ctx, user), user: publicUser(user) });
    })
  );

  // Entrada rápida por perfil, para a demonstração (o front não tem tela de login).
  // Pode ser desligada com DEMO_LOGIN=false.
  router.post(
    '/demo',
    wrap((req, res) => {
      if (!ctx.cfg.demoLogin) throw forbidden('Login de demonstração desativado.');
      const role = oneOf(req.body.role, Object.values(ROLES), 'role');
      const user = ctx.db.prepare('SELECT * FROM users WHERE role = ? ORDER BY id LIMIT 1').get(role);
      if (!user) throw unauthorized('Não há usuário cadastrado para este perfil.');
      res.json({ token: signToken(ctx, user), user: publicUser(user) });
    })
  );

  router.get('/me', auth.required(), (req, res) => res.json({ user: req.user }));

  return router;
};
