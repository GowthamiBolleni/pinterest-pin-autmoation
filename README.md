# PinMuse — Puter.js Journal Pinterest Generator

A starter app that turns a journal cover + interior screenshots into aesthetic Pinterest Pins, generates Pinterest SEO metadata with Puter AI, and schedules/publishes Pins through Pinterest API v5.

## What it does

- Upload journal cover.
- Upload up to 6 interior page screenshots.
- Use Puter.js multimodal AI to analyze the product.
- Generate multiple Pinterest creative variations.
- Generate title, description, alt text and creative hook.
- Generate 2:3 aesthetic mockups using the supplied cover/interior images as references.
- Download Pins.
- Connect Pinterest with OAuth 2.0.
- Read Pinterest boards.
- Publish Pins immediately.
- Schedule Pins for automatic publishing.
- Keep a local publishing history.
- Includes an AI Pinterest strategist chat.

## Important architecture note

Puter.js runs the AI side in the browser. Pinterest OAuth and publishing run on the Node server so the Pinterest app secret is never shipped to the browser.

The current implementation stores the Pinterest token and queue in `data/app.json` for simplicity. For a production SaaS, replace this with encrypted database storage and a durable job queue.

## Setup

1. Install Node.js 18+.
2. Copy `.env.example` to `.env`.
3. Create/configure a Pinterest developer app.
4. Set the exact redirect URI in Pinterest:
   `http://localhost:3000/auth/pinterest/callback`
5. Fill in `PINTEREST_CLIENT_ID` and `PINTEREST_CLIENT_SECRET`.
6. Run:

```bash
npm install
npm start
```

7. Open `http://localhost:3000`.

## Pinterest permissions

The app requests:

- boards:read
- boards:write
- pins:read
- pins:write
- user_accounts:read

Pinterest's Create Pin endpoint currently supports Base64 image media, which is why the browser-generated image can be sent to the server without requiring a public image-hosting URL.

## Automatic posting

The server checks the queue once per minute. When a scheduled time is reached, it creates the Pin using Pinterest API v5.

For production hosting, use a persistent service that stays running. If the process sleeps, scheduled publishing cannot run at that moment.

## AI disclosure

The generated image is AI-modified, so the sample publisher sends the Pinterest `ai_disclosures` value `AI_MODIFIED`. Review Pinterest's current policy and your final creative before production use.

## Security

Never commit `.env` or Pinterest secrets. The Pinterest documentation explicitly recommends keeping app secrets and tokens out of source code.

## Puter

Puter.js is loaded from:

https://js.puter.com/v2/

The UI includes the required Puter developer footer link.

For local development, serve the app over HTTP rather than opening `index.html` with `file://`.


## 30-day autopilot calendar

Choose Pins/day (3, 5, 7, 10, or 15), number of days (7, 30, 60, or 90), first posting time, and the gap between Pins. With Auto-schedule enabled, generated Pins are added to the Pinterest publishing queue automatically.

Example: 5 Pins/day × 30 days = 150 calendar slots. The app asks for confirmation before attempting more than 30 AI-generated images because image generation can take substantial time and consume AI usage.
