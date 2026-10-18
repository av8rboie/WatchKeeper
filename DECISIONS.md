# Decisions

Choices the build spec leaves open, and places where the build departs from
it. Each entry says what was decided and why. The spec moved from a
Raspberry Pi with systemd to a Home Assistant add-on on HAOS after the first
M1 build; entries that only applied to the old target were removed.

## M1: Foundation

### Repo and tooling

**Repo root is the monorepo root.** The spec's layout puts everything under
`data-hub/`. This repo is `WatchKeeper`, so `repository.yaml`, `addon/`,
`apps/` and `packages/` sit at the top level instead of one directory down.

**TypeScript pinned to 5.x.** A plain `pnpm add typescript` installed 7.0.2.
The spec names TypeScript 5, so the root `devDependencies` pin `^5`.

**`@watchkeeper/shared` ships TypeScript source.** Vite and Vitest consume it
directly; `tsup` bundles it into the server build. No separate build step.

**`better-sqlite3` is not in `onlyBuiltDependencies`.** Version 13 and
`argon2` both ship prebuilt `linux-arm64` and `linux-x64` binaries inside the
package. Letting pnpm run the build script triggers `node-gyp rebuild`, which
needs a compiler toolchain. Skipping it uses the bundled binaries.

**The first migration was amended, not appended to.** M1 for the Pi was
never deployed, so `001_init.sql` was edited for HA users (a `mapped` flag,
`last_seen`) and PIN elevations (`session.ha_user_id`). From the first
released image onward, migrations are forward-only, as the spec requires.

### Add-on packaging

**One build, two images.** Because the native modules ship prebuilt binaries
for both architectures, the Dockerfile's build stage runs once on the CI
runner's own platform (`--platform=$BUILDPLATFORM`) and both the aarch64 and
amd64 images copy the same output. Nothing compiles under emulation or on
the device.

**Image name and tag.** `ghcr.io/av8rboie/data-hub-{arch}`, tagged with the
add-on `version`, as the HA add-on reference describes (`image` has no tag;
the Supervisor uses `version`). CI also pushes `latest`.

**Base image is `node:22-bookworm-slim`**, glibc, matching the prebuilt
binaries. The image is about 405 MB; slimming it is a follow-up.

**`run.sh` doesn't parse options.** The backend reads `/data/options.json`
itself (`config.ts`), so dev and tests use the same code path with
environment overrides. `run.sh` only sets the data directory and port.

**`signalk_url` default is the spec's placeholder.** The Signal K add-on's
hostname depends on which repository it was installed from, so the skipper
copies it from that add-on's info page. Not guessed.

**`init: false`, so Node is PID 1.** It handles SIGTERM itself and spawns no
long-lived children. The snapshot hook runs as a separate process started by
the Supervisor.

**GPIO access is not settled.** The spec's `gpio: true` maps
`/sys/class/gpio`. Driving pins through libgpiod usually needs the
`/dev/gpiochip*` devices mapped as well. Decide in M5 with the actual sounder
and UPS HAT.

**HA backups.** `backup: hot` with the live database and WAL excluded. The
`backup_pre` hook (`/usr/bin/data-hub-snapshot`) writes a consistent copy with
SQLite's online backup API to `/data/snapshot/data-hub.db`, via a temp file
and an atomic rename. On startup, a missing live database is restored from
the snapshot.

### Signal K

**Rate classes as in the spec**, plus three paths the spec's table doesn't
place: `navigation.datetime` is medium (5 s) with a 15 s catalog timeout,
since GPS time is extrapolated between updates; `navigation.anchor.position`
is very slow; derived values are mostly slow, with net current and set and
drift at medium.

**Derived values live under the vendor prefix `dataHub.*`.** Signal K defines
no `performance.*` path for any of the spec's derived values. The outbound
allowlist is exactly `DERIVED_PATHS` plus `notifications.app.*`.

**Signal K 2.33 requires authentication by default.** A fresh server with no
users serves nothing to anonymous clients, so the access-request flow is the
normal path. When the token arrives, a connection made before approval is
dropped and reopened with it, because an unauthenticated stream gets no data.
Verified against Signal K 2.33.0 in Docker.

**Authentication header is `Authorization: Bearer <token>`.** Verified against
2.33.0, which also accepts `JWT <token>` and `?token=`.

**Subscribe message shape.** Signal K 2.33 replies "period assumes policy
'fixed', ignoring policy instant" to the spec's shape. The subscription still
delivers at the requested period. Kept as specified.

**Only our own vessel's deltas are stored.** The client accepts context
`vessels.self` or the `self` URN from Signal K's hello message, and drops the
rest (AIS targets).

