# sowel-plugin-tesla

A [Sowel](https://github.com/mchacher/sowel) integration plugin that reads a Tesla through the **official Tesla Fleet API**. It publishes the car as an electric vehicle (core spec 183):

- battery level and range;
- plugged, charging state, charge limit and charging power;
- mileage and the time of the car's last report;
- a **Refresh** order.

With a charger metered by Sowel (core specs 191 and 193), each home charge gets its battery start and end. The vehicle page then shows the car's **consumption (kWh/100 km)** and the **cost per 100 km**.

It is read-only. It never wakes the car, never sends a command and never reads the car's position.

## Cost: why the plugin reads so rarely

Tesla bills every request to the Fleet API, including a "car asleep" answer:

| Request   | Price            |
| --------- | ---------------- |
| Data read | 0.002 $ (500/$1) |
| Wake      | 0.02 $           |

Every developer account gets a **10 $ monthly discount**. The plugin reads the car only when a read is useful:

- **Around each charge**, when the configured charger's power crosses 500 W. One read 2 min after the start, one every 30 min while charging, one 2 min after the end. The car is awake then, so the data is fresh.
- **Twice a day otherwise**, at 07:00 and 19:00. A sleeping car is read from Tesla's cache, which never wakes it.
- **On demand**, with the Refresh button.

Each read first asks whether the car is awake, so it costs two requests. Expect about 600 requests a month, about 1.20 $. A **monthly cap** (1500 by default) stops every request until the 1st and raises an alarm.

## Setup

Tesla requires each user to have their own developer application and a public key on their own domain. The plugin cannot do this for you. You do it once, in about 30 minutes.

### 1. Create the Tesla application

1. Sign in to [developer.tesla.com](https://developer.tesla.com) with your Tesla account (verified e-mail, multi-factor authentication).
2. Request an application:
   - **OAuth grant type:** _Authorization code and machine-to-machine_.
   - **Allowed origin:** `https://<your domain>`, the domain that reaches your Sowel, for example `https://domotique.example.org`.
   - **Allowed redirect URI:** `https://<your domain>/api/v1/plugins/tesla/oauth/callback`.
   - **Scopes:** tick **Vehicle Information** only.
3. Add a payment method and set a billing limit, for example 5 $. Without a payment method, Tesla disables the application; the discount covers normal use.
4. Note the **Client ID** and the **Client Secret**.

### 2. Publish your public key

Generate a key pair on your own computer and keep the private key there. This plugin does not need it; it would only be needed for commands.

```bash
openssl ecparam -name prime256v1 -genkey -noout -out private-key.pem
openssl ec -in private-key.pem -pubout -out public-key.pem
```

Serve `public-key.pem` at `https://<your domain>/.well-known/appspecific/com.tesla.3p.public-key.pem`.

Caddy:

```caddy
domotique.example.org {
	handle /.well-known/appspecific/com.tesla.3p.public-key.pem {
		root * /etc/caddy/tesla        # the file is at /etc/caddy/tesla/.well-known/appspecific/
		file_server
	}
	handle {
		reverse_proxy sowel:3000
	}
}
```

nginx:

```nginx
location = /.well-known/appspecific/com.tesla.3p.public-key.pem {
    alias /etc/nginx/tesla/public-key.pem;
}
```

Check it: `curl https://<your domain>/.well-known/appspecific/com.tesla.3p.public-key.pem`.

### 3. Configure the plugin in Sowel

1. Install the plugin. Then, in **Settings → Integrations → Tesla**, enter:
   - the Client ID and the Client Secret;
   - your domain;
   - optionally, the id of the `ev_charger` equipment whose power should trigger the reads. It is the end of that equipment's page address.
2. Press **Connect**, sign in to Tesla and accept. You come back to Sowel, and the plugin registers your domain with Tesla on its own.
3. The car appears as a device `Tesla <last 4 of the VIN>`. Create an **Electric vehicle** equipment on it, or bind your existing one.

The plugin keeps the account linked by itself. If it ever drops (password change, access revoked), an alarm asks you to press **Connect** again.

## Development

```bash
npm install
npm run validate   # typecheck, lint, format, tests, build, specs index
```

`scripts/tesla-setup.mjs` is a command-line alternative to the Connect button (register, then sign in through `http://localhost:8765/callback`). It was used to explore the API.

Specs: [docs/specs-index.md](docs/specs-index.md).

## License

AGPL-3.0
