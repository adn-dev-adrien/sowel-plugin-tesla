# Spec 001 — Architecture

## Modules

| File             | Role                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/index.ts`   | The `IntegrationPlugin`. Settings, start/stop, discovery, read queue, alarms, OAuth hooks, `refresh` order. |
| `src/config.ts`  | Settings schema (also in `manifest.json`), the internal keys, `readConfig`.                                 |
| `src/fleet.ts`   | Fleet API client: refresh-token rotation, partner registration, the four vehicle calls, error kinds.        |
| `src/budget.ts`  | Monthly counter of billed requests, persisted in settings, and the cap.                                     |
| `src/trigger.ts` | `ChargeTrigger`, which turns the charger's power into read reasons, and `nextDaily`.                        |
| `src/mapping.ts` | Pure mapping from a `vehicle_data` answer to the contract payload.                                          |

## Data flow

```
equipment.data.changed (charger, power) ──► ChargeTrigger ──► readAll(reason)
timer 07:00 / 19:00 ───────────────────────────────────────► readAll("daily")
refresh order / refresh() ─────────────────────────────────► readCar(...)
                                                                │
                      GET /vehicles/{vin} ── online ──► vehicle_data (live)
                                          └─ asleep ──► vehicle_data_cached
                                                                │
                                         mapVehicleData ──► deviceManager.updateDeviceData
```

Reads go through one promise queue, so two reasons never read at the same time.

## Settings keys (`integration.tesla.*`)

| Key                    | Origin | Content                                    |
| ---------------------- | ------ | ------------------------------------------ |
| `client_id`            | user   | Tesla application Client ID                |
| `client_secret`        | user   | Client Secret (password field)             |
| `domain`               | user   | normalised: scheme and path stripped       |
| `charger_equipment_id` | user   | optional                                   |
| `monthly_cap`          | user   | default 1500                               |
| `region`               | user   | `eu` (default) or `na`                     |
| `refresh_token`        | plugin | rotated at each refresh, saved before use  |
| `usage`                | plugin | `{"month":"2026-11","count":42}`           |
| `registered`           | plugin | `eu:domain`, once the domain is registered |

## Errors

| Fleet answer               | Kind             | Plugin reaction                                       |
| -------------------------- | ---------------- | ----------------------------------------------------- |
| token 400/401              | `auth`           | status `error`, alarm `tesla:auth`, no retry          |
| 402                        | `payment`        | status `error`, alarm `tesla:payment`                 |
| our cap                    | `cap`            | alarm `tesla:cap`, no request until the 1st           |
| 408                        | `asleep`         | log, no retry                                         |
| 429                        | `rate`           | log with `Retry-After`                                |
| 404/412 on the cached read | `unavailable`    | read skipped                                          |
| ≥ 500, network             | `http`/`network` | status `disconnected`; discovery retried after 15 min |

Alarms resolve on the next successful request.
