/* ROVIX — front ligado à API (backend/). Usa o cliente global `Rovix` (rovix-api.js). */

const profiles = {
  merchant: {
    title: "Área do comerciante",
    description: "Cadastre e acompanhe encomendas em um só lugar.",
    role: "MERCHANT"
  },
  operator: {
    title: "Área do operador",
    description: "Gerencie entregas e consulte rotas da operação.",
    role: "OPERATOR"
  },
  consumer: {
    title: "Área do consumidor",
    description: "Acompanhe sua encomenda do envio até a chegada.",
    role: null // público: não precisa de login
  },
  authorities: {
    title: "Área de autoridades",
    description: "Consulte registros e ocorrências autorizadas.",
    role: "AUTHORITIES"
  }
};

/* ---------- API ---------- */

// Se o front for aberto por outro servidor (Live Server, arquivo local...), a API fica em localhost:3000.
// Para apontar para outro endereço, defina window.ROVIX_API_URL antes deste script.
const servedByBackend =
  /^https?:$/.test(location.protocol) &&
  (location.port === "3000" || !["localhost", "127.0.0.1", ""].includes(location.hostname));
Rovix.config.baseUrl = window.ROVIX_API_URL || (servedByBackend ? "" : "http://localhost:3000");

const REFRESH_MS = 15000; // reatualiza as listas de tempos em tempos (marca "Atrasada" etc.)

/* ---------- elementos ---------- */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const homeView = $("#home-view");
const profileView = $("#profile-view");
const profileTitle = $("#profile-title");
const profileDescription = $("#profile-description");
const merchantDashboard = $("#merchant-dashboard");
const operatorDashboard = $("#operator-dashboard");
const consumerDashboard = $("#consumer-dashboard");
const authoritiesDashboard = $("#authorities-dashboard");
const genericProfilePanel = $("#generic-profile-panel");
const merchantTitle = $("#merchant-title");
const operatorTitle = $("#operator-title");
const consumerTitle = $("#consumer-title");
const authoritiesTitle = $("#authorities-title");
const newOrderDialog = $("#new-order-dialog");
const deliveryDialog = $("#delivery-dialog");
const incidentDialog = $("#incident-dialog");
const apiBanner = $("#api-banner");

/* ---------- utilidades ---------- */

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);
const pad2 = (n) => String(n ?? 0).padStart(2, "0");
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("pt-BR") : "—");
const fmtTime = (iso) =>
  iso ? new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "—";
