require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "app.json");
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = {
      pinterest: { accessToken: null, refreshToken: null, expiresAt: 0, user: null },
      boards: [],
      queue: [],
      history: []
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}
function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
let db = loadDb();
const oauthStates = new Map();

const PINTEREST_API = "https://api.pinterest.com/v5";

function authHeader() {
  if (!db.pinterest.accessToken) throw new Error("Pinterest is not connected.");
  return { Authorization: `Bearer ${db.pinterest.accessToken}` };
}

async function pinterestRequest(config) {
  try {
    return await axios({ ...config, baseURL: PINTEREST_API, headers: { ...authHeader(), ...(config.headers || {}) } });
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    if (status === 401 && db.pinterest.refreshToken) {
      await refreshPinterestToken();
      return await axios({ ...config, baseURL: PINTEREST_API, headers: { ...authHeader(), ...(config.headers || {}) } });
    }
    const e = new Error(data?.message || data?.error || `Pinterest API error ${status || ""}`.trim());
    e.status = status;
    throw e;
  }
}

async function refreshPinterestToken() {
  if (!db.pinterest.refreshToken) throw new Error("No Pinterest refresh token available.");
  const client = Buffer.from(`${process.env.PINTEREST_CLIENT_ID}:${process.env.PINTEREST_CLIENT_SECRET}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: db.pinterest.refreshToken,
    continuous_refresh: "true"
  });
  const response = await axios.post("https://api.pinterest.com/v5/oauth/token", body.toString(), {
    headers: {
      Authorization: `Basic ${client}`,
      "Content-Type": "application/x-www-form-urlencoded"
    }
  });
  db.pinterest.accessToken = response.data.access_token;
  if (response.data.refresh_token) db.pinterest.refreshToken = response.data.refresh_token;
  db.pinterest.expiresAt = Date.now() + Number(response.data.expires_in || 0) * 1000;
  saveDb(db);
}

app.get("/api/status", (req, res) => {
  res.json({
    pinterestConnected: Boolean(db.pinterest.accessToken),
    pinterestUser: db.pinterest.user,
    queueCount: db.queue.filter(x => x.status === "scheduled").length,
    history: db.history.slice(-20).reverse()
  });
});

app.get("/auth/pinterest", (req, res) => {
  if (!process.env.PINTEREST_CLIENT_ID || !process.env.PINTEREST_CLIENT_SECRET) {
    return res.status(500).send("Configure PINTEREST_CLIENT_ID and PINTEREST_CLIENT_SECRET first.");
  }
  const state = crypto.randomBytes(24).toString("hex");
  oauthStates.set(state, Date.now());
  const scope = process.env.PINTEREST_SCOPES || "boards:read,boards:write,pins:read,pins:write,user_accounts:read";
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.PINTEREST_CLIENT_ID,
    redirect_uri: process.env.PINTEREST_REDIRECT_URI || `${APP_URL}/auth/pinterest/callback`,
    scope,
    state
  });
  res.redirect(`https://www.pinterest.com/oauth/?${params.toString()}`);
});

app.get("/auth/pinterest/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state || !oauthStates.has(state)) return res.status(400).send("Invalid OAuth state.");
    oauthStates.delete(state);

    const client = Buffer.from(`${process.env.PINTEREST_CLIENT_ID}:${process.env.PINTEREST_CLIENT_SECRET}`).toString("base64");
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: process.env.PINTEREST_REDIRECT_URI || `${APP_URL}/auth/pinterest/callback`,
      continuous_refresh: "true"
    });
    const tokenResponse = await axios.post("https://api.pinterest.com/v5/oauth/token", body.toString(), {
      headers: {
        Authorization: `Basic ${client}`,
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });

    db.pinterest.accessToken = tokenResponse.data.access_token;
    db.pinterest.refreshToken = tokenResponse.data.refresh_token || null;
    db.pinterest.expiresAt = Date.now() + Number(tokenResponse.data.expires_in || 0) * 1000;

    const me = await axios.get(`${PINTEREST_API}/user_account`, {
      headers: { Authorization: `Bearer ${db.pinterest.accessToken}` }
    });
    db.pinterest.user = me.data;
    saveDb(db);

    res.redirect("/?pinterest=connected");
  } catch (err) {
    console.error(err.response?.data || err);
    res.status(500).send("Pinterest connection failed. Check the server console.");
  }
});

