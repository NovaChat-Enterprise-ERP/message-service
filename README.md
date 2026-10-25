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

## Docker

```sh
docker build --secret id=npmrc,src=$HOME/.npmrc -t novachat/message-service .
```