const fmtNumber = (n) => Number(n || 0).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtDuration = (seconds) =>
  seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}min ${String(seconds % 60).padStart(2, "0")}s`;

function errorMessage(error) {
  if (error && error.status) return error.message;
  return "Não foi possível conectar ao servidor do ROVIX. Confira se ele está rodando (npm start) e abra http://localhost:3000.";
}

function setMessage(element, text) {
  if (!element) return;
  element.textContent = text || "";
  element.hidden = !text;
}

const showBanner = (text) => setMessage(apiBanner, text);
const hideBanner = () => setMessage(apiBanner, "");

const STATUS_CLASS = {
  PENDING: "status-pending",
  PREPARING: "status-pending",
  IN_TRANSIT: "status-progress",
  DELIVERED: "status-complete",
  CANCELLED: "status-cancelled"
};

function deliveryStatus(delivery) {
  if (delivery.isDelayed && ["IN_TRANSIT", "PENDING"].includes(delivery.status)) {
    return { cls: "status-delayed", label: "Atrasada" };
  }
  return { cls: STATUS_CLASS[delivery.status] || "", label: delivery.statusLabel };
}

const FLIGHT_CLASS = { IN_PROGRESS: "status-progress", COMPLETED: "status-complete", INTERRUPTED: "status-delayed" };
const INCIDENT_CLASS = { OPEN: "status-delayed", UNDER_REVIEW: "status-pending", RESOLVED: "status-complete" };

const statusTag = (cls, label) =>
  `<span class="status-tag ${cls}"><span aria-hidden="true">●</span> ${esc(label)}</span>`;

const priorityTag = (priority, label) =>
  `<span class="priority-tag${priority === "HIGH" ? " priority-high" : ""}">${esc(label)}</span>`;

const emptyRow = (columns, text) => `<tr><td class="table-empty" colspan="${columns}">${esc(text)}</td></tr>`;

function addressCell(delivery) {
  return `${esc(delivery.address)}${delivery.neighborhood ? ` <span>${esc(delivery.neighborhood)}</span>` : ""}`;
}

/* ---------- navegação ---------- */

let currentProfile = null;
let currentRole = null;
let navigationId = 0;
let refreshTimer = null;
let intervalTimer = null;
let stopEvents = null;
let stopTracking = null;

function closeDialogs() {
  [newOrderDialog, deliveryDialog, incidentDialog].forEach((dialog) => {
    if (dialog.open) {
      dialog.close();
    }
  });
}

function stopRealtime() {
  navigationId += 1;
  clearTimeout(refreshTimer);
  clearInterval(intervalTimer);
  refreshTimer = null;
  intervalTimer = null;
  if (stopEvents) stopEvents();
  if (stopTracking) stopTracking();
  stopEvents = null;
  stopTracking = null;
}

function showHome() {
  closeDialogs();
  stopRealtime();
  currentProfile = null;
  currentRole = null;
  hideBanner();

  if (!profileView.hidden) {
    profileView.hidden = true;
    homeView.hidden = false;
    document.querySelector("[data-profile]").focus();
    return;
  }

  homeView.hidden = false;
  document.querySelector("[data-profile]").focus();
}

function showProfile(profileKey) {
  const profile = profiles[profileKey];

  if (!profile) {
    return;
  }

  closeDialogs();
  stopRealtime();
  hideBanner();
  currentProfile = profileKey;
  currentRole = profile.role;

  profileTitle.textContent = profile.title;
  profileDescription.textContent = profile.description;
  merchantDashboard.hidden = profileKey !== "merchant";
  operatorDashboard.hidden = profileKey !== "operator";
  consumerDashboard.hidden = profileKey !== "consumer";
  authoritiesDashboard.hidden = profileKey !== "authorities";
  genericProfilePanel.hidden = ["merchant", "operator", "consumer", "authorities"].includes(profileKey);
  homeView.hidden = true;
  profileView.hidden = false;

  if (profileKey === "merchant") {
    merchantTitle.focus();
  } else if (profileKey === "operator") {
    operatorTitle.focus();
  } else if (profileKey === "consumer") {
    consumerTitle.focus();
  } else if (profileKey === "authorities") {
    authoritiesTitle.focus();
  } else {
    profileTitle.focus();
  }

  enterProfile(profileKey);
}

/** Entra com o perfil (login de demonstração), carrega os dados e liga as atualizações em tempo real. */
async function enterProfile(profileKey) {
  const profile = profiles[profileKey];
  if (!profile || !profile.role) return; // consumidor não precisa de login

  const id = navigationId;
  try {
    await Rovix.loginAs(profile.role);
    if (id !== navigationId) return;
    await refreshCurrent();
    if (id !== navigationId) return;
    startRealtime();
  } catch (error) {
    if (id === navigationId) showBanner(errorMessage(error));
  }
}

async function refreshCurrent() {
  try {
    if (currentProfile === "merchant") await loadMerchant();
    else if (currentProfile === "operator") await loadOperator();
    else if (currentProfile === "authorities") await loadAuthorities();
    else return;
    hideBanner();
    if (deliveryDialog.open && currentDelivery) await reloadDeliveryDialog();
  } catch (error) {
    showBanner(errorMessage(error));
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshCurrent, 700);
}

function startRealtime() {
  try {
    stopEvents = Rovix.watchEvents((type) => {
      if (type !== "drone.moved") scheduleRefresh();
    });
  } catch (error) {
    stopEvents = null;
  }
  intervalTimer = setInterval(refreshCurrent, REFRESH_MS);
}

document.querySelectorAll("[data-profile]").forEach((card) => {
  card.addEventListener("click", () => showProfile(card.dataset.profile));
});

document.querySelectorAll("[data-back], [data-home-link]").forEach((control) => {
  control.addEventListener("click", (event) => {
    event.preventDefault();
    showHome();
  });
});

/* ---------- listas com busca e filtros ---------- */

/**
 * Liga busca + chips de filtro de uma tabela.
 * `chips`: um objeto de parâmetros da API por chip, na mesma ordem dos botões do HTML.
 */
function bindList({ filters, search, chips, fetchPage, render }) {
  const chipButtons = $$(".filter-chip", filters);
  const state = { params: chips[0] || {}, q: "" };
  let searchTimer = null;

  async function load() {
    const params = { ...state.params, pageSize: 100 };
    if (state.q) params.q = state.q;
    const page = await fetchPage(params);
    render(page.data, page);
    return page;
  }

  chipButtons.forEach((button, index) => {
    button.addEventListener("click", async () => {
      chipButtons.forEach((other) => {
        other.classList.toggle("is-selected", other === button);
        other.setAttribute("aria-pressed", other === button ? "true" : "false");
      });
      state.params = chips[index] || {};
      try {
        await load();
        hideBanner();
      } catch (error) {
        showBanner(errorMessage(error));
      }
    });
  });

  if (search) {
    search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => {
        state.q = search.value.trim();
        try {
          await load();
          hideBanner();
        } catch (error) {
          showBanner(errorMessage(error));
        }
      }, 250);
    });
  }

  return { load };
}

function setMetrics(section, values) {
  $$(".metric-value", section).forEach((element, index) => {
    if (values[index] !== undefined) element.textContent = pad2(values[index]);
  });
}

function setAllCount(filters, total) {
  const count = $(".filter-chip span", filters);
  if (count) count.textContent = total;
}

/* ---------- comerciante ---------- */

const merchantFilters = $(".status-filters", merchantDashboard);
const merchantList = bindList({
  filters: merchantFilters,
  search: $("input[type=search]", merchantDashboard),
  chips: [{}, { status: "PENDING_GROUP" }, { status: "IN_PROGRESS" }, { status: "COMPLETED" }],
  fetchPage: (params) => Rovix.deliveries.list(params),
  render(rows) {
    const body = $("tbody", merchantDashboard);
    body.innerHTML = rows.length
      ? rows
          .map((delivery) => {
            const status = deliveryStatus(delivery);
            return `<tr>
              <td data-label="Pedido"><span class="order-code">#${esc(delivery.code)}</span></td>
              <td data-label="Destinatário"><span class="recipient-name">${esc(delivery.recipientName)}</span></td>
              <td data-label="Endereço de destino" class="address-cell">${addressCell(delivery)}</td>
              <td data-label="Prioridade">${priorityTag(delivery.priority, delivery.priorityLabel)}</td>
              <td data-label="Status">${statusTag(status.cls, status.label)}</td>
              <td data-label="Ações"><button class="row-action" type="button" data-delivery-ref="${esc(delivery.code)}" aria-label="Detalhes do pedido ${esc(delivery.code)}">•••</button></td>
            </tr>`;
          })
          .join("")
      : emptyRow(6, "Nenhum pedido encontrado.");
  }
});

async function loadMerchant() {
  const [stats] = await Promise.all([Rovix.deliveries.stats(), merchantList.load()]);
  setMetrics(merchantDashboard, [stats.total, stats.pending, stats.inProgress, stats.completed]);
  setAllCount(merchantFilters, stats.total);
}

/* ---------- operador ---------- */

const operatorFilters = $(".status-filters", operatorDashboard);
const operatorList = bindList({
  filters: operatorFilters,
  search: $("input[type=search]", operatorDashboard),
  chips: [{}, { status: "PENDING_GROUP" }, { status: "IN_PROGRESS" }, { status: "COMPLETED" }, { delayed: "true" }],
  fetchPage: (params) => Rovix.deliveries.list(params),
  render(rows) {
    const body = $("tbody", operatorDashboard);
    body.innerHTML = rows.length
      ? rows
          .map((delivery) => {
            const status = deliveryStatus(delivery);
            return `<tr>
              <td data-label="Entrega"><span class="order-code">#${esc(delivery.code)}</span></td>
              <td data-label="Destinatário"><span class="recipient-name">${esc(delivery.recipientName)}</span></td>
              <td data-label="Endereço de destino" class="address-cell">${addressCell(delivery)}</td>
              <td data-label="Prioridade">${priorityTag(delivery.priority, delivery.priorityLabel)}</td>
              <td data-label="Status atual">${statusTag(status.cls, status.label)}</td>
              <td data-label="Detalhes"><button class="view-details-button" type="button" data-delivery-ref="${esc(delivery.code)}">Ver detalhes <span aria-hidden="true">↗</span></button></td>
            </tr>`;
          })
          .join("")
      : emptyRow(6, "Nenhuma entrega encontrada.");
  }
});

function renderRouteSummary(summary) {
  const metrics = $$(".route-metric strong", operatorDashboard);
  if (metrics.length === 3) {
    metrics[0].innerHTML = `${fmtNumber(summary.totalDistanceKm)} <small>km</small>`;
    metrics[1].innerHTML = `${summary.estimatedMinutes} <small>min</small>`;
    metrics[2].innerHTML = `${pad2(summary.stopsCount)} <small>${summary.stopsCount === 1 ? "destino" : "destinos"}</small>`;
  }
  const list = $(".route-stops ol", operatorDashboard);
  list.innerHTML = summary.stops.length
    ? summary.stops
        .slice(0, 8)
        .map(
          (stop) => `<li><span class="stop-number">${pad2(stop.order)}</span><span><strong>${esc(stop.recipientName)}</strong><small>${esc(stop.address)}</small></span></li>`
        )
        .join("")
    : `<li><span><small>Nenhuma rota ativa no momento.</small></span></li>`;
}

async function loadOperator() {
  const [stats, summary] = await Promise.all([
    Rovix.deliveries.stats(),
    Rovix.routes.activeSummary(),
    operatorList.load()
  ]);
  setMetrics(operatorDashboard, [stats.total, stats.pending, stats.inProgress, stats.completed]);
  setAllCount(operatorFilters, stats.total);
  renderRouteSummary(summary);
}

/* ---------- autoridades ---------- */

const authorityFilters = $(".status-filters", authoritiesDashboard);
const authorityDeliveries = bindList({
  filters: authorityFilters,
  search: $("input[type=search]", authoritiesDashboard),
  chips: [{}, { status: "IN_PROGRESS" }, { status: "COMPLETED" }, { hasIncident: "true" }],
  fetchPage: (params) => Rovix.deliveries.list(params),
  render(rows) {
    const body = $(".authority-table:not(.flight-table) tbody", authoritiesDashboard);
    body.innerHTML = rows.length
      ? rows
          .map((delivery) => {
            const status = deliveryStatus(delivery);
            const label = delivery.hasOpenIncident ? "Com ocorrência" : status.label;
            const cls = delivery.hasOpenIncident ? "status-delayed" : status.cls;
            return `<tr>
              <td data-label="Entrega"><span class="order-code">#${esc(delivery.code)}</span></td>
              <td data-label="Data e horário" class="authority-date">${fmtDate(delivery.createdAt)} <span>${fmtTime(delivery.createdAt)}</span></td>
              <td data-label="Região / destino">${esc(delivery.neighborhood || delivery.address)} <span class="authority-subcell">${esc(delivery.address)}</span></td>
              <td data-label="Status">${statusTag(cls, label)}</td>
            </tr>`;
          })
          .join("")
      : emptyRow(4, "Nenhum registro encontrado.");
  }
});

function renderFlights(rows) {
  const body = $(".flight-table tbody", authoritiesDashboard);
  body.innerHTML = rows.length
    ? rows
        .map(
          (flight) => `<tr>
            <td data-label="Voo"><span class="order-code">${esc(flight.code)}</span></td>
            <td data-label="Entrega associada">${flight.deliveryCode ? `#${esc(flight.deliveryCode)}` : "—"}</td>
            <td data-label="Região de operação">${esc(flight.region || "—")}</td>
            <td data-label="Início / término" class="authority-date">${fmtTime(flight.startedAt)} <span>${flight.endedAt ? fmtTime(flight.endedAt) : "Em curso"}</span></td>
            <td data-label="Situação">${statusTag(FLIGHT_CLASS[flight.status] || "", flight.statusLabel)}</td>
          </tr>`
        )
        .join("")
    : emptyRow(5, "Nenhum voo registrado.");
}

function renderIncidents(rows) {
  const grid = $(".incident-grid", authoritiesDashboard);
  grid.innerHTML = rows.length
    ? rows
        .map((incident) => {
          const link =
            [incident.deliveryCode ? `#${incident.deliveryCode}` : "", incident.droneCode, incident.baseName]
              .filter(Boolean)
              .join(" · ") || (incident.source === "AUTO" ? "Registro automático" : "Registro manual");
          return `<article class="incident-card">
            <div class="incident-card-top">
              <span class="incident-id">${esc(incident.code)}</span>
              ${statusTag(INCIDENT_CLASS[incident.status] || "", incident.statusLabel)}
            </div>
            <h3>${esc(incident.categoryLabel)}</h3>
            <p class="incident-category">Vínculo <strong>${esc(link)}</strong></p>
            <div class="incident-meta"><span>${fmtDate(incident.createdAt)}</span>${priorityTag(incident.priority, `Prioridade ${incident.priorityLabel.toLowerCase()}`)}</div>
            <button class="view-details-button" type="button" data-incident-ref="${esc(incident.code)}">Ver detalhes <span aria-hidden="true">↗</span></button>
          </article>`;
        })
        .join("")
    : `<p class="demo-data-note">Nenhuma ocorrência registrada.</p>`;
}

