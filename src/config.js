const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const num = (v, fallback) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? fallback : Number(v));

/**
 * Configuração padrão. Tudo pode ser sobrescrito por variáveis de ambiente (.env)
 * ou, nos testes, por createContext({ ...overrides }).
 */
function loadConfig(overrides = {}) {
  const cfg = {
    port: num(process.env.PORT, 3000),
    dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'rovix.db'),
    jwtSecret: process.env.JWT_SECRET || 'rovix-dev-secret-troque-em-producao',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
    // Login rápido por perfil (POST /api/auth/demo), pensado para a apresentação.
    demoLogin: process.env.DEMO_LOGIN !== 'false',
    // Pasta do front servida pelo Express (raiz do repositório por padrão).
    staticDir: process.env.STATIC_DIR || path.join(__dirname, '..', '..'),
    seedDemoHistory: process.env.SEED_DEMO_HISTORY !== 'false',

    sim: {
      enabled: process.env.SIM_ENABLED !== 'false',
      tickMs: num(process.env.SIM_TICK_MS, 500),
      // 1 segundo real = N segundos simulados. Define o quão "rápido" o drone voa na demo.
      speed: num(process.env.SIM_SPEED, 25),
      // Tempo (s reais) entre o drone ser atribuído e decolar sozinho. < 0 = só o operador inicia.
      autoStartDelayS: num(process.env.AUTO_START_DELAY_S, 6),
      // Chance de incidente aleatório por segundo real, por drone em entrega.
      randomIncidentRate: num(process.env.RANDOM_INCIDENT_RATE, 0.004),
      // Entrega sem drone disponível há mais que isso (s) é considerada atrasada.
      pendingDelayS: num(process.env.PENDING_DELAY_S, 120)
    },

    drone: {
      defaultSpeedKmh: 50,
      drainPerKm: 2.5, // % de bateria por km voado
      reservePct: 15, // reserva mínima exigida no despacho
      lowBatteryPct: 25, // abaixo disso gera ocorrência automática
      chargePctPerSimMin: 2 // % recarregado por minuto simulado
    },

    // Centro e raio usados para "geocodificar" endereços de forma simulada (sem GPS/API externa).
    city: {
      name: 'Curitiba (simulada)',
      center: { lat: -25.4284, lng: -49.2733 },
      radiusKm: 5
    }
  };

  // overrides rasos por bloco (sim, drone, city) para facilitar os testes
  for (const [key, value] of Object.entries(overrides)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && cfg[key] && typeof cfg[key] === 'object') {
      cfg[key] = { ...cfg[key], ...value };
    } else {
      cfg[key] = value;
    }
  }
  return cfg;
}

module.exports = { loadConfig };