app.post("/auth/pinterest/disconnect", (req, res) => {
  db.pinterest = { accessToken: null, refreshToken: null, expiresAt: 0, user: null };
  db.boards = [];
  saveDb(db);
  res.json({ ok: true });
});

app.get("/api/boards", async (req, res) => {
  try {
    const response = await pinterestRequest({ method: "GET", url: "/boards", params: { page_size: 100 } });
    db.boards = response.data.items || [];
    saveDb(db);
    res.json(db.boards);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/queue", (req, res) => {
  res.json(db.queue.slice().sort((a,b) => new Date(a.scheduledAt) - new Date(b.scheduledAt)));
});

app.post("/api/queue", (req, res) => {
  const { imageData, title, description, altText, link, boardId, scheduledAt, aiDisclosure = false } = req.body;
  if (!imageData || !title || !boardId || !scheduledAt) {
    return res.status(400).json({ error: "imageData, title, boardId and scheduledAt are required." });
  }
  const item = {
    id: crypto.randomUUID(),
    imageData,
    title: String(title).slice(0, 100),
    description: String(description || "").slice(0, 800),
    altText: String(altText || "").slice(0, 500),
    link: String(link || "").slice(0, 2048),
    boardId,
    scheduledAt,
    aiDisclosure: Boolean(aiDisclosure),
    status: "scheduled",
    createdAt: new Date().toISOString()
  };
  db.queue.push(item);
  saveDb(db);
  res.json(item);
});

app.delete("/api/queue/:id", (req, res) => {
  const item = db.queue.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Queue item not found." });
  item.status = "cancelled";
  saveDb(db);
  res.json({ ok: true });
});

async function publishPin(item) {
  const match = String(item.imageData).match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/);
  if (!match) throw new Error("Pinterest image upload requires a PNG/JPEG/WEBP data URL.");

  const contentType = match[1] === "image/jpg" ? "image/jpeg" : match[1];
  const data = match[2];

  const payload = {
    board_id: item.boardId,
    title: item.title,
    description: item.description,
    alt_text: item.altText,
    link: item.link || undefined,
    media_source: {
      source_type: "image_base64",
      content_type: contentType,
      data,
      is_standard: true
    }
  };
  if (item.aiDisclosure) payload.ai_disclosures = { values: ["AI_MODIFIED"] };

  const response = await pinterestRequest({
    method: "POST",
    url: "/pins",
    data: payload,
    headers: { "Content-Type": "application/json" }
  });
  return response.data;
}

async function processDueQueue() {
  if (!db.pinterest.accessToken) return;
  const now = Date.now();
  const due = db.queue.filter(x => x.status === "scheduled" && new Date(x.scheduledAt).getTime() <= now);
  for (const item of due) {
    try {
      item.status = "publishing";
      saveDb(db);
      const pin = await publishPin(item);
      item.status = "published";
      item.publishedAt = new Date().toISOString();
      item.pinId = pin.id;
      db.history.push({ ...item, imageData: undefined });
      saveDb(db);
    } catch (err) {
      item.status = "failed";
      item.error = err.message;
      item.failedAt = new Date().toISOString();
      db.history.push({ ...item, imageData: undefined });
      saveDb(db);
    }
  }
}

// Check every minute. For production, move scheduling to a durable job system.
cron.schedule("* * * * *", processDueQueue);

app.post("/api/publish-now", async (req, res) => {
  try {
    const item = { ...req.body, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    const pin = await publishPin(item);
    db.history.push({ ...item, imageData: undefined, status: "published", publishedAt: new Date().toISOString(), pinId: pin.id });
    saveDb(db);
    res.json(pin);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/*splat", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Journal Pinterest Generator running at ${APP_URL}`);
});