async function loadAuthorities() {
  const [overview, flights, incidents] = await Promise.all([
    Rovix.overview(),
    Rovix.flights.list({ pageSize: 12 }),
    Rovix.incidents.list({ pageSize: 12 }),
    authorityDeliveries.load()
  ]);
  setMetrics(authoritiesDashboard, [
    overview.deliveries.total,
    overview.flights.total,
    overview.incidents.open + overview.incidents.underReview,
    overview.incidents.resolved
  ]);
  setAllCount(authorityFilters, overview.deliveries.total);
  renderFlights(flights.data);
  renderIncidents(incidents.data);
}

/* ---------- novo pedido ---------- */

const orderForm = $(".order-form", newOrderDialog);
const orderMessage = $("#order-message");
const orderSubmit = $("#order-submit");

function closeOrderDialog() {
  newOrderDialog.close();
}

$("[data-open-order]").addEventListener("click", () => {
  orderForm.reset();
  setMessage(orderMessage, "");
  newOrderDialog.showModal();
});

document.querySelectorAll("[data-close-order]").forEach((control) => {
  control.addEventListener("click", closeOrderDialog);
});

newOrderDialog.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeOrderDialog();
  }
});

orderForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const recipientName = $("#recipient-input").value.trim();
  const address = $("#address-input").value.trim();
  const priority = $("#priority-input").value;

  if (!recipientName || !address) {
    setMessage(orderMessage, "Informe o nome do destinatário e o endereço de entrega.");
    return;
  }

  orderSubmit.disabled = true;
  setMessage(orderMessage, "");
  try {
    const created = await Rovix.deliveries.create({ recipientName, address, priority });
    newOrderDialog.close();
    await refreshCurrent();
    await openDelivery(created.code); // mostra o código de rastreamento do pedido novo
  } catch (error) {
    setMessage(orderMessage, errorMessage(error));
  } finally {
    orderSubmit.disabled = false;
  }
});

