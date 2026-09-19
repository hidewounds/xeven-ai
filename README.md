# XEVEN — AI Agent Platform for Businesses

XEVEN is a multi-tenant, self-hosted AI agent platform. Businesses install XEVEN once,
then configure everything — agent role, personality, knowledge, memory and behavior
tracking — through the admin dashboard or API. **No source-code changes are ever
required to onboard a new business.**

```
XEVEN CORE + BUSINESS CONFIG + AGENT CONFIG + KNOWLEDGE + INTEGRATIONS = BUSINESS INSTANCE
```

---

## Quick start

```bash
npm install
npm run migrate     # initialize/migrate the SQLite database (automatic on boot too)
npm start           # http://localhost:3000
```

Open **http://localhost:3000/admin/** → create an admin account → create a business →
copy the integration key → configure your agent.

Development: `npm run dev` (watch mode) · Tests: `npm test`

The default AI provider is OpenAI-compatible (`AI_PROVIDER=openai-compatible`,
`XEVEN_MODEL=gpt-4o-mini`). Switch providers via `AI_PROVIDER` env or per-business
model configuration (`openai-compatible`, `mock`). See `.env.example`.

---

## Onboarding a new business (no code changes)

1. Sign in at `/admin/`
2. **Create business** → receive integration key (`xeven_pk_…`)
3. **Agent tab** → pick role, tone, personality, instructions
4. **Knowledge tab** → add FAQs, policies, product info
5. **Memory / Behavior tabs** → tune what XEVEN remembers and tracks
6. **Integration tab** → paste the snippet into any website:

```html
<script src="https://your-xeven-host/widget/xeven-tracker.js"
        data-public-key="xeven_pk_..."></script>

<script src="https://your-xeven-host/widget/xeven-widget.js"
        data-public-key="xeven_pk_..." defer></script>
```

7. Activate. Done.

The tracker records page views automatically; call `XevenTracker.productView(...)`,
`.search(query)`, `.cart({...})`, `.wishlist({...})`, `.purchase({...})` for rich
personalization context.

---

## Architecture

```
server/
├── index.js                     entrypoint (boot, graceful shutdown)
├── app.js                       express app factory (used by tests too)
└── src/
    ├── env.js                   environment parsing (single source)
    ├── db/                      SQLite connection + versioned migrations
    ├── lib/                     errors, logger (redacting), crypto, tokens
    ├── auth/
    │   ├── integration.js       business API-key auth (x-xeven-key / Bearer)
    │   └── admin.js             dashboard accounts, HMAC tokens, access grants
    ├── core/
    │   ├── config/              canonical config system (defaults→merge→normalize)
    │   │   └── roles.js         agent role framework (8 roles, data-driven)
    │   ├── agent/prompt.js      single canonical system-prompt builder
    │   ├── ai/                  provider abstraction:
    │   │                        openai-compatible | mock (+ future)
    │   ├── memory/              store + extractor (explicit vs inferred,
    │   │                        remember/forget commands, allow-list)
    │   ├── behavior/            TTL'd behavioral events, per-event retention
    │   ├── knowledge/           business knowledge CRUD + keyword retrieval
    │   │                        (RAG-ready interface)
    │   ├── context/engine.js    ranking + token budgeting pipeline
    │   ├── customers/           tenant-scoped customer profiles
    │   ├── conversations/       server-side conversation persistence
    │   ├── analytics/           usage summaries for the dashboard
    │   └── audit/               security-relevant action log
    ├── http/middleware.js       request IDs, security headers, rate limit,
    │                            body limits, centralized error handler
    └── routes/
        ├── v1/                  platform API (integration-key scoped)
        └── admin/               dashboard API (admin-token scoped)
client/
├── sdk/xeven-widget.js           embeddable chat widget
├── sdk/xeven-tracker.js          behavioral tracking SDK
├── welcome/                     public landing page
├── admin/                       dashboard SPA (real functionality only)
└── portal/                      business portal SPA
tests/                           node:test suites (auth, isolation, memory,
                                 behavior, config, chat, widget, keys)
```

### Multi-tenancy

Every row is scoped by `business_id`. The principal's business is resolved **only**
from the authenticated key/token — never from request bodies. All store functions
require `businessId` and filter on it. Tests assert cross-tenant invisibility.

### Memory model

- **Explicit facts** ("my name is Alex") — stored when the field is in the business's
  allow-list; `origin: explicit`
- **User-requested facts** ("remember my favorite team is X") — always stored;
  `source: user_request`
