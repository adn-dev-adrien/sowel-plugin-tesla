# Spec 001 — Plan

## Steps

- [x] 1. Test the API with the owner's account (`scripts/tesla-setup.mjs`, probe): field names and units, cached read freshness.
- [x] 2. `mapping.ts` and its tests, with the measured answer as fixture.
- [x] 3. `budget.ts`, `fleet.ts` and their tests.
- [x] 4. `trigger.ts` and its tests (fake clock).
- [x] 5. `index.ts`: settings, discovery, reads, alarms, OAuth hooks; plugin tests.
- [x] 6. README (setup for any user), manifest.
- [ ] 7. Release v0.1.0, install as a personal source on the owner's instance, bind the equipment "Tesla", follow a real charge.

## Test plan

| Module  | Scenario                                                          | Expected                                        |
| ------- | ----------------------------------------------------------------- | ----------------------------------------------- |
| mapping | measured live read                                                | contract payload, miles → km, power = A × V     |
| mapping | measured cached read                                              | no mileage                                      |
| mapping | unknown `charging_state`                                          | reported, left out                              |
| mapping | every known `charging_state`                                      | the contract value                              |
| budget  | count, persist, cap; new month; corrupt store                     | as FR8                                          |
| fleet   | refresh token rotation, saved before use; one refresh in parallel | one token call, new token stored                |
| fleet   | refused refresh                                                   | `auth`, no token in the message                 |
| fleet   | code exchange                                                     | core callback URL, EU audience                  |
| fleet   | billing: < 500 counted, ≥ 500 not; cap without a call             | as FR8                                          |
| fleet   | 402/408/412/429/500, 404/412 on cached                            | the error kinds                                 |
| fleet   | 401 from the API                                                  | one refresh and one retry                       |
| fleet   | partner registration known / unknown                              | no POST / POST with the domain, never billed    |
| trigger | start, every 30 min, end                                          | the three reasons at the right times            |
| trigger | spike under 2 min                                                 | no read                                         |
| trigger | pause under 2 min                                                 | same charge                                     |
| trigger | recent read before the start                                      | start skipped, end read                         |
| trigger | non-numeric value, reversed clamp                                 | ignored / counted                               |
| trigger | `nextDaily`                                                       | 07:00, 19:00, next day                          |
| plugin  | not configured / not connected                                    | no request                                      |
| plugin  | online car                                                        | list + state + live; connected; token persisted |
| plugin  | sleeping car                                                      | cached, never live                              |
| plugin  | charge on the configured charger; another equipment               | reads / none                                    |
| plugin  | expired link, 402, cap reached                                    | alarm, no loop / no request                     |
| plugin  | Connect URL and callback                                          | normalised domain; token stored; starts         |
| plugin  | refresh order                                                     | one read                                        |
