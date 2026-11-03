// Papéis (perfis de usuário)
const ROLES = {
  MERCHANT: 'MERCHANT',
  OPERATOR: 'OPERATOR',
  CONSUMER: 'CONSUMER',
  AUTHORITIES: 'AUTHORITIES'
};

// Status independentes por elemento (conforme o contexto do projeto)
const DELIVERY_STATUS = ['PENDING', 'PREPARING', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED'];
const DRONE_STATUS = ['READY', 'DELIVERING', 'RETURNING', 'CHARGING'];
const ROUTE_STATUS = ['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
const BASE_STATUS = ['ACTIVE', 'INACTIVE'];
const INCIDENT_STATUS = ['OPEN', 'UNDER_REVIEW', 'RESOLVED'];
const FLIGHT_STATUS = ['IN_PROGRESS', 'COMPLETED', 'INTERRUPTED'];
const PRIORITIES = ['NORMAL', 'HIGH'];

const INCIDENT_CATEGORIES = [
  'TECHNICAL_FAILURE',
  'BATTERY_PROBLEM',
  'ADVERSE_WEATHER',
  'ROUTE_DEVIATION',
  'DELIVERY_PROBLEM',
  'AIRSPACE_RESTRICTION'
];

// Rótulos em português para o front exibir sem precisar traduzir
const LABELS = {
  delivery: {
    PENDING: 'Pendente',
    PREPARING: 'Em preparo',
    IN_TRANSIT: 'Em andamento',
    DELIVERED: 'Concluída',
    CANCELLED: 'Cancelada'
  },
  drone: {
    READY: 'Pronto',
    DELIVERING: 'Em entrega',
    RETURNING: 'Retornando',
    CHARGING: 'Carregando'
  },
  route: {
    PLANNED: 'Planejada',
    IN_PROGRESS: 'Em andamento',
    COMPLETED: 'Concluída',
    CANCELLED: 'Cancelada'
  },
  base: { ACTIVE: 'Ativa', INACTIVE: 'Inativa' },
  flight: { IN_PROGRESS: 'Em andamento', COMPLETED: 'Concluído', INTERRUPTED: 'Interrompido' },
  incident: { OPEN: 'Aberta', UNDER_REVIEW: 'Em análise', RESOLVED: 'Resolvida' },
  priority: { NORMAL: 'Normal', HIGH: 'Alta' },
  category: {
    TECHNICAL_FAILURE: 'Falha técnica',
    BATTERY_PROBLEM: 'Problema de bateria',
    ADVERSE_WEATHER: 'Condição climática desfavorável',
    ROUTE_DEVIATION: 'Desvio de rota',
    DELIVERY_PROBLEM: 'Problema na entrega',
    AIRSPACE_RESTRICTION: 'Restrição de espaço aéreo'
  }
};

module.exports = {
  ROLES,
  DELIVERY_STATUS,
  DRONE_STATUS,
  ROUTE_STATUS,
  BASE_STATUS,
  INCIDENT_STATUS,
  FLIGHT_STATUS,
  PRIORITIES,
  INCIDENT_CATEGORIES,
  LABELS
};
