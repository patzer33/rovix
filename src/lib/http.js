class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const badRequest = (msg, details) => new HttpError(400, msg, details);
const unauthorized = (msg = 'Não autenticado.') => new HttpError(401, msg);
const forbidden = (msg = 'Seu perfil não tem permissão para esta ação.') => new HttpError(403, msg);
const notFound = (msg = 'Recurso não encontrado.') => new HttpError(404, msg);
const conflict = (msg) => new HttpError(409, msg);

/** Encapsula handlers para que exceções síncronas caiam no middleware de erro. */
const wrap = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res, next);
    if (out && typeof out.catch === 'function') out.catch(next);
  } catch (err) {
    next(err);
  }
};

// ---- validação simples (sem dependências extras) ----

function reqString(value, field, { min = 1, max = 200 } = {}) {
  if (typeof value !== 'string' || value.trim().length < min) {
    throw badRequest(`O campo "${field}" é obrigatório.`);
  }
  const v = value.trim();
  if (v.length > max) throw badRequest(`O campo "${field}" deve ter no máximo ${max} caracteres.`);
  return v;
}

function optString(value, field, opts) {
  if (value === undefined || value === null || value === '') return null;
  return reqString(value, field, opts);
}

function oneOf(value, allowed, field) {
  const v = typeof value === 'string' ? value.trim().toUpperCase() : value;
  if (!allowed.includes(v)) {
    throw badRequest(`O campo "${field}" deve ser um destes valores: ${allowed.join(', ')}.`);
  }
  return v;
}

function reqNumber(value, field, { min = -Infinity, max = Infinity } = {}) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || Number.isNaN(n) || !Number.isFinite(n) || n < min || n > max) {
    throw badRequest(`O campo "${field}" deve ser um número entre ${min} e ${max}.`);
  }
  return n;
}

function parsePaging(query, { defaultSize = 50, maxSize = 200 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, parseInt(query.pageSize, 10) || defaultSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

module.exports = {
  HttpError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  wrap,
  reqString,
  optString,
  oneOf,
  reqNumber,
  parsePaging
};