/* ---------- detalhes da entrega (comerciante / operador) ---------- */

const deliveryMessage = $("#delivery-message");
const startButton = $("#delivery-start-button");
const cancelButton = $("#delivery-cancel-button");
let currentDelivery = null;
let cancelArmed = false;

function resetCancelButton() {
  cancelArmed = false;
  cancelButton.textContent = "Cancelar entrega";
}

function fillDelivery(delivery) {
  currentDelivery = delivery;
  const status = deliveryStatus(delivery);
  $("#detail-code").textContent = `#${delivery.code}`;
  $("#detail-recipient").textContent = delivery.recipientName;
  $("#detail-address").textContent = delivery.address + (delivery.neighborhood ? ` — ${delivery.neighborhood}` : "");
  $("#detail-priority").textContent = delivery.priorityLabel;
  $("#detail-status").textContent = status.label;

  const droneText = delivery.drone
    ? `Drone ${delivery.drone.code}${delivery.originBase ? ` · ${delivery.originBase.name}` : ""}`
    : "Aguardando drone";
  $("#detail-extra-title").textContent = droneText;
  const lastEvent = delivery.events && delivery.events[0] ? delivery.events[0].message : "";
  $("#detail-extra-text").textContent = [`Rastreio: ${delivery.trackingCode}`, lastEvent].filter(Boolean).join(" · ");

  const waiting = ["PENDING", "PREPARING"].includes(delivery.status);
  startButton.hidden = !(currentRole === "OPERATOR" && delivery.status === "PREPARING");
  cancelButton.hidden = !(
    (currentRole === "MERCHANT" && waiting) ||
    (currentRole === "OPERATOR" && (waiting || delivery.status === "IN_TRANSIT"))
  );
}

