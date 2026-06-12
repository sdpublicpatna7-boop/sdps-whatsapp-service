# SDPS WhatsApp Service (Baileys)

A small Node microservice that owns the WhatsApp connection and is called by the
FastAPI backend. It powers:

- Transactional confirmations (enquiry / alumni / career "we'll contact you").
- Bulk marketing campaigns with a pacing delay and live progress.

## Run locally

```bash
cd whatsapp-service
npm install
WA_API_SECRET="<same secret as the backend>" \
WA_BULK_DELAY_MS=2000 \
node index.js
```

The service listens on `:3001`. The FastAPI backend must point at it via
`WA_SERVICE_URL` and share the same `WA_API_SECRET`.

## Linking a WhatsApp account

1. Start the service.
2. Open the admin panel → **WhatsApp Marketing**. A QR code appears.
3. On the phone: WhatsApp → Linked Devices → Link a Device → scan the QR.
4. Status flips to **Connected**. The session is saved in `WA_AUTH_DIR`
   (default `./auth_state`) so it survives restarts.

> Use a dedicated WhatsApp number you control. Bulk messaging from an unofficial
> (Baileys) client can get a number banned — the 2s delay and the test-first flow
> reduce, but do not eliminate, that risk.

## Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `3001` | HTTP port |
| `WA_API_SECRET` | — (required) | Shared secret with the backend |
| `WA_AUTH_DIR` | `./auth_state` | Where the linked session is stored (persist this) |
| `WA_BULK_DELAY_MS` | `2000` | Delay between bulk messages |
| `LOG_LEVEL` | `warn` | pino log level |

## HTTP API (all require header `X-WA-Secret`)

- `GET /status` → `{ connected, qr, user, bulkProgress }`
- `POST /disconnect`
- `POST /send-text` → `{ phone, message, mediaBase64?, mediaMime?, mediaType? }`
- `POST /send-bulk` → `{ contacts:[{phone,name}], message, mediaBase64?, mediaMime?, mediaType?, delayMs }`
- `POST /stop-bulk`

## Deployment note

Keep this service **private** (internal network / not publicly exposed). If it
must be reachable over the internet, ensure only the backend can reach it and that
`WA_AUTH_DIR` is on a persistent volume.
