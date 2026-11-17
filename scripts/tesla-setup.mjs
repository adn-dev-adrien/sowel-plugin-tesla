#!/usr/bin/env node
// One-time setup for sowel-plugin-tesla (Tesla Fleet API). No dependency: Node 20+.
//
// Reads the application credentials from an env file (default
// ~/.config/sowel-tesla/app.env) with:
//   TESLA_CLIENT_ID=...
//   TESLA_CLIENT_SECRET=...
//   TESLA_DOMAIN=domotique.example.org   # where the public key is served
//   TESLA_REGION=eu                      # eu | na
//
//   node scripts/tesla-setup.mjs check     # is the public key reachable?
//   node scripts/tesla-setup.mjs register  # partner token + register the domain (once per region)
//   node scripts/tesla-setup.mjs login     # sign in to your Tesla account, prints the refresh token
//
// Secrets are never printed, except the refresh token at the very end of
// `login`, which you paste into the plugin's settings. It is also written to
// <env dir>/refresh_token (mode 600).

import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";

const ENV_FILE = process.env.TESLA_ENV_FILE ?? join(homedir(), ".config/sowel-tesla/app.env");
const AUTH_URL = "https://auth.tesla.com/oauth2/v3/authorize";
const TOKEN_URL = "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token";
const API = {
  eu: "https://fleet-api.prd.eu.vn.cloud.tesla.com",
  na: "https://fleet-api.prd.na.vn.cloud.tesla.com",
};
const SCOPES = "openid offline_access vehicle_device_data";
const PORT = 8765;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

function loadEnv() {
  const env = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  for (const k of ["TESLA_CLIENT_ID", "TESLA_CLIENT_SECRET", "TESLA_DOMAIN"]) {
    if (!env[k]) throw new Error(`${k} missing in ${ENV_FILE}`);
  }
  env.TESLA_REGION = env.TESLA_REGION || "eu";
  if (!API[env.TESLA_REGION]) throw new Error(`TESLA_REGION must be eu or na`);
  return env;
}

async function form(url, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${res.status} ${body.error ?? ""} ${body.error_description ?? ""}`.trim());
  }
  return body;
}

async function check(env) {
  const url = `https://${env.TESLA_DOMAIN}/.well-known/appspecific/com.tesla.3p.public-key.pem`;
  const res = await fetch(url);
  const text = await res.text();
  const ok = res.ok && text.includes("BEGIN PUBLIC KEY");
  console.log(`${ok ? "OK " : "KO "} ${res.status} ${url}`);
  if (!ok) process.exitCode = 1;
}

async function register(env) {
  await check(env);
  const base = API[env.TESLA_REGION];
  const partner = await form(TOKEN_URL, {
    grant_type: "client_credentials",
    client_id: env.TESLA_CLIENT_ID,
    client_secret: env.TESLA_CLIENT_SECRET,
    scope: SCOPES,
    audience: base,
  });
  const headers = {
    authorization: `Bearer ${partner.access_token}`,
    "content-type": "application/json",
  };
  const reg = await fetch(`${base}/api/1/partner_accounts`, {
    method: "POST",
    headers,
    body: JSON.stringify({ domain: env.TESLA_DOMAIN }),
  });
  console.log(`register: ${reg.status} ${(await reg.text()).slice(0, 300)}`);
  const pk = await fetch(
    `${base}/api/1/partner_accounts/public_key?domain=${encodeURIComponent(env.TESLA_DOMAIN)}`,
    { headers },
  );
  console.log(`public key on Tesla's side: ${pk.status} ${(await pk.text()).slice(0, 200)}`);
}

async function login(env) {
  const state = randomBytes(16).toString("hex");
  const url =
    `${AUTH_URL}?` +
    new URLSearchParams({
      response_type: "code",
      client_id: env.TESLA_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      state,
      locale: "fr-FR",
      prompt_missing_scopes: "true",
    });

  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url, REDIRECT_URI);
      if (u.pathname !== "/callback") return res.writeHead(404).end();
      const done = (msg) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<p style="font:16px system-ui;margin:40px">${msg}</p>`);
        server.close();
      };
      if (u.searchParams.get("state") !== state) {
        done("État invalide, recommencez.");
        return reject(new Error("state mismatch"));
      }
      if (u.searchParams.get("error")) {
        done("Connexion refusée.");
        return reject(new Error(u.searchParams.get("error")));
      }
      done("Connexion réussie. Vous pouvez fermer cet onglet et revenir au terminal.");
      resolve(u.searchParams.get("code"));
    });
    server.listen(PORT, "127.0.0.1", () => {
      console.log(`Ouverture du navigateur pour la connexion Tesla…\n${url}\n`);
      execFile(process.platform === "darwin" ? "open" : "xdg-open", [url], () => {});
    });
  });

  const tokens = await form(TOKEN_URL, {
    grant_type: "authorization_code",
    client_id: env.TESLA_CLIENT_ID,
    client_secret: env.TESLA_CLIENT_SECRET,
    code,
    audience: API[env.TESLA_REGION],
    redirect_uri: REDIRECT_URI,
  });
  const file = join(dirname(ENV_FILE), "refresh_token");
  writeFileSync(file, tokens.refresh_token + "\n", { mode: 0o600 });
  console.log(`Scopes accordés : ${tokens.scope ?? "?"}`);
  console.log(`Jeton de rafraîchissement enregistré dans ${file}`);
}

const cmd = process.argv[2];
const env = loadEnv();
const run = { check, register, login }[cmd];
if (!run) {
  console.error("usage: tesla-setup.mjs check | register | login");
  process.exit(2);
}
run(env).catch((err) => {
  console.error(`Échec : ${err.message}`);
  process.exit(1);
});