async function openDelivery(ref) {
  try {
    const delivery = await Rovix.deliveries.get(ref);
    setMessage(deliveryMessage, "");
    resetCancelButton();
    fillDelivery(delivery);
    if (!deliveryDialog.open) deliveryDialog.showModal();
  } catch (error) {
    showBanner(errorMessage(error));
  }
}

async function reloadDeliveryDialog() {
  try {
    fillDelivery(await Rovix.deliveries.get(currentDelivery.code));
  } catch (error) {
    /* a janela continua com os últimos dados */
  }
}

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  setMessage(deliveryMessage, "");
  try {
    await Rovix.deliveries.start(currentDelivery.code);
    await reloadDeliveryDialog();
    refreshCurrent();
  } catch (error) {
    setMessage(deliveryMessage, errorMessage(error));
  } finally {
    startButton.disabled = false;
  }
});

cancelButton.addEventListener("click", async () => {
  if (!cancelArmed) {
    cancelArmed = true;
    cancelButton.textContent = "Confirmar cancelamento";
    return;
  }
  cancelButton.disabled = true;
  setMessage(deliveryMessage, "");
  try {
    await Rovix.deliveries.cancel(currentDelivery.code, "Cancelada pelo painel");
    resetCancelButton();
    await reloadDeliveryDialog();
    refreshCurrent();
  } catch (error) {
    setMessage(deliveryMessage, errorMessage(error));
    resetCancelButton();
  } finally {
    cancelButton.disabled = false;
  }
});

