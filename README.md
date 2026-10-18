# WatchKeeper (Catamaran Data Hub)

A Home Assistant add-on for a sailing catamaran. It reads the boat's
instruments from the Signal K add-on on the same HAOS host and provides
dashboards, an automatic hourly logbook, maintenance tracking, anchor watch
and checklists. People open it through HA ingress: in the HA companion app on
phones, or in a browser at the nav station. It works with no internet.

The build spec is `Catamaran Data Hub Build Spec.pdf`. Choices the spec
leaves open are in `DECISIONS.md`. Mockups are in `design/mockups/`.

## Status

| Milestone | State |
| --- | --- |
| M1 Foundation | Built for HAOS. Automated criteria pass; HAOS VM install and on-boat checks pending. |
| M2 Dashboards | Not started |
| M3 Logbook | Not started |
| M4 Maintenance | Not started |
| M5 Anchor watch and checklists | Not started |
| M6 Hardening | Not started |

## Install in Home Assistant

See `addon/DOCS.md`. In short: add `https://github.com/av8rboie/WatchKeeper`
as an add-on repository, install Data Hub, set `signalk_url` to the Signal K
add-on's hostname on port 3000, start it, approve "Data Hub" in Signal K's
Access Requests, and claim the skipper role on first open.

## Layout

```
repository.yaml   HA add-on repository manifest
addon/            config.yaml, Dockerfile, run.sh, snapshot hook, docs, images
apps/server       Fastify backend: Signal K client, recorder, ingress auth, REST, live WebSocket
apps/web          React app, served by the backend under the ingress path
packages/shared   Zod schemas, path catalog with rate classes, unit conversion
design/mockups    Exported mockups (visual source of truth)
.github/workflows CI: tests, then multi-arch images to GHCR
```

## Development

Requires Node.js 22, pnpm 10 and Docker.

```sh
pnpm install
pnpm dev
```

This starts Signal K in Docker with sample data, the backend on :8099, Vite
on :5173, and a dev ingress proxy. Open
http://localhost:5180/api/hassio_ingress/dev/. The proxy plays HA's ingress:
it injects a dev HA user (switch users with a `ha_user=id|Name` cookie).

Signal K 2.33 requires authentication even on a fresh install. Create an
admin user in its UI at http://localhost:3000, then approve "Data Hub" under
Security, then Access Requests.

```sh
pnpm test         # unit and API tests (Vitest)
pnpm test:e2e     # Playwright under a random ingress prefix, phone and desktop viewports
pnpm typecheck
docker build -f addon/Dockerfile .   # the add-on image
```

Build the web app before the end-to-end tests
(`pnpm --filter @watchkeeper/web build`).

Behind a TLS-inspecting proxy, Node may fail downloads with
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. Set `NODE_OPTIONS=--use-system-ca` for
installs.

## Releases

Bump `version` in `addon/config.yaml` and push to `main`. CI runs the tests,
then builds `ghcr.io/av8rboie/data-hub-aarch64` and `-amd64` tagged with that
version. The GHCR packages must be public for HA to pull them without
credentials.
