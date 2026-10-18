# WatchKeeper (Catamaran Data Hub)

A self-hosted web app for a Raspberry Pi aboard a sailing catamaran. It reads
instruments from Signal K and provides dashboards, an automatic hourly
logbook, maintenance tracking, anchor watch and checklists. It works with no
internet connection, on phones in the cockpit and on a laptop at the nav
station.

The full build spec is in `Catamaran Data Hub Build Spec.md`. Choices the
spec leaves open are in `DECISIONS.md`. Mockups are in `design/mockups/`.

## Status

| Milestone | State |
| --- | --- |
| M1 Foundation | Built. Automated criteria pass; on-boat criteria pending. |
| M2 Dashboards | Not started |
| M3 Logbook | Not started |
| M4 Maintenance | Not started |
| M5 Anchor watch and checklists | Not started |
| M6 Hardening | Not started |

## Layout

```
apps/server     Fastify backend: Signal K client, recorder, auth, REST, events
apps/web        React PWA
packages/shared Zod schemas, path catalog, unit conversion
deploy/         install.sh, Caddyfile, systemd unit
design/mockups  Exported mockups (visual source of truth)
```

## Development

Requires Node.js 22, pnpm 10 and Docker.

```sh
pnpm install
pnpm dev          # Signal K in Docker, backend on :8080, Vite on :5173
```

Signal K 2.33 requires authentication even on a fresh install. On first run
the backend files two access requests. Create an admin user in the Signal K
admin UI at http://localhost:3000, then approve "Data Hub (backend)" and
"Data Hub (browsers, read only)" under Security > Access Requests. Open
http://localhost:5173 and the setup screen creates the skipper account.

```sh
pnpm test         # unit and API tests (Vitest)
pnpm test:e2e     # Playwright, phone and desktop viewports
pnpm typecheck
pnpm build
```

The end-to-end tests start their own server with a fake Signal K and seeded
users (Skipper 1111, Crew 2222, Guest 3333). Build the web app first
(`pnpm --filter @watchkeeper/web build`).

Behind a TLS-inspecting proxy, Node may fail downloads with
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. Set `NODE_OPTIONS=--use-system-ca` for
installs.

## Install on the Pi

On a Raspberry Pi 5 with Raspberry Pi OS Lite 64-bit and Signal K installed:

```sh
git clone https://github.com/av8rboie/WatchKeeper.git
cd WatchKeeper
sudo deploy/install.sh
```

The script is safe to re-run. It prints the HTTPS address and where to
download the root certificate that each phone and laptop must trust once.
