const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { HttpError } = require('./lib/http');
const { makeAuth } = require('./middleware/auth');

function createApp(ctx) {
  const app = express();
  const auth = makeAuth(ctx);

  app.disable('x-powered-by');
  app.use(cors()); // demo acadêmica: aceita qualquer origem (o front pode rodar em outra porta)
  app.use(express.json({ limit: '100kb' }));

  const api = express.Router();

  api.get('/health', (req, res) =>
    res.json({ status: 'ok', service: 'rovix-api', simulation: { speed: ctx.sim.speed, running: ctx.sim.running && !ctx.sim.paused } })
  );

  api.use('/auth', require('./routes/auth')(ctx, auth));
  api.use('/track', require('./routes/track')(ctx)); // público
  api.use('/deliveries', require('./routes/deliveries')(ctx, auth));

  const fleet = require('./routes/fleet')(ctx, auth);
  api.use('/drones', fleet.drones);
  api.use('/bases', fleet.bases);

  const ops = require('./routes/operations')(ctx, auth);
  api.use('/routes', ops.routes);
  api.use('/flights', ops.flights);
  api.use('/incidents', ops.incidents);
  api.use('/simulation', ops.simulation);
  api.use('/', ops.misc); // /overview e /events

  api.use((req, res) => res.status(404).json({ error: { message: 'Rota da API não encontrada.' } }));
  app.use('/api', api);

  // Serve o front (HTML/CSS/JS) pela mesma porta, se a pasta existir.
  const staticDir = ctx.cfg.staticDir;
  if (staticDir && fs.existsSync(path.join(staticDir, 'index.html'))) {
    // Se a pasta do front contém o próprio backend (backend/ dentro do repositório),
    // bloqueia esse caminho: código-fonte, .env e o arquivo do banco NUNCA podem ser servidos.
    const rel = path.relative(path.resolve(staticDir), path.resolve(__dirname, '..'));
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      const blocked = '/' + rel.split(path.sep)[0].toLowerCase();
      app.use((req, res, next) => {
        const p = req.path.toLowerCase();
        if (p === blocked || p.startsWith(blocked + '/')) return res.status(404).end();
        next();
      });
    }
    app.use(express.static(staticDir, { index: 'index.html', dotfiles: 'ignore' }));
  }

  // Tratamento de erros: HttpError vira JSON com o status certo.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { message: err.message, details: err.details } });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { message: 'JSON inválido no corpo da requisição.' } });
    }
    console.error('[erro]', err);
    res.status(500).json({ error: { message: 'Erro interno do servidor.' } });
  });

  return app;
}

module.exports = { createApp };
