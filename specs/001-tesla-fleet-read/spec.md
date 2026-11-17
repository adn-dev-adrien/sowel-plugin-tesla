# Spec 001 — Tesla through the official Fleet API, read-only, on a tight budget

- **Status**: Draft — awaiting the owner's approval and a first API test (developer account pending)
- **Date**: 2026-11-17
- **Related**: core spec 183 (electric vehicle contract, which this plugin publishes), core specs 191, 193 and 194 (charge sessions, metered charger, attribution), core spec 111 (plugin isolation), `mchacher/sowel-plugin-renault` (the reference car plugin)
- **Car**: the owner's Tesla, charged on a metered charger. The `ev_charger` "Borne Tesla" is a PJ-1203A clamp on its own supply.

## Context

Sowel already records each charge of the Tesla from the clamp on its charger: start and end times, kWh and cost. What it cannot do without the car's own data:

- show the battery level, the range or the charging state;
- compute the consumption (kWh/100 km) and the cost per 100 km. The core computes both from the battery level and the mileage around each charge (spec 191, P11).

Tesla offers one official access, the **Fleet API**. It is billed per request:

| Kind                                                        | Price                 |
| ----------------------------------------------------------- | --------------------- |
| Data read (`vehicle_data`, and probably the cached variant) | 0.002 $ (500 per 1 $) |
| Wake                                                        | 0.02 $                |
| Command                                                     | 0.001 $               |

Every account gets a 10 $ monthly discount. Every answer under HTTP 500 is billed, a 408 "vehicle asleep" included. An application needs a payment method, otherwise its billing limit is 0 and the application is disabled.

Rate limits per vehicle: 60 data requests per minute, 3 wakes per minute.

The design rule follows: **the plugin reads the car only when a read is useful, and never wakes it on its own.**

## Goals

1. Connect to the Fleet API (EU region) with the owner's application and an OAuth refresh token, and keep the token alive (refresh tokens are single-use and expire after 3 months unused).
2. Publish the car as a device carrying the core contract below. The existing `electric_vehicle` equipment "Tesla" is then bound to it, so the sessions already recorded stay on that car.
3. Read the car around each charge, triggered by the charger's power, and twice a day otherwise. A hard monthly cap keeps the cost far under the discount.
4. Never leak a secret, the VIN or a position.

## Non-goals

- **Commands** (start charge, set the charge limit): they need a virtual key paired in the car and signed commands. This may come in a later spec.
- **Location and `at_home`**: reading the position lights a "location shared" icon in the car, and the cached read never returns it. With a single car, attribution does not need it (spec 191, "only vehicle").
- **Extras** (temperatures, locks, tyres, software version): left out at the owner's request.
- **Fleet Telemetry streaming**: it needs a public server, a virtual key and a TLS setup. That is far more than this need justifies.
- **Several cars or accounts**: the code does not prevent it, but nothing is designed or tested for it.

## Data published (core spec 183 contract)

