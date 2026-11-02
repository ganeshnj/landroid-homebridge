# landroid-homebridge

Homebridge plugin for Worx Landroid robotic mowers (also Kress, Landxcape and Ferrex), controlled through the manufacturer's cloud.

> **Status: experimental.** Written against the community-documented Worx cloud API and not yet verified on real hardware.

## Features

- Finds all mowers on your account automatically.
- **Switch**: on = start mowing, off = send the mower home.
- **Battery** service: level, charging state, low-battery warning.
- Live status over MQTT (no polling).

## Requirements

- Homebridge 1.6+ and Node.js 18+
- A Worx account that has the mower paired or shared with it

The mower has no local API; it talks only to the Worx cloud, so an account login is required. Use a **dedicated account** instead of your main one: create a second account in the Worx app and share the mower with it.

## Install

From the Homebridge UI Terminal (or a shell on the Homebridge host):

```
npm install github:ganeshnj/landroid-homebridge
```

Restart Homebridge, then configure the plugin in the UI.

## Configuration

```json
{
  "platform": "WorxLandroid",
  "email": "you@example.com",
  "password": "your-password",
  "server": "worx"
}
```

| Option     | Description                                                          |
| ---------- | -------------------------------------------------------------------- |
| `email`    | Worx account email (required)                                        |
| `password` | Worx account password (required)                                     |
| `server`   | `worx` (default), `kress`, `landxcape` or `ferrex`                   |

## How it works

1. OAuth password login against the brand's ID server, with automatic token refresh.
2. Mowers are listed from the REST API (`/api/v2/product-items`).
3. A WebSocket MQTT connection to AWS IoT (custom authorizer) subscribes to each mower's status topic and publishes commands (`{"cmd":1}` start, `{"cmd":3}` home).

## Development

```
npm install
npm test
```

CI runs the same check on Node 18, 20 and 22.

## Credits

The cloud protocol comes from the community work in [ioBroker.worx](https://github.com/iobroker-community-adapters/ioBroker.worx) and the earlier [homebridge-landroid](https://www.npmjs.com/package/homebridge-landroid).

Not affiliated with or endorsed by Positec / Worx.
