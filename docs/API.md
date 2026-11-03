# ROVIX — Referência da API

Base: `http://localhost:3000/api` · JSON em UTF-8 · datas em ISO 8601 (UTC).

**Autenticação:** `Authorization: Bearer <token>` (token vem de `/auth/login` ou `/auth/demo`).
Só o rastreamento do consumidor (`/track/...`) e `/health` são públicos.

**Erros** seguem sempre o mesmo formato:

```json
{ "error": { "message": "Texto em português para mostrar ao usuário." } }
```

| Status | Quando |
|---|---|
| 400 | Dados inválidos (campo faltando, valor fora da lista) |
| 401 | Sem login / token inválido ou expirado |
| 403 | Perfil sem permissão (ou entrega de outro comerciante) |
| 404 | Recurso não existe (ex.: código de rastreamento errado) |
| 409 | Ação incompatível com o estado atual (ex.: iniciar entrega já iniciada) |

Listas paginadas devolvem `{ data: [...], total, page, pageSize }` e aceitam `?page=1&pageSize=50`.

---

## Valores fixos (enums)

| Elemento | Valores |
|---|---|
| Entrega (`status`) | `PENDING` Pendente · `PREPARING` Em preparo · `IN_TRANSIT` Em andamento · `DELIVERED` Concluída · `CANCELLED` Cancelada |
| Drone | `READY` · `DELIVERING` · `RETURNING` · `CHARGING` |
| Rota | `PLANNED` · `IN_PROGRESS` · `COMPLETED` · `CANCELLED` |
| Base | `ACTIVE` · `INACTIVE` |
| Voo | `IN_PROGRESS` Em andamento · `COMPLETED` Concluído · `INTERRUPTED` Interrompido |
| Ocorrência (`status`) | `OPEN` Aberta · `UNDER_REVIEW` Em análise · `RESOLVED` Resolvida |
| Prioridade | `NORMAL` · `HIGH` (a criação aceita também `normal`/`high`, como no `<select>` do front) |
| Categoria | `TECHNICAL_FAILURE` Falha técnica · `BATTERY_PROBLEM` Problema de bateria · `ADVERSE_WEATHER` Condição climática desfavorável · `ROUTE_DEVIATION` Desvio de rota · `DELIVERY_PROBLEM` Problema na entrega · `AIRSPACE_RESTRICTION` Restrição de espaço aéreo |

Todo objeto traz também o rótulo pronto em português (`statusLabel`, `priorityLabel`, `categoryLabel`), então o front não precisa traduzir.

> Os status são **independentes**: uma entrega pode estar `DELIVERED` enquanto o drone ainda está `RETURNING`.

---

## Autenticação

| Método e rota | Quem | Descrição |
|---|---|---|
| `POST /auth/login` `{email, password}` | público | Login normal. Devolve `{ token, user }` |
| `POST /auth/demo` `{role}` | público* | Entra direto com um perfil (`MERCHANT`, `OPERATOR`, `CONSUMER`, `AUTHORITIES`). *Desligável com `DEMO_LOGIN=false` |
| `GET /auth/me` | logado | Dados do usuário do token |

Usuários de demonstração (senha `rovix123`): `merchant@rovix.demo`, `merchant2@rovix.demo`, `operator@rovix.demo`, `authority@rovix.demo`, `consumer@rovix.demo`.

## Consumidor (público, sem login)

| Rota | Descrição |
|---|---|
| `GET /track/:codigo` | Estado completo da entrega pelo código (`RVX-2049-AB`; maiúsculas/minúsculas tanto faz) |
| `GET /track/:codigo/stream` | Mesmo conteúdo em tempo real (Server-Sent Events). Cada mudança reenvia o estado completo |

Resposta de `GET /track/:codigo`:

```json
{
  "trackingCode": "RVX-2067-BE", "deliveryCode": "RV-2067",
  "status": "IN_TRANSIT", "statusLabel": "Em andamento",
  "currentStep": "Drone em rota", "isDelayed": false,
  "recipientName": "Marina Costa", "address": "Rua das Palmeiras, 142", "neighborhood": "Vila Aurora",
  "priority": "HIGH", "priorityLabel": "Alta",
  "eta": "2026-11-03T22:50:12.000Z", "etaSeconds": 12, "estimatedMinutes": 6,
  "progress": 0.43,
  "origin": { "name": "Base Central", "lat": -25.4284, "lng": -49.2733 },
  "destination": { "lat": -25.4101, "lng": -49.3401 },
  "dronePosition": { "lat": -25.4219, "lng": -49.2909 }, "droneCode": "DR-01",
  "timeline": [
    { "key": "RECEIVED",  "title": "Pedido recebido",   "description": "Pedido confirmado",     "state": "complete", "at": "..." },
    { "key": "PREPARED",  "title": "Pedido preparado",  "description": "Encomenda pronta",      "state": "complete", "at": "..." },
    { "key": "IN_ROUTE",  "title": "Drone em rota",     "description": "A caminho do destino",  "state": "current",  "at": "..." },
    { "key": "DELIVERED", "title": "Entrega concluída", "description": "Aguardando entrega",    "state": "pending",  "at": null }
  ],
  "events": [ { "type": "DEPARTED", "message": "Drone DR-01 decolou da Base Central rumo ao destino.", "createdAt": "..." } ],
  "simulated": true, "disclaimer": "..."
}
```

- `timeline[].state` = `complete` / `current` / `pending` → casa direto com as classes `is-complete` / `is-current` do front.
- `progress` (0 a 1) é a fração do trecho de **ida** já percorrida: use para posicionar o drone ao longo do `<path>` do mapa esquemático (`path.getPointAtLength(progress * path.getTotalLength())`).
- `etaSeconds`/`eta` estão no **tempo da demo** (acelerado). `estimatedMinutes` é o tempo equivalente de um voo real ("previsão" para exibir ao usuário).

