# Data Hub

Dashboards, an automatic hourly logbook, maintenance tracking, anchor watch
and checklists for the boat. Data Hub reads from the Signal K add-on on the
same Home Assistant host and works with no internet connection.

## Install

1. Install and start the Signal K add-on.
2. In Home Assistant, go to Settings, Add-ons, Add-on store, and add this
   repository: `https://github.com/av8rboie/WatchKeeper`.
3. Install Data Hub. On the Configuration tab, set `signalk_url` to the
   Signal K add-on's hostname on port 3000 (shown on its info page).
4. Start Data Hub and open it from the sidebar.
5. In the Signal K admin UI, under Security, then Access Requests, approve
   "Data Hub" with read/write permission.
6. The first person to open Data Hub claims the skipper role, then maps
   everyone else to crew or guest.

Updates need internet only to download the new image. Plan them at the dock.
Home Assistant can take a backup first; rolling back is restoring that backup.

## Keep instrument data out of Home Assistant's recorder

Data Hub keeps its own history. It publishes only five summary entities to
Home Assistant. If you also run a Signal K integration in Home Assistant,
trim the recorder so it doesn't write every instrument value to disk:

```yaml
recorder:
  commit_interval: 30
  purge_keep_days: 7
  exclude:
    entity_globs:
      - sensor.signalk_*
```

## Hardware

Run the host in a ventilated, dry spot, never the engine room or a sealed
locker. Install HA's System Monitor integration so Data Hub can read the CPU
temperature; it warns at 70 °C and alarms at 78 °C, before a Pi 5 throttles.
Fit the Pi 5 RTC battery so the clock survives a cold start. The logbook uses
GPS time either way.

## Remote access

Not required. If wanted, use Home Assistant's own options (Nabu Casa or a
Tailscale add-on). Data Hub exposes no ports outside ingress.
