const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { createHub } = require('./lib/events');

/**
 * Contexto compartilhado da aplicação: configuração, banco, hub de eventos e
 * estado de runtime da simulação. Passado para services/rotas (sem globais),
 * o que permite criar várias instâncias isoladas nos testes.
 */
function createContext(overrides = {}) {
  const cfg = loadConfig(overrides);
  const db = openDb(cfg.dbPath);
  const hub = createHub();
  const sim = {
    speed: cfg.sim.speed, // multiplicador de tempo simulado (ajustável em runtime)
    paused: false,
    running: false
  };
  return { cfg, db, hub, sim };
}

module.exports = { createContext };