## Entregas — `/deliveries`

| Rota | Quem | Descrição |
|---|---|---|
| `GET /deliveries` | Comerciante (só as dele), Operador, Autoridades | Lista. Filtros: `status`, `q`, `priority`, `delayed=true`, `hasIncident=true` |
| `GET /deliveries/stats` | idem | Cards: `total, pending, awaitingDrone, preparing, inProgress, completed, cancelled, delayed, withIncident` |
| `POST /deliveries` | Comerciante | Cadastra e já tenta atribuir drone/base |
| `GET /deliveries/:ref` | Comerciante (dona), Operador, Autoridades | Detalhe + `route` + `flight` + `events`. `:ref` = id, `RV-2049` ou código de rastreamento |
| `POST /deliveries/:ref/start` | Operador | Drone atribuído decola (`PREPARING → IN_TRANSIT`) |
| `POST /deliveries/:ref/cancel` `{reason?}` | Comerciante (antes de decolar), Operador (inclusive em voo) | Cancela e libera o drone |
| `GET /deliveries/:ref/events` | idem detalhe | Histórico de eventos |

`status` aceita lista separada por vírgula e atalhos: `PENDING_GROUP` (= `PENDING` + `PREPARING`, o "Pendentes" do front), `IN_PROGRESS` (= `IN_TRANSIT`), `COMPLETED` (= `DELIVERED`).

Criar entrega:

```http
POST /api/deliveries
{ "recipientName": "Marina Costa", "address": "Rua das Palmeiras, 142",
  "neighborhood": "Vila Aurora", "priority": "high" }
```

`neighborhood` e `destination: {lat, lng}` são opcionais. Sem coordenadas, o destino é calculado de forma **simulada** a partir do endereço (sempre o mesmo ponto para o mesmo endereço).

Resposta `201`: `id, code, trackingCode, recipientName, address, neighborhood, destination, priority(+Label), status(+Label), isDelayed, hasOpenIncident, drone, originBase, returnBase, createdAt, ...`.

## Drones — `/drones` e Bases — `/bases`

| Rota | Quem | Descrição |
|---|---|---|
| `GET /drones` (`?status=`) · `GET /drones/:ref` | Operador, Autoridades | Bateria, posição, base, entrega atual |
| `POST /drones` `{code, baseId, model?}` | Operador | Novo drone, já estacionado numa base com vaga |
| `PATCH /drones/:ref` `{status?, battery?, baseId?}` | Operador | Só com o drone estacionado. `status`: `READY` ou `CHARGING` |
| `GET /bases` | qualquer logado | Inclui `dockedDrones`, `inboundDrones`, `freeSlots` |
| `GET /bases/:id` | Operador, Autoridades | |
| `POST /bases` `{name, lat, lng, capacity?}` | Operador | |
| `PATCH /bases/:id` `{status?, capacity?, name?}` | Operador | `INACTIVE` = não recebe despacho e redireciona drones que estavam voltando para ela |

## Rotas, voos e ocorrências

| Rota | Quem | Descrição |
|---|---|---|
| `GET /routes/active/summary` | Operador, Autoridades | `totalDistanceKm`, `estimatedMinutes`, `stopsCount`, `stops[]` (sequência de destinos) — painel "Rota de entrega" |
| `GET /routes` (`?status=`) · `GET /routes/:id` | Operador, Autoridades | |
| `GET /flights` (`?status=`, `?q=`) · `GET /flights/:id` | Operador, Autoridades | Histórico de voos (distância, bases, horários) |
| `GET /incidents` (`?status=`, `?category=`, `?priority=`, `?q=`) · `GET /incidents/:ref` | Operador, Autoridades | |
| `POST /incidents` `{category, description, priority?, deliveryCode?, droneCode?, baseId?}` | Autoridades | Registro manual (só registra; não altera a operação) |
| `PATCH /incidents/:ref` `{status?, priority?, description?}` | Autoridades | Acompanhamento `OPEN → UNDER_REVIEW → RESOLVED` |
| `GET /overview` | Comerciante, Operador, Autoridades | Contadores: `deliveries`, e (operador/autoridades) `flights`, `incidents`, `drones`, `bases` |

Ocorrências têm `source`: `AUTO` (gerada pela simulação) ou `MANUAL` (autoridade).

## Simulação (controle da demonstração)

| Rota | Quem | Descrição |
|---|---|---|
| `GET /simulation` | Operador, Autoridades | Velocidade, pausa, configuração |
| `POST /simulation/speed` `{speed}` | Operador | Multiplicador de tempo (1–500) |
| `POST /simulation/pause` · `/resume` | Operador | |
| `POST /simulation/step` `{seconds}` | Operador | Avança manualmente (útil com a simulação pausada) |
| `POST /simulation/incidents` `{category, droneCode? \| deliveryCode?}` | Operador, Autoridades | **Injeta uma ocorrência ao vivo** com efeito real: clima → drone a 50% da velocidade; falha técnica → voo interrompido e entrega volta à fila |

## Tempo real (SSE)

`GET /events?token=<JWT>` (EventSource não envia headers, por isso o token vai na URL). Eventos:
`delivery.updated`, `drone.moved`, `drone.updated`, `base.updated`, `incident.created`, `incident.updated`.
Comerciantes só recebem eventos das próprias entregas.

```js
const parar = Rovix.watchEvents((tipo, dado) => console.log(tipo, dado)); // ver client/rovix-api.js
```