document.querySelectorAll("[data-close-delivery]").forEach((control) => {
  control.addEventListener("click", () => deliveryDialog.close());
});

deliveryDialog.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    deliveryDialog.close();
  }
});

deliveryDialog.addEventListener("close", () => {
  currentDelivery = null;
  resetCancelButton();
});

/* ---------- detalhes da ocorrência (autoridades) ---------- */

const incidentMessage = $("#incident-message");
const reviewButton = $("#incident-review-button");
const resolveButton = $("#incident-resolve-button");
let currentIncident = null;

function fillIncident(incident) {
  currentIncident = incident;
  $("#incident-detail-id").textContent = incident.code;
  $("#incident-detail-category").textContent = incident.categoryLabel;
  $("#incident-detail-date").textContent = `${fmtDate(incident.createdAt)} ${fmtTime(incident.createdAt)}`;
  $("#incident-detail-priority").textContent = incident.priorityLabel;
  $("#incident-detail-status").textContent = incident.statusLabel;
  $("#incident-detail-description").textContent = incident.description;
  const canEdit = currentRole === "AUTHORITIES";
  reviewButton.hidden = !(canEdit && incident.status === "OPEN");
  resolveButton.hidden = !(canEdit && incident.status !== "RESOLVED");
}

async function openIncident(ref) {
  try {
    fillIncident(await Rovix.incidents.get(ref));
  } catch (error) {
    showBanner(errorMessage(error));
    return;
  }
  setMessage(incidentMessage, "");
  if (!incidentDialog.open) incidentDialog.showModal();
}

