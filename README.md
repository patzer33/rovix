# ROVIX — Backend

API da plataforma de entregas por drones (Smart Cities). **Node.js + Express + SQLite**, JavaScript puro.
É uma **demonstração acadêmica**: toda a movimentação dos drones é simulada (sem GPS nem drones reais).

## Como rodar

Requer Node 18 ou superior.

```bash
cd backend
npm install
npm start
```

Abra **http://localhost:3000**: o próprio servidor entrega o front (a pasta acima de `backend/`) e a API em `/api`, na mesma porta, sem CORS.

Na primeira execução o banco (`backend/data/rovix.db`) é criado com usuários, 3 bases, 6 drones e um histórico de entregas/voos/ocorrências para o painel das autoridades não começar vazio.

| Comando | O que faz |
|---|---|
| `npm start` | Sobe a API + simulação |
| `npm run dev` | Igual, reiniciando ao salvar arquivos |
| `npm run seed` | **Apaga** o banco e recria tudo do zero |
| `npm test` | Roda os 14 testes de integração |

Configuração opcional em `.env` (modelo em `.env.example`): porta, velocidade da simulação, decolagem automática, taxa de incidentes aleatórios etc.

## Como o sistema funciona

```
Comerciante cadastra ──► Entrega PENDING ──► despacho escolhe drone + base de origem
                                              │  (rota PLANNED, entrega PREPARING)
              Operador clica "iniciar"  ◄─────┘  ou decola sozinho após AUTO_START_DELAY_S
                     │
                     ▼
   Entrega IN_TRANSIT · Drone DELIVERING · Rota IN_PROGRESS · Voo IN_PROGRESS
                     │  (a cada tick o drone avança, gasta bateria; consumidor vê progresso e ETA)
                     ▼
   Chegou: Entrega DELIVERED · Drone RETURNING (para a base ativa com vaga mais próxima)
                     │
                     ▼
   Pousou: Drone CHARGING → READY · Rota COMPLETED · Voo COMPLETED (distância e horários gravados)
```

Regras principais (todas cobertas por testes):

- **Despacho:** escolhe o drone `READY` de base ativa mais próxima do destino que tenha bateria para ir, voltar a uma base e manter reserva de 15%. Entregas `HIGH` furam a fila. Sem drone apto, a entrega espera `PENDING` e é despachada assim que um ficar disponível.
- **Um drone, uma entrega por vez.**
- **Base de retorno** é reavaliada na chegada e a cada tick: se a base ficar `INACTIVE`, o drone é redirecionado para outra com vaga.
- **Ocorrências automáticas:** bateria abaixo de 25% (ida ou volta), clima adverso (drone voa a 50%) e falha técnica (voo `INTERRUPTED`, drone volta à base mais próxima e a entrega volta para a fila com outro drone). Autoridades também registram manualmente e acompanham `OPEN → UNDER_REVIEW → RESOLVED`.
- **Permissões por perfil:** comerciante só vê as próprias entregas; operador gerencia frota/bases e inicia entregas; autoridades consultam tudo e gerenciam ocorrências; consumidor usa só o rastreamento público.

## Roteiro de demonstração (1 minuto)

1. Perfil **Comerciante** → "Novo pedido" (`POST /api/deliveries`): já aparece com drone e base atribuídos.
2. Copie o código `RVX-…`. Em outra aba, perfil **Consumidor**: acompanhe o drone avançando, a barra de etapas e o ETA caindo.
3. Perfil **Operador**: veja a frota e o resumo de rotas; clique em iniciar (ou espere a decolagem automática).
4. Perfil **Autoridades**: o voo aparece nos registros. Injete uma falha ao vivo:
   `POST /api/simulation/incidents {"category":"TECHNICAL_FAILURE","deliveryCode":"RV-2067"}` e mostre a ocorrência surgindo, o voo `Interrompido` e a entrega sendo refeita por outro drone.

## Integração com o front

O front atual (`index.html` + `script.js`) ainda usa dados estáticos. Para plugá-lo:

1. Inclua `backend/client/rovix-api.js` antes do `script.js` (ele expõe o objeto global `Rovix`).
2. Ao clicar num card de perfil, chame `Rovix.loginAs('MERCHANT' | 'OPERATOR' | 'CONSUMER' | 'AUTHORITIES')`.
3. Troque os dados fixos pelas chamadas abaixo.

| Tela do front | Chamada |
|---|---|
| Comerciante — cards (total/pendentes/andamento/concluídos) | `Rovix.deliveries.stats()` |
| Comerciante — tabela, busca e filtros | `Rovix.deliveries.list({ q, status: 'PENDING_GROUP' \| 'IN_PROGRESS' \| 'COMPLETED' })` |
| Comerciante — "Cadastrar pedido" | `Rovix.deliveries.create({ recipientName, address, priority })` |
| Operador — tabela, filtro "Atrasadas" | `Rovix.deliveries.list({ delayed: true })` |
| Operador — "Ver detalhes" | `Rovix.deliveries.get(code)` |
| Operador — Rota (distância, tempo, paradas) | `Rovix.routes.activeSummary()` |
| Consumidor — "Rastrear entrega" | `Rovix.tracking.get(code)` ou `Rovix.tracking.watch(code, render)` (tempo real) |
| Autoridades — cards | `Rovix.overview()` |
| Autoridades — entregas / voos / ocorrências | `Rovix.deliveries.list()` · `Rovix.flights.list()` · `Rovix.incidents.list()` |

Referência completa dos endpoints, filtros e formatos: [`docs/API.md`](docs/API.md).

## Estrutura

```
backend/
├── src/
│   ├── server.js · app.js · config.js · db.js · seed.js
│   ├── routes/        HTTP por área (auth, deliveries, track, fleet, operations)
│   ├── services/      regras de negócio
│   │   ├── dispatch.js     escolha de drone/base e decolagem
│   │   ├── flightops.js    decolar, entregar, pousar, abortar voo
│   │   ├── simulation.js   motor de movimento, bateria, recarga, incidentes
│   │   ├── incidents.js · tracking.js · fleet.js · presenters.js
│   └── lib/           geo (Haversine), códigos, validação, SSE
├── client/rovix-api.js   cliente JS para o front
├── docs/API.md
└── test/flow.test.js
```

## Decisões e limitações (para constar no relatório)

- **Geolocalização simulada:** sem API de mapas. Endereço vira coordenadas determinísticas dentro de um raio de 5 km em torno de um centro fictício; o front também pode enviar `destination: {lat, lng}`.
- **Movimento em linha reta** entre os pontos, com bateria linear (2,5% por km) e velocidade de 50 km/h. `SIM_SPEED` acelera o tempo para a demo (padrão: 1 s real = 25 s simulados).
- **Autenticação simples** (JWT). O login rápido por perfil (`/auth/demo`) existe para a apresentação; em um sistema real seria desligado (`DEMO_LOGIN=false`) e o `JWT_SECRET` trocado.
- **SQLite em arquivo único**: simples de rodar e entregar. Para escalar, trocar por PostgreSQL mantendo as mesmas regras.
- O código de rastreamento (`RVX-número-AB`) é a "credencial" do consumidor; não há validação adicional além dele.
- Os prefixos de código do front de exemplo variam por tela (`RV-`, `DR-`, `AX-`). A API usa **um só** padrão: `RV-` para entregas, `FL-` para voos e `OC-` para ocorrências.
