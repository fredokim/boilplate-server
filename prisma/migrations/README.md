# Migrations

Empty on purpose. `schema.prisma` declares no models in this step, so there is
nothing to migrate yet — see the comment at the top of that file.

The first migration arrives with the first domain module:

```bash
npm run db:up                       # start local PostgreSQL
npm run prisma:migrate -- --name add_auth
```

`prisma migrate dev` writes a timestamped directory here and applies it to the
local database. In deployment, apply the committed migrations with
`npm run prisma:deploy`, which never generates or edits anything.