async function changeIncidentStatus(status, button) {
  button.disabled = true;
  setMessage(incidentMessage, "");
  try {
    fillIncident(await Rovix.incidents.update(currentIncident.code, { status }));
    refreshCurrent();
  } catch (error) {
    setMessage(incidentMessage, errorMessage(error));
  } finally {
    button.disabled = false;
  }
}

reviewButton.addEventListener("click", () => changeIncidentStatus("UNDER_REVIEW", reviewButton));
resolveButton.addEventListener("click", () => changeIncidentStatus("RESOLVED", resolveButton));

document.querySelectorAll("[data-close-incident]").forEach((control) => {
  control.addEventListener("click", () => incidentDialog.close());
});

incidentDialog.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    incidentDialog.close();
  }
});

/* ---------- cliques nas linhas geradas dinamicamente ---------- */

document.addEventListener("click", (event) => {
  const deliveryButton = event.target.closest("[data-delivery-ref]");
  if (deliveryButton) {
    openDelivery(deliveryButton.dataset.deliveryRef);
    return;
  }
  const incidentButton = event.target.closest("[data-incident-ref]");
  if (incidentButton) {
    openIncident(incidentButton.dataset.incidentRef);
  }
});

/* ---------- consumidor: rastreamento ---------- */

const trackingForm = $(".tracking-form", consumerDashboard);
const trackingInput = $("#tracking-code");
const trackingMessage = $("#tracking-message");
const trackingResult = $("#tracking-result");
const trackingRoute = $("#consumer-route-section");
const timelineList = $(".delivery-timeline", consumerDashboard);
const eventsList = $("#tracking-events");
const consumerPath = $(".consumer-route-path", consumerDashboard);
const consumerDrone = $(".consumer-drone", consumerDashboard);

const ICON_CHECK =
  '<svg viewBox="0 0 24 24" fill="none"><path d="m6 12 4 4 8-8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_PULSE =
  '<svg viewBox="0 0 24 24" fill="none"><path d="M3.5 12h4l2-5 4.5 10 2-5h4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_PLUS =
  '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12h14M12 5v14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

let lastTrackingKey = "";

function renderTimeline(timeline) {
  timelineList.innerHTML = timeline
    .map((step) => {
      const icon = step.state === "complete" ? ICON_CHECK : step.state === "current" ? ICON_PULSE : ICON_PLUS;
      const attrs = step.state === "current" ? ' aria-current="step"' : "";
      const when = step.at && step.state !== "pending" ? ` · ${fmtTime(step.at)}` : "";
      return `<li class="timeline-step${step.state === "pending" ? "" : ` is-${step.state}`}"${attrs}>
        <span class="timeline-marker" aria-hidden="true">${icon}</span>
        <span class="timeline-step-copy"><strong>${esc(step.title)}</strong><small>${esc(step.description)}${when}</small></span>
      </li>`;
    })
    .join("");
  const currentIndex = timeline.findIndex((step) => step.state === "current");
  const lastComplete = timeline.map((step) => step.state).lastIndexOf("complete");
  timelineList.style.setProperty("--timeline-step", Math.max(0, currentIndex >= 0 ? currentIndex : lastComplete));
}

function placeDrone(progress) {
  if (!consumerPath || !consumerDrone) return;
  const total = consumerPath.getTotalLength();
  const point = consumerPath.getPointAtLength(total * Math.max(0, Math.min(1, progress)));
  consumerDrone.removeAttribute("transform");
  consumerDrone.style.transform = `translate(${point.x}px, ${point.y}px)`;
}

