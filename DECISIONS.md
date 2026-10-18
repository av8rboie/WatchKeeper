# Decisions

Choices the build spec leaves open, and places where the build departs from
it. Newest milestone last. Each entry says what was decided and why.

## M1: Foundation

### Repo and tooling

**Repo root is the monorepo root.** The spec's layout puts everything under
`data-hub/`. This repo is `WatchKeeper`, so `apps/`, `packages/`, `design/`
and `deploy/` sit at the top level instead of one directory down.

**TypeScript pinned to 5.x.** A plain `pnpm add typescript` installed 7.0.2.
The spec names TypeScript 5, so the root `devDependencies` pin `^5`.

**`@watchkeeper/shared` ships TypeScript source.** Vite and Vitest consume it
directly; `tsup` bundles it into the server build (`noExternal`). No separate
build step for the shared package.

**`better-sqlite3` is not in `onlyBuiltDependencies`.** Version 13 ships
prebuilt binaries for `linux-arm64` (the Pi), `win32-x64` and others inside
the package. Allowing its build script makes pnpm run `node-gyp rebuild`,
which needs a compiler toolchain and Node headers from the internet. Skipping
it uses the bundled binary.

### Signal K

**Derived values live under the vendor prefix `dataHub.*`.** Signal K defines
no `performance.*` path for any of the spec's derived values (total fuel
rate, range, net current, time to empty, distance run, 24 h run, set and
drift, pressure tendency). The full list is `DERIVED_PATHS` in
`packages/shared/src/paths.ts`, and the outbound allowlist is exactly that
list plus `notifications.app.*`.

**Authentication header.** The backend sends `Authorization: Bearer <token>`
on the stream and REST calls. Verified against Signal K 2.33.0, which also
accepts `JWT <token>` and `?token=`.

**Signal K 2.33 requires authentication by default.** A fresh server with no
users reports `authenticationRequired: true` and serves nothing to anonymous
clients. The access-request flow is therefore the normal path, not an edge
case. The backend submits two requests on first run: "Data Hub (backend)"
for readwrite and "Data Hub (browsers, read only)" for readonly. When the
backend token arrives, a connection made before approval is dropped and
reopened with the token, because an unauthenticated stream receives no data.

**Browser Signal K token is long-lived, not short-lived.** The spec asks for a
short-lived read token. Signal K's access-request flow issues tokens with an
expiry set by the approver (the dev setup used `NEVER`), and there is no API
for the backend to mint scoped short-lived tokens from its own. The browser
gets the separately approved read-only token instead, and only after logging
in to Data Hub. Open item: revisit if Signal K adds token delegation.

**Subscribe message shape.** Signal K 2.33 replies "period assumes policy
'fixed', ignoring policy instant" to the spec's message shape
(`period: 1000, policy: "instant"`). The subscription still works with the
fixed 1 s period. Kept as specified.

**Only our own vessel's deltas are stored.** The stream can carry other
vessels (AIS targets). The client accepts deltas with context `vessels.self`
or the `self` URN from Signal K's hello message, and drops the rest.

**Placeholder instance ids.** Until the skipper confirms the real ones, the
catalog uses `port` and `starboard` for engines, `house` for the battery
bank, `main` for solar, and fuel tanks `port` and `starboard` plus fresh water
`main`. Stored in the `instanceIds` setting.

**Signal K URL is set at install, not in the setup screen.** `SIGNALK_URL` in
`/etc/data-hub/data-hub.env`. Setup shows the URL read-only with connection
and approval status. Changing it means editing the env file and restarting.

### History recorder

**Rows only for paths seen since startup.** Recording a row per second for
every catalog path, including sensors the boat doesn't have, would write
about 2.6 million empty rows a day. Paths that have published at least once
get a row every second, `null` while stale.

**Positions are stored as two numeric series**, `navigation.position.latitude`
and `.longitude`, because the sample tables hold one `REAL` per row. String
paths (engine state, autopilot state) are not written to the history tables.

**Sampling instant.** The recorder ticks once per second and stamps the row
with the start of that second. A value is fresh for a row if its age at the
tick is within the path's timeout.