- **Forget commands** ("forget my shoe size") — delete immediately
- Inferred/behavioral signals are kept separate and labeled as *signals*, never facts

### Context engine

Conversation window + ranked memories + ranked behavior + retrieved knowledge are
assembled under a token budget (`context.maxContextTokens`, estimated chars/4).
Lowest-value items drop first (behavior → knowledge → weakest memory). Latest explicit
user statements outrank older memories inside the prompt rules.

### Agent roles

`customer_support · sales · shopping_assistant · product_advisor · booking_assistant ·
lead_qualification · general_assistant · custom`

Roles are configuration data (objective/tone/guidelines/capabilities) consumed by the
single prompt builder — there is no per-role code path.

---

## API overview

All errors return `{ "error": { "code", "message" }, "requestId" }`.

### Platform API — `Authorization: Bearer xeven_pk_…` (or `x-xeven-key`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | public health |
| POST | `/api/v1/chat` | chat: `{customer:{id,…}, messages[], conversationId?}` |
| GET/PATCH | `/api/v1/business` | identity/status |
| PUT | `/api/v1/config` | update config (validated deep-merge) |
| GET/POST | `/api/v1/config/export` · `/config/import` | portable config |
| POST | `/api/v1/business/rotate-key` | rotate integration key |
| GET | `/api/v1/customers` · `/:id` | profiles |
| DELETE | `/api/v1/customers/:id` | full erasure (memories+behavior+chats) |
| GET/DELETE | `/api/v1/customers/:id/memories[/:key]` | memory management |
| GET/DELETE | `/api/v1/customers/:id/behavior[/:eventId]` | behavior management |
| GET | `/api/v1/customers/:id/conversations` | history index |
| POST/GET | `/api/v1/behavior` | ingest/list events |
| CRUD | `/api/v1/knowledge[/:id]` · `/knowledge/search` | knowledge base |
| GET | `/api/v1/analytics/summary` | usage stats |

### Widget (browser) — same key, sanitized surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/widget/config` | assistant name/welcome only |
| POST | `/api/v1/widget/chat` | anonymous visitor chat |

### Admin dashboard API — `Authorization: Bearer <token>`

`POST /api/admin/auth/register` (first account = super admin) · `/login` · `GET /auth/me`
· `GET/POST /api/admin/businesses` · `GET/PATCH /businesses/:id` ·
`/businesses/:id/rotate-key` · `/analytics` · `/audit` · knowledge/customer management.

Non-super admins can only touch businesses they created or were granted.

---

## Security posture

- Integration keys: 64-hex secrets, timing-safe lookups, instant rotation & deactivation
- Admin passwords: scrypt-hashed; tokens: HMAC-signed with expiry; secret auto-generated
- Rate limiting per business/IP, body-size caps, security headers, CORS configurable
- Prompt-injection hardening: memories/behavior/knowledge injected as *data* with
  explicit non-instruction rules; message roles whitelisted server-side
- Redacting logger (keys/tokens/passwords never hit logs); audit trail of admin actions
- Full deletion rights per customer (right-to-erasure)

## Deployment

- `NODE_ENV=production` enables HSTS and tighter log defaults
- Set `XEVEN_ADMIN_TOKEN_SECRET` explicitly in production (or rely on DB-persisted secret)
- Put XEVEN behind TLS; set `XEVEN_CORS_ORIGIN` to your site origins if you don't need
  arbitrary embedding
- SQLite (WAL) suits small/medium deployments; the data layer is isolated in `src/db`
  so a Postgres adapter can replace it without touching business logic
- Postgres path (when you outgrow SQLite): `pg` is already a dependency.
  Set `DB_DRIVER=postgres` plus `PG_HOST` / `PG_PORT` / `PG_DATABASE` /
  `PG_USER` / `PG_PASSWORD` (`PG_SSL=true` for managed hosts). The
  versioned `schema_migrations` runner in `server/src/db/schema.js` is the
  pattern to follow: add one migration per schema change, backfill existing
  rows inside the migration, never edit an applied migration. Migrate data
  with an offline dump/load window — there is no live replication.
- Integration keys are split: the website snippet embeds the **publishable**
  key (`xeven_pk_pub_…`, widget-scoped), while the **secret** key
  (`xeven_pk_sec_…`) stays in the dashboard for API/SDK management. Legacy
  `xeven_pk_…` keys keep full access. Rotating invalidates the secret only;
  the publishable key is stable so deployed snippets keep working
