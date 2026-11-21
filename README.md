# NovaChat message-service

The NovaChat message service. Shared code comes from [`NovaChat-Enterprise-ERP/packages`](https://github.com/NovaChat-Enterprise-ERP/packages).

## Setup

Dependencies under `@novachat-enterprise-erp` are served from GitHub Packages, which requires a token even for public packages. Create a classic personal access token with the `read:packages` scope and add it to `~/.npmrc`:

```
//npm.pkg.github.com/:_authToken=<token>
```

Then:

```sh
cp .env.example .env
pnpm install
pnpm db:migrate
pnpm dev
```

## Scripts

- `pnpm dev`
- `pnpm build`
- `pnpm start`
- `pnpm test`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm db:generate`
- `pnpm db:migrate`

## Events (transactional outbox)

Domain events are not sent to Redis directly. Services publish through `repos.events` inside `uow.transaction(...)`, which inserts the event into `messaging.outbox` in the same database transaction as the change it describes. If the transaction rolls back, the event is never sent. If the process dies after commit, the event is still sent later.

`OutboxRelay` (started in `server.ts`) moves committed rows to the `novachat:events` stream in `seq` order:

- A commit in this process wakes it immediately. Otherwise it polls every second, which picks up rows left by other replicas or by a crash.
- With several replicas, a Postgres advisory lock lets only one relay run at a time, which keeps events in order.
- Delivery is at-least-once, and an event keeps its `id` across retries, so consumers can de-duplicate on `event.id`.
- If Redis fails, the relay keeps what it has already sent, records `attempts`/`last_error` on the stuck row, and backs off for up to 30s.
- Published rows are deleted after 24h.

To see the backlog: `select count(*), min(created_at) from messaging.outbox where published_at is null;`

In tests the relay is not started. Call `h.flushEvents()` before asserting on `h.events`.

## Docker

```sh
docker build --secret id=npmrc,src=$HOME/.npmrc -t novachat/message-service .
```