**Rollup timing.** Each 1 min and 10 min bucket rolls up as soon as the first
sample after it is written. Retention runs after each 10 min rollup.

### Database

**Additions to the starting migration**, all permitted by the spec:
a `session` table (id is the SHA-256 of the cookie token), `failed_pins` and
`locked_until` on `user` for the PIN lockout, timestamp indexes on
`sample_1s` and `sample_1m`, and a `schema_migration` bookkeeping table.

**Sample timestamps are epoch milliseconds**, as the spec's `INTEGER ts`
implies. Every other timestamp is an ISO 8601 UTC string.

### API and auth

**Routes added beyond the spec's table:** `GET /setup/status` and
`POST /setup/skipper` for first run (the second refuses with 403 once any
user exists), `PUT /auth/me/units`, and `POST /users`, `PUT /users/:id`,
`DELETE /users/:id` for skipper user management.

**Public write routes.** Login, logout and first-run setup accept anonymous
calls. The role test exempts exactly these three and checks that every other
write route returns 403 for guests.

**Guests cannot change their units.** Saving unit preferences is a write, and
the spec gives guests read-only access. Guests see the defaults.

**Every route declares its minimum role.** `buildApp` throws at startup if an
`/api/v1` route has none, so a new route cannot ship unguarded by accident.

### Frontend and design system

**Sidebar tokens added from the mockups.** The desktop sidebar mockup uses
colors not in the spec's token table. Added as `--nav-title` (#FFFFFF),
`--nav-ink` (#DCE4E8), `--nav-sub` (#B9C6CD), `--nav-line` (#2A3E4C) and
`--nav-good` (#4CC08E), with night values taken from the existing night
palette. Also `--on-accent` for text on accent buttons (white by day, black
at night). These come from the visual source of truth, not new design.

**Status strip on desktop is the sidebar footer**, as in the desktop mockups.
On phone and tablet portrait it is a row at the top with the night toggle.

**Night mode is exempt from the 4.5:1 contrast rule.** It is deliberately low
contrast to keep night vision. Day mode meets 4.5:1.

**Clock status says nothing when unknown.** If chrony isn't reporting (dev
machines, or chrony not installed), the status shows no clock claim rather
than "synced".

**Fonts bundle the Latin subset only**, to keep the precache small.

**Placeholder screens name their milestone.** Routes for M2 to M5 exist so
navigation works, and each says which milestone delivers it.

**Not yet built from the M1 shell list:** automatic night mode at sunset and
sunrise (marked optional in the spec; planned with the settings work) and
Screen Wake Lock (needs dashboards, M2).

### Tests

**The 60 s Signal K outage is scaled to 1.5 s** in the connection test. The
gap and staleness logic don't depend on the duration, and the reconnect
backoff is shortened to match.

**The 2-hour fixture is generated at test time** from a deterministic
generator (`apps/server/test/helpers/fixtures.ts`) and replayed through the
JSONL reader, rather than committed (about 7 MB). Two 2-minute fixtures are
committed in `apps/server/test/fixtures/`; regenerate them with
`scripts/make-fixtures.ts`.

**Playwright screenshots are for review, not pixel diffs.** The spec asks for
a screenshot review at 390 px and 1440 px. Tests write screenshots to
`apps/web/test/screenshots/` and assert layout facts (tab bar height 72 px,
sidebar width 240 px, theme colors) instead of comparing pixels.

### Ops

**chrony is installed but its GPS refclock is not configured.** The right
refclock (gpsd SHM, PPS, or a Signal K bridge) depends on the receiver, which
isn't chosen yet. `install.sh` installs and enables chrony; the backend
reports its sync state.

**`install.sh` builds from a checkout on the Pi.** Release tarballs and
`data-hub update` arrive in M6.

**Not yet verified on hardware:** `install.sh`, the Caddyfile, the systemd
unit and the watchdog. They need a Pi.

### Development environment

**`docker-compose.yml` runs Signal K with `--sample-n2k-data`.** The flag is
confirmed in the Signal K command-line docs. That data set has navigation,
wind and depth, but no engine or tank paths under our instance ids.
