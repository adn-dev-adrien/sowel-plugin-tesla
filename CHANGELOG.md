# Changelog

## 0.1.1 — 2026-11-17

- Clearer setting labels: the domain of your Sowel, the charger's 36-character id.
- A charger field that is not an equipment id (for example a domain typed in the wrong field) raises a warning instead of being ignored silently. Reads then fall back to 07:00 and 19:00.

## 0.1.0 — 2026-11-17

First version (spec 001): a Tesla through the official Fleet API, read-only. Reads around the charges seen on a Sowel charger, twice a day otherwise, a monthly cap, and a Connect button.