function renderTracking(tracking) {
  trackingResult.hidden = false;
  trackingRoute.hidden = false;

  const status = deliveryStatus(tracking);
  const tag = $(".tracking-result-heading .status-tag", trackingResult);
  tag.className = `status-tag ${status.cls}`;
  tag.innerHTML = `<span aria-hidden="true">●</span> ${esc(status.label)}`;

  const cards = $$(".tracking-summary > article", trackingResult);
  const textOf = (card, selector, value) => {
    $(selector, card).textContent = value;
  };

  textOf(cards[0], "strong", tracking.trackingCode);
  textOf(cards[0], ".tracking-code-caption", tracking.droneCode ? `Drone ${tracking.droneCode}` : "Aguardando drone");

  textOf(cards[1], "strong", tracking.recipientName);
  textOf(cards[1], ".tracking-detail-secondary", tracking.status === "CANCELLED" ? "Entrega cancelada" : `Entrega: ${status.label.toLowerCase()}`);

  const delivered = tracking.events.find((event) => event.type === "DELIVERED");
  if (tracking.status === "DELIVERED") {
    textOf(cards[2], "strong", "Entregue");
    textOf(cards[2], ".tracking-detail-secondary", delivered ? `Às ${fmtTime(delivered.createdAt)}` : "Entrega concluída");
  } else if (tracking.status === "CANCELLED") {
    textOf(cards[2], "strong", "—");
    textOf(cards[2], ".tracking-detail-secondary", tracking.cancelReason || "Entrega cancelada");
  } else if (tracking.etaSeconds !== null) {
    textOf(cards[2], "strong", `Em ~${fmtDuration(tracking.etaSeconds)}`);
    textOf(cards[2], ".tracking-detail-secondary", `Voo real equivalente: ~${tracking.estimatedMinutes} min (demo acelerada)`);
  } else {
    textOf(cards[2], "strong", "—");
    textOf(cards[2], ".tracking-detail-secondary", "Aguardando drone disponível");
  }

  textOf(cards[3], "strong", tracking.address);
  textOf(cards[3], ".tracking-detail-secondary", tracking.neighborhood || "");

  $("strong", cards[4]).innerHTML = priorityTag(tracking.priority, tracking.priorityLabel);

  const stepText =
    tracking.status === "DELIVERED"
      ? "entrega concluída"
      : tracking.status === "CANCELLED"
        ? "entrega cancelada"
        : (tracking.currentStep || "").toLowerCase();
  $(".timeline-current", trackingResult).innerHTML =
    `<span class="metric-indicator progress-indicator"></span> Etapa atual: ${esc(stepText)}`;

  // a linha do tempo e o histórico só são reconstruídos quando algo muda
  const key = JSON.stringify([tracking.status, tracking.timeline.map((s) => s.state), tracking.events.length]);
  if (key !== lastTrackingKey) {
    lastTrackingKey = key;
    renderTimeline(tracking.timeline);
    eventsList.innerHTML = tracking.events
      .slice(0, 8)
      .map((event) => `<li><time>${fmtTime(event.createdAt)}</time><span>${esc(event.message)}</span></li>`)
      .join("");
  }

  const info = $(".consumer-route-info", trackingRoute);
  $("strong", info).textContent = tracking.recipientName;
  $("p", info).innerHTML = `${esc(tracking.address)}${tracking.neighborhood ? `<br>${esc(tracking.neighborhood)}` : ""}`;

  placeDrone(tracking.status === "DELIVERED" ? 1 : tracking.progress);
}

function hideTracking() {
  trackingResult.hidden = true;
  trackingRoute.hidden = true;
  lastTrackingKey = "";
}

trackingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = trackingInput.value.trim();

  if (stopTracking) stopTracking();
  stopTracking = null;

  if (!code) {
    hideTracking();
    setMessage(trackingMessage, "Digite o código de rastreamento para consultar a entrega.");
    return;
  }

  const id = navigationId;
  try {
    const tracking = await Rovix.tracking.get(code);
    if (id !== navigationId) return;
    setMessage(trackingMessage, "");
    lastTrackingKey = "";
    renderTracking(tracking);
    stopTracking = Rovix.tracking.watch(
      code,
      (update) => {
        if (update && update.trackingCode) renderTracking(update);
      },
      () => {}
    );
  } catch (error) {
    hideTracking();
    setMessage(trackingMessage, errorMessage(error));
  }
});
