# invoice-service

A small invoice API for the bookings team. It prices bookings from a rate card,
picks the invoice currency from billing config and serves invoices as JSON.

## Quick start

Requires Node 22 (see `.nvmrc`).

```sh
npm ci
npm start
curl http://localhost:4100/health
curl http://localhost:4100/invoices
curl http://localhost:4100/invoices/B-1041
```

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | Serves on port 4100 (`PORT` overrides). |
| `npm test` | Runs the vitest suite. |
| `npm run lint` | Runs eslint. |
| `npm run typecheck` | Runs `tsc --noEmit`. |
| `npm run check` | Lint, typecheck, then test. CI runs the same. |

`BILLING_CURRENCIES` (for example `EUR,GBP,USD`) overrides the enabled billing
currencies in `config/billing.json`.

See `docs/service.md` for the endpoints and billing rules, and `AGENTS.md` for
how to work in this repo.

## Demo tooling

The repo also carries the tooling for a live demo, run from this laptop:

| Part | Where | What it does |
| --- | --- | --- |
| Monitor | `monitor/` | Checks every staging invoice against the rate card every 2 s; posts one FIRING alert to Slack on a mismatch and RESOLVED in its thread once fixed. |
| `./demo.sh` | `demo/cli/` | `doctor`, `up`, `down`, `break`, `reset`, `replay`, `times`; each takes `--help` and `--dry-run`. |
| Deploy watcher | `demo/deploy/` | Puts each new `main` commit on staging once its CI has passed. |
| Loop screen | `demo/loop/` | The live view of the loop. |
| Setup | `SETUP.md` | Phases P0 to P8, each with a `./demo.sh doctor --phase Pn` check. |

Values live in `demo/.env` (git-ignored; template `values.example.env`) and
runtime state in `demo/state/` (git-ignored). Staging is a copy of `main` in
`demo/state/staging/`, served on port 4100 with its own `BILLING_CURRENCIES`.