**Placeholder instance ids** until the skipper confirms them: engines `port`
and `starboard`, battery `house`, solar `main`, fuel tanks `port` and
`starboard`, fresh water `main`.

### History recorder

**Rows only for paths seen since startup**, `null` while stale. Recording
every catalog path whether or not the boat has the sensor would write rows
for nothing.

**1 min rows are aggregated in memory.** Every recordable path is sampled
once a second into an in-memory minute accumulator (sum, count, min, max);
fast-class paths are also buffered at 1 s. Everything goes to disk in one
transaction every 10 s. The 10 min rollup and retention run inside that
flush. On shutdown the partial minute is written so nothing is lost.

**Positions are two numeric series**, `.latitude` and `.longitude`. String
paths are not written to the history tables.

### Auth through HA ingress

**Trust is by socket address only.** The ingress check uses the TCP peer
address, never `X-Forwarded-For`. Requests from anywhere but 172.30.32.2 get
403 before any route runs. The one exception is `/api/v1/health`, which the
watchdog calls and which reveals nothing.

**HA users appear on first request**, as unmapped guests. The skipper maps
them to roles. The last skipper can't be demoted.

**First run: the first HA user to claim becomes skipper.** Ingress headers
don't say whether a user is an HA admin, so `POST /setup/claim` gives the
role to whoever claims it while no skipper exists, then closes.

**Helm PIN elevation.** A crew member sets their own PIN (through the
skipper's role mapping). On a shared device signed in to HA as a guest, they
pick their name and enter the PIN. The device then acts as that crew member
for 12 hours: the role is capped at crew, and anything recorded is recorded
under their name. The elevation is an HttpOnly cookie bound to the HA user
who entered it, so it does nothing in another HA user's session. PINs are
argon2id, with a 5-minute lock after 5 bad PINs.

**Guest write routes.** Exactly two: `POST /auth/pin` (elevation itself) and
`POST /setup/claim` (refused once a skipper exists). The role test checks
that every other write route returns 403 for a guest.

**Units are saved per HA user.** Guests and elevated devices use their HA
user's units and can't change them.

### Live values

**Live batches carry the server's time.** Each `{type: "live"}` message adds
`now`. The browser ages a value as (now - ts) plus local time since receipt,
so a phone with a wrong clock still judges staleness right.

**When the socket drops, values stay on screen** and go stale as their
effective timeouts pass, with a "Reconnecting" strip, as the spec says.

### Frontend

**The base path is injected by the backend.** HA sends the ingress path in
`X-Ingress-Path`; the backend serves `index.html` with
`<base href="{ingress path}/">`. Vite builds with `base: './'`, the router's
basename comes from `document.baseURI`, and every API and WebSocket URL is
resolved against it. In dev, a Vite plugin injects the same tag for the fixed
dev prefix `/api/hassio_ingress/dev`.

**No PWA.** Removed as the spec requires; the HA companion app provides the
home-screen app.

**Sidebar tokens added from the mockups**: `--nav-title`, `--nav-ink`,
`--nav-sub`, `--nav-line`, `--nav-good`, and `--on-accent`, with night values
from the night palette. They come from the desktop sidebar mockup.

**Night mode is exempt from the 4.5:1 contrast rule.** Deliberately low
contrast to keep night vision.

**Fonts bundle the Latin subset only.**

**Placeholder screens name their milestone** so navigation works end to end.

### Home Assistant

**CPU temperature** comes from HA's System Monitor sensor, entity
`sensor.system_monitor_processor_temperature` by default (stored in the
`cpuTempEntity` setting), with `/sys/class/thermal/thermal_zone0/temp` as a
fallback. Open item: confirm the entity id on the boat's HA install.

**Not yet built:** the five summary entities, companion app notifications,
the CPU temperature alarm and UPS shutdown. The `ha/` client and its fake are
in place; those features arrive with the milestones that need them.

### Tests

**The 60 s Signal K outage is scaled to 1.5 s** in the connection test. The
gap and staleness logic don't depend on the duration.

**The 2-hour fixture is generated at test time** from a deterministic
generator and replayed through the JSONL reader, rather than committed.

**End-to-end tests run under a random ingress prefix.** A test ingress proxy
mounts the app at `/api/hassio_ingress/<random>`, strips the prefix and
injects HA user headers, like the Supervisor. Tests switch HA users with a
`ha_user` cookie that only the proxy reads.

**Playwright screenshots are for review, not pixel diffs.** Tests assert
layout facts (tab bar 72 px, sidebar 240 px, theme colors) and write
screenshots to `apps/web/test/screenshots/`.

**Not yet verified:** installing from the add-on repository on a HAOS VM, the
aarch64 image, and anything on the boat. The amd64 image was built and run
locally: options, health, the ingress-only rejection and the snapshot hook
all behaved.
