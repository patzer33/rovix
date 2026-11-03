/**
 * Cliente da API do ROVIX para o front (JavaScript puro, sem dependências).
 *
 * Uso: inclua ANTES do script.js:
 *   <script src="backend/client/rovix-api.js"></script>   (ou copie o arquivo para a raiz do front)
 *
 * Se o front for servido pelo próprio backend (npm start), deixe baseUrl vazio.
 * Se rodar em outra porta (ex.: Live Server), use: Rovix.config.baseUrl = 'http://localhost:3000'
 *
 * Todas as funções retornam Promises e lançam Error (com .status) em caso de falha.
 */
(function (global) {
  'use strict';

  const config = { baseUrl: '' };
  const TOKEN_KEY = 'rovix.token';
  const USER_KEY = 'rovix.user';

  const store = {
    get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* ignora */ } },
    del: (k) => { try { sessionStorage.removeItem(k); } catch { /* ignora */ } }
  };

  async function request(method, path, body, { auth = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const token = store.get(TOKEN_KEY);
    if (auth && token) headers.Authorization = 'Bearer ' + token;

    const res = await fetch(config.baseUrl + '/api' + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let data = null;
    try { data = await res.json(); } catch { /* resposta sem corpo */ }
    if (!res.ok) {
      const err = new Error((data && data.error && data.error.message) || 'Erro ' + res.status);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const qs = (params = {}) => {
    const p = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.append(k, v); });
    const s = p.toString();
    return s ? '?' + s : '';
  };

  // ---- sessão ----
  /** Entra com o perfil escolhido na tela inicial: 'MERCHANT' | 'OPERATOR' | 'CONSUMER' | 'AUTHORITIES'. */
  async function loginAs(role) {
    const out = await request('POST', '/auth/demo', { role }, { auth: false });
    store.set(TOKEN_KEY, out.token);
    store.set(USER_KEY, JSON.stringify(out.user));
    return out.user;
  }
  async function login(email, password) {
    const out = await request('POST', '/auth/login', { email, password }, { auth: false });
    store.set(TOKEN_KEY, out.token);
    store.set(USER_KEY, JSON.stringify(out.user));
    return out.user;
  }
  function logout() { store.del(TOKEN_KEY); store.del(USER_KEY); }
  function currentUser() { try { return JSON.parse(store.get(USER_KEY)); } catch { return null; } }

  // ---- comerciante / operador / autoridades ----
  const deliveries = {
    list: (filters) => request('GET', '/deliveries' + qs(filters)),          // {data,total,page,pageSize}
    stats: () => request('GET', '/deliveries/stats'),                         // cards de topo
    get: (ref) => request('GET', '/deliveries/' + encodeURIComponent(ref)),   // detalhe + rota + voo + eventos
    create: ({ recipientName, address, neighborhood, priority }) =>
      request('POST', '/deliveries', { recipientName, address, neighborhood, priority }),
    start: (ref) => request('POST', '/deliveries/' + encodeURIComponent(ref) + '/start'),       // operador
    cancel: (ref, reason) => request('POST', '/deliveries/' + encodeURIComponent(ref) + '/cancel', { reason })
  };

  const drones = {
    list: (filters) => request('GET', '/drones' + qs(filters)),
    update: (ref, patch) => request('PATCH', '/drones/' + encodeURIComponent(ref), patch),
    create: (drone) => request('POST', '/drones', drone)
  };
  const bases = {
    list: () => request('GET', '/bases'),
    update: (id, patch) => request('PATCH', '/bases/' + id, patch),
    create: (base) => request('POST', '/bases', base)
  };
  const routes = {
    activeSummary: () => request('GET', '/routes/active/summary'),            // distância / tempo / paradas
    list: (filters) => request('GET', '/routes' + qs(filters))
  };
  const flights = { list: (filters) => request('GET', '/flights' + qs(filters)) };
  const incidents = {
    list: (filters) => request('GET', '/incidents' + qs(filters)),
    get: (ref) => request('GET', '/incidents/' + encodeURIComponent(ref)),
    create: (data) => request('POST', '/incidents', data),                    // autoridades
    update: (ref, patch) => request('PATCH', '/incidents/' + encodeURIComponent(ref), patch)
  };
  const overview = () => request('GET', '/overview');
  const simulation = {
    get: () => request('GET', '/simulation'),
    setSpeed: (speed) => request('POST', '/simulation/speed', { speed }),
    pause: () => request('POST', '/simulation/pause'),
    resume: () => request('POST', '/simulation/resume'),
    injectIncident: (data) => request('POST', '/simulation/incidents', data)  // demo ao vivo
  };

  // ---- consumidor (público, sem login) ----
  const tracking = {
    get: (code) => request('GET', '/track/' + encodeURIComponent(code.trim()), undefined, { auth: false }),
    /**
     * Acompanha em tempo real. Chama onUpdate(trackingCompleto) a cada mudança.
     * Retorna uma função para parar de acompanhar.
     */
    watch(code, onUpdate, onError) {
      const es = new EventSource(config.baseUrl + '/api/track/' + encodeURIComponent(code.trim()) + '/stream');
      const handler = (e) => { try { onUpdate(JSON.parse(e.data)); } catch (err) { if (onError) onError(err); } };
      ['hello', 'delivery.updated', 'drone.moved'].forEach((name) => es.addEventListener(name, handler));
      es.onerror = (e) => { if (onError) onError(e); };
      return () => es.close();
    }
  };

  /** Eventos em tempo real para painéis autenticados (entregas, drones, ocorrências). */
  function watchEvents(onEvent) {
    const token = store.get(TOKEN_KEY);
    if (!token) throw new Error('Faça login antes de acompanhar eventos.');
    const es = new EventSource(config.baseUrl + '/api/events?token=' + encodeURIComponent(token));
    ['delivery.updated', 'drone.moved', 'drone.updated', 'base.updated', 'incident.created', 'incident.updated']
      .forEach((name) => es.addEventListener(name, (e) => onEvent(name, JSON.parse(e.data))));
    return () => es.close();
  }

  global.Rovix = { config, loginAs, login, logout, currentUser, deliveries, drones, bases, routes, flights, incidents, overview, simulation, tracking, watchEvents };
})(window);
