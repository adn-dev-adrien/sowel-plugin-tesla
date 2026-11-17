/**
 * Settings (spec 001 FR1). Everything the user enters is in the form; the
 * refresh token, the monthly usage and the registration marker are internal
 * keys under the same prefix, never shown.
 */

import type { IntegrationSettingDef, SettingsManager } from "./sowel-api.js";
import type { Credentials, Region } from "./fleet.js";

export const SETTINGS_PREFIX = "integration.tesla.";
export const REFRESH_TOKEN_KEY = SETTINGS_PREFIX + "refresh_token";
export const USAGE_KEY = SETTINGS_PREFIX + "usage";
export const REGISTERED_KEY = SETTINGS_PREFIX + "registered";
export const DEFAULT_CAP = 1500;

export const SETTINGS_SCHEMA: IntegrationSettingDef[] = [
  { key: "client_id", label: "Identifiant client Tesla (Client ID)", type: "text", required: true },
  {
    key: "client_secret",
    label: "Clé secrète Tesla (Client Secret)",
    type: "password",
    required: true,
  },
  {
    key: "domain",
    label: "Domaine qui sert la clé publique et Sowel",
    type: "text",
    required: true,
    placeholder: "domotique.exemple.fr",
  },
  {
    key: "charger_equipment_id",
    label: "Borne qui déclenche les lectures (identifiant de l'équipement)",
    type: "text",
    required: false,
    placeholder: "fin de l'adresse de la page de la borne",
  },
  {
    key: "monthly_cap",
    label: "Plafond de requêtes facturées par mois",
    type: "number",
    required: false,
    defaultValue: String(DEFAULT_CAP),
  },
  {
    key: "region",
    label: "Région Tesla (eu ou na)",
    type: "text",
    required: false,
    defaultValue: "eu",
    placeholder: "eu",
  },
];

export interface PluginConfig {
  creds: Credentials;
  chargerEquipmentId: string | null;
  monthlyCap: number;
}

function read(settings: SettingsManager, key: string): string {
  return (settings.get(SETTINGS_PREFIX + key) ?? "").trim();
}

/** `https://x.fr/` or `x.fr/path` → `x.fr`: users paste URLs. */
export function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/[/?#].*$/, "")
    .toLowerCase();
}

export function isConfigured(settings: SettingsManager): boolean {
  return readConfig(settings) !== null;
}

export function readConfig(settings: SettingsManager): PluginConfig | null {
  const clientId = read(settings, "client_id");
  // A secret may legitimately carry spaces at its ends? Tesla's do not; trim.
  const clientSecret = read(settings, "client_secret");
  const domain = normalizeDomain(read(settings, "domain"));
  if (!clientId || !clientSecret || !domain) return null;
  const region: Region = read(settings, "region").toLowerCase() === "na" ? "na" : "eu";
  const cap = Number(read(settings, "monthly_cap"));
  return {
    creds: { clientId, clientSecret, domain, region },
    chargerEquipmentId: read(settings, "charger_equipment_id") || null,
    monthlyCap: Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DEFAULT_CAP,
  };
}