| Key              | Category            | Source (Fleet API)                                                    |
| ---------------- | ------------------- | --------------------------------------------------------------------- |
| `battery_level`  | `ev_battery_level`  | `charge_state.battery_level` (%)                                      |
| `range`          | `ev_range`          | `charge_state.battery_range`, miles → km                              |
| `plugged`        | `ev_plugged`        | `charge_state.charging_state != "Disconnected"`                       |
| `charging_state` | `ev_charging_state` | mapping below                                                         |
| `charge_limit`   | `ev_charge_limit`   | `charge_state.charge_limit_soc` (%), data only, no order              |
| `charge_power`   | `ev_charge_power`   | `charge_state.charger_power`, kW → W                                  |
| `mileage`        | `ev_mileage`        | `vehicle_state.odometer`, miles → km                                  |
| `reported_at`    | `ev_reported_at`    | `charge_state.timestamp` (the car's report time, never the poll time) |

Order: `refresh` (`ev_refresh`), a read now.

Arbitration A1: should `wake` (`ev_wake`) be offered? It costs 0.02 $ and is never sent on the plugin's own initiative.

`charging_state` mapping:

| Tesla value                               | Contract                         |
| ----------------------------------------- | -------------------------------- |
| `Disconnected`                            | `unplugged`                      |
| `Charging`, `Starting`                    | `charging`                       |
| `Complete`                                | `completed`                      |
| `Stopped` with a scheduled charge pending | `scheduled`                      |
| `Stopped`                                 | `idle`                           |
| `NoPower`                                 | `waiting`                        |
| anything else                             | previous value kept, logged once |

### Measured on the owner's car (2026-11-17, while charging)

- `GET /api/1/vehicles` answers `state: "online"`. The car is a Model 3, `api_version` 95.
- **Live** `vehicle_data?endpoints=charge_state;vehicle_state;gui_settings` returned 200 with every field above:
  - `battery_range` is in miles (197.17), even though the GUI displays km;
  - `odometer` is in miles (30 920.9);
  - `charging_state` was `Charging`;
  - `charger_power` is an **integer** in kW (3). The plugin publishes `charger_actual_current × charger_voltage` instead (13 A × 224 V = 2 912 W), and falls back to `charger_power × 1000` when one of them is missing.
- **Cached** `vehicle_data_cached` returned 200, but:
  - it was **79 minutes old** while the car was online and charging (`Stopped`, 75 % instead of 81 %);
  - it has **no odometer**.

  It is good enough for a sleeping car, whose last report is its real state. It is not good enough for a charge.

## Functional requirements

### Settings and token

- **FR1** Settings, all entered in the plugin's settings form (no script for the user):
  - `client_id`;
  - `client_secret` (password);
  - `domain`: the domain that serves the public key and reaches Sowel, for example `domotique.example.org`;
  - `charger_equipment_id`: the `ev_charger` whose power triggers reads;
  - `monthly_cap`: the number of billed requests allowed per month, default 1500 (3 $).
- **FR1b — Connect button.** The plugin implements the core's OAuth hooks (`getOAuthUrl`, `handleOAuthCallback`, as `sowel-plugin-smartthings` does), so the settings page shows **Connect**.
  - The redirect URI is `https://<domain>/api/v1/plugins/tesla/oauth/callback`, a core route.
  - The plugin exchanges the code and stores the refresh token in its own settings. The user never sees the token.
  - The core callback does not pass `state` back, and its route needs no session. The plugin therefore accepts a code only within 15 min of a Connect click (`getOAuthUrl`), and once.
  - Without a linked account, the status is `not_configured`. The core does not wait for such an integration before starting the recipes.
- **FR1c — Registration.** On start, the plugin checks with a partner token (client credentials) that its domain is registered in the region (`GET partner_accounts/public_key`), and registers it if not. The user does nothing.
- **FR1d — README.** It documents what Sowel cannot do for the user:
  - creating the developer application, and which scopes to tick;
  - adding a payment method and setting a billing limit;
  - generating the key pair;
  - serving the public key at `/.well-known/appspecific/com.tesla.3p.public-key.pem` (with a Caddy and an nginx example);
  - declaring the redirect URI.
- **FR2** The access token (8 h) is refreshed from the refresh token. Each new refresh token is saved in the plugin's settings at once, before it is used: refresh tokens are single-use, and losing one means a new login.
- **FR3** A refused refresh token (`login_required`) sets status `error` and raises the alarm `tesla:auth`, which says "press Connect". A refused client id or secret (partner token) raises `tesla:credentials`, which says "check the settings". Nothing is retried in a loop.
- **FR3b** Refreshes are serialised per application across client instances: a restart must never spend the same single-use token twice.
- **FR4** The secret, the tokens and the VIN (beyond its last 4 characters) are never logged, published or put in an error message.

### Reads, the budget rule

- **FR5** The plugin listens to `equipment.data.changed` on `charger_equipment_id`, alias `power`. It reads the car:
  - **charge start**: 2 min after the power first reaches 500 W. The car is awake then, so the read is a live `vehicle_data`.
  - **during the charge**: every 30 min while the power stays at 500 W or more.
  - **charge end**: 2 min after the power drops under 500 W, if the charge was read at least once. The car is still awake, and this reading gives the battery level and mileage that close the charge for the core.
  - **Guards** (added after review):
    - a dip during the first 2 min defers the start read, it never cancels it;
    - the 30 min gap counts charge reads only. A daily read may be hours old, or taken before a drive;
    - a charger silent for 45 min, or a charge longer than 24 h, ends the charge with an end read and stops the periodic reads.
- **FR6** Outside charges, at 07:00 and at 19:00 local time, the plugin first asks `GET /vehicles/{vin}` for the car's state (counted as billable):
  - `online` → a live `vehicle_data`, which is fresh and carries the odometer;
  - `asleep` or `offline` → a **cached** read (`vehicle_data_cached`, which never wakes the car). It has no odometer, so `mileage` keeps its last value.

  A 404 or 412 on the cached read skips that read without a retry. Live reads (FR5, FR7) are always made after the same state check, so a sleeping car never costs a 408.

- **FR7** The `refresh` order makes one read now, with the same rule as FR6.
- **FR8** Every billed request (status under 500, whatever the endpoint) is counted. The count is persisted in settings and reset on the 1st of the month. At `monthly_cap`, all reads stop until the 1st, and an alarm says so. Expected use: about 10 reads a day, about 300 a month, about 0.60 $.
- **FR9** A `408` (car asleep) is never retried on a timer. A `429` waits for `Retry-After`.

### Device

- **FR10** The car is discovered from `GET /api/1/vehicles` on start and every 24 h. Its source id, which the core also uses as the device's default name, is `Tesla <last 4 of VIN>`. The display name given in the Tesla app is the device's `model`.
- **FR11** The device stays `online` while the API answers. The age of the data shows through `reported_at`.

## Acceptance criteria

- [ ] With valid settings, the device appears with the contract points and the owner binds the equipment "Tesla" to it.
- [ ] A charge on "Borne Tesla" produces a read 2 min after its start, every 30 min, and one 2 min after its end. The core's session shows a battery start and end.
- [ ] After a few charges, the vehicle page shows a consumption (kWh/100 km) and a cost per 100 km.
- [ ] A day without a charge costs at most 2 reads. The car is never woken by the plugin.
- [ ] The monthly counter stops all reads at the cap and raises an alarm.
- [ ] A restart keeps the rotated refresh token. No secret or full VIN appears in the logs.

## Edge cases

| Case                                      | Behaviour                                                     |
| ----------------------------------------- | ------------------------------------------------------------- |
| Charge started by a schedule in the night | same trigger: the power, not the plug                         |
| Charge under 500 W (pause, end of charge) | no read until the end rule fires                              |
| The power flaps around 500 W              | at most one start read and one end read per 30 min            |
| The clamp stops reporting during a charge | the charge ends after 45 min of silence, reads stop           |
| Plugin restarted while connecting         | the older start's timers and reads are dropped                |
| A forged call to the callback route       | refused: no Connect click in the last 15 min                  |
| The car goes to sleep before the end read | 408, billed once, not retried; the next cached read covers it |
| Charger equipment not set                 | only the 2 daily reads and `refresh`                          |
| Tesla changes a field                     | unknown value kept as before, logged once                     |
| Payment method missing (402)              | status `error`, alarm, no retry                               |

## Arbitrations for the owner

- **A1** — offer `wake`? Recommended: no.
- **A2** — reads during a charge every 30 min? Recommended: yes (about 8 reads for a 4 h charge).
- **A3** — two daily reads at 07:00 and 19:00? Recommended: yes.
- **A4** — monthly cap at 1500 requests (3 $)? Recommended: yes.
