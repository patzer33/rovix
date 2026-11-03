const { createContext } = require('./context');
const { createApp } = require('./app');
const { seedIfEmpty, DEMO_PASSWORD, USERS } = require('./seed');
const { createLoop } = require('./services/simulation');

const ctx = createContext();
const seeded = seedIfEmpty(ctx);
const app = createApp(ctx);
const loop = createLoop(ctx);

const server = app.listen(ctx.cfg.port, () => {
  loop.start();
  console.log('');
  console.log(`  ROVIX API no ar:  http://localhost:${ctx.cfg.port}/api/health`);
  console.log(`  Front (se estiver na pasta pai): http://localhost:${ctx.cfg.port}/`);
  console.log(`  Banco: ${ctx.cfg.dbPath}${seeded ? '  (criado agora, com dados de demonstração)' : ''}`);
  console.log(`  Simulação: ${ctx.cfg.sim.enabled ? `ligada (x${ctx.sim.speed})` : 'desligada'}`);
  if (ctx.cfg.demoLogin) {
    console.log(`  Login rápido por perfil: POST /api/auth/demo {"role":"MERCHANT"}`);
    console.log(`  Ou e-mail/senha (${DEMO_PASSWORD}): ${USERS.map((u) => u.email).join(', ')}`);
  }
  console.log('');
});

function shutdown() {
  loop.stop();
  server.close(() => {
    ctx.db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
