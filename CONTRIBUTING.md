# Contributing to Bookrail

Bookrail is booking infrastructure: an availability and booking engine, an HTTP API, a CLI, an
MCP server and a TypeScript SDK. The promise the whole thing is built on is that a slot is
never given away twice, so most of what follows is about how that promise is kept while the
code changes.

Issues, questions and pull requests are all welcome. If you are unsure whether something is a
bug or a design decision, open an issue and ask; the answer is usually written down somewhere
and the issue is where it becomes findable.

## The short version

```bash
git clone https://github.com/bookrail-dev/bookrail.git
cd bookrail
pnpm install

export DATABASE_URL=postgres://localhost:5432/bookrail_dev
export REDIS_URL=redis://localhost:6379

pnpm db:migrate
pnpm test
```

Then, before you open a pull request:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm format:check && pnpm build
```

That is exactly what CI runs, in that order.

## What you need

- **Node 20.10 or newer.** The version is declared in `engines` and CI runs on Node 20.
- **pnpm.** The exact version is in the `packageManager` field of the root `package.json`.
  `corepack enable` picks it up for you.
- **PostgreSQL 16 or newer**, and 17 is what development and CI run. The suites use a real database, never a
  mock. They create and drop their own throwaway databases next to the one `DATABASE_URL`
  points at, so point it at a local cluster you do not mind being written to.
- **Redis, optional.** Without `REDIS_URL` the availability cache lives in process memory and
  the cache suites use it. With it, they use the real thing on logical database 15 and
  `FLUSHDB` between runs.
- **Docker, not required.** There is no container in the development loop, and the project is
  developed against a Postgres and a Redis installed natively. If you would rather not install
  either, `infra/docker-compose.yml` starts both at the versions CI runs:

  ```bash
  docker compose -f infra/docker-compose.yml up -d
  export DATABASE_URL=postgres://bookrail:bookrail@localhost:5432/bookrail_dev
  export REDIS_URL=redis://localhost:6379
  ```

`.env.example` is the full list of environment variables, each with the reason it exists and a
placeholder where a value would go. Copy it to `.env` and fill in what you need; the two
exports above are enough to run the suite.

## Running the tests

| Command | What it does |
| --- | --- |
| `pnpm test` | Everything, one package at a time. |
| `pnpm --filter @bookrail/engine test` | One package. |
| `pnpm test:concurrency` | 200 simultaneous requests on one slot, in separate processes, twenty rounds. Run it before touching the booking transaction. |
| `pnpm bench` | The availability benchmark. |
| `pnpm --filter site test` | The site: it builds `dist` first and then asserts on it. Two of its suites drive a browser through Playwright and use the Chrome installed on your machine; set `PLAYWRIGHT_CHANNEL=chromium` to use Playwright's own build instead. |

Integration tests use a real Postgres on purpose. A mocked database cannot fail the way a real
one does, and the guarantees that matter here are enforced by the database: an exclusion
constraint for capacity 1, a trigger for capacity N, row level security on every table.

## The rules a change has to keep

1. **No test is skipped and no database is mocked.** If a test is hard to write against a real
   Postgres, that is usually a sign about the design, not about the test.
2. **The guarantees live in the schema.** A check that exists only in TypeScript is a check
   that a second writer can walk around.
3. **Migrations are append only.** Every file in `packages/db/migrations/` is checksummed when
   it is applied, and the runner refuses a database whose ledger disagrees with the files. That
   means an applied migration can never be edited again, not even its comments: add a new one.
   Two migrations still name the product's former name for exactly this reason, and one of them
   is the migration that performed the rename.
4. **Comments explain themselves.** A comment that points at a private tracker, a review thread,
   a work item number or a document that is not in this repository is a dead link for everybody
   reading it. Write the reason itself instead, in one or two sentences; the numbers, the error
   codes and the names stay. A test (`packages/shared/test/public-sources.test.ts`) fails on
   those pointers, and it reads each file three times, as it is written and with the lines
   joined two ways, because a line break is not a hiding place. The one exception is
   `packages/db/migrations/`, frozen by the rule above: an applied migration cannot be edited,
   comments included, so a handful of them still cite documents that are not here. New
   migrations are written to this rule from the start.
5. **No em dash anywhere in the code**: the documentation, the site, CLI and MCP output, error
   messages, commit messages, and the comments in the source, which are read on GitHub by
   anybody looking at how this works. Use a comma, a colon, a full stop or brackets. Permanent
   tests enforce it and they run in CI. The one exception is `packages/db/migrations/`, frozen
   by the rule above; new migrations are written to this rule from the start.
6. **English everywhere in the code**: identifiers, comments, messages, documentation.
7. **No new runtime dependency without a reason in the pull request.** `@bookrail/node` has
   one, `@bookrail/webhook-signature` has none, and both numbers are asserted by a test.

## Style

Prettier and ESLint decide the shape; `pnpm format` fixes it. Beyond that: `any` is a lint
error, `catch` blocks say what they are catching, and a comment explains **why** rather than
restating what the line does.

## Commits and the DCO

Bookrail uses the [Developer Certificate of Origin](https://developercertificate.org/), not a
contributor licence agreement. Sign off every commit:

```bash
git commit -s -m "engine: keep the grid anchored to the opening bands"
```

`-s` adds one line to the message:

```
Signed-off-by: Your Name <you@example.com>
```

That line is you saying you wrote the change, or have the right to submit it, and that it may
be distributed under the licence of this project. It costs one flag and no paperwork, which is
why it is the choice here.

Two things a commit message must not contain: an em dash, and a co-author or generated-by
trailer naming an assistant. The author of a commit is the person who signs the DCO.

Commit messages are plain: a short subject line in the imperative, a blank line, and as much
body as the change deserves. Reference an issue with `#123` when there is one.

## Pull requests

- One subject per pull request. A refactor and a behaviour change in the same diff cannot be
  reviewed, and cannot be reverted separately either.
- Describe the behaviour that changes, not the files that changed.
- Add the test first when you can. A bug fix without a test that fails before it is a bug fix
  that comes back.
- Update the documentation in the same pull request. The CLI's pages live in
  `packages/cli/docs/`, the SDK's reference is `packages/sdk-node/README.md`, and both are
  published to the site from where they live; a divergence fails the site's tests.
- CI has to be green. It runs lint, typecheck, the full suite against Postgres and Redis,
  the formatting check and the build.

## Security

Do not open a public issue for a vulnerability. `SECURITY.md` says how to report one.

## Licence

By contributing you agree that your contribution is licensed under the Apache License 2.0, the
licence of this repository.
