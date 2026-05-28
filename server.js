const http = require("http");
const https = require("https");
const url = require("url");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");

const STEAM_API_KEY = process.env.STEAM_API_KEY || "332A0BDAEA7F4786C0BF5F5A8A0A7C3B";
const PORT = process.env.PORT || 3000;
const MONGO_URL = process.env.MONGO_URL || "mongodb://admin:password@localhost:27017/";
const DB_NAME = "steamtracker";
const SESSION_SECRET = process.env.SESSION_SECRET || "steamtracker-secret-2024";

let db;

// ── Simple in-memory session store ─────────────────────────────────────────
const sessions = new Map(); // token -> { accountId, username, createdAt }

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashPassword(password) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(password).digest("hex");
}

function getSession(req) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/session=([a-f0-9]+)/);
  if (!match) return null;
  const session = sessions.get(match[1]);
  if (!session) return null;
  // Sessions expire after 30 days
  if (Date.now() - session.createdAt > 30 * 24 * 60 * 60 * 1000) {
    sessions.delete(match[1]);
    return null;
  }
  return session;
}

function setCookieHeader(token) {
  return `session=${token}; Path=/; HttpOnly; Max-Age=${30 * 24 * 60 * 60}; SameSite=Lax`;
}

function clearCookieHeader() {
  return `session=; Path=/; HttpOnly; Max-Age=0`;
}

async function connectMongo() {
  const client = new MongoClient(MONGO_URL, { tls: true, tlsAllowInvalidCertificates: false, serverSelectionTimeoutMS: 5000 });
  await client.connect();
  db = client.db(DB_NAME);
  console.log("✅ Connected to MongoDB");
  await ensureRootAccount();
}

async function ensureRootAccount() {
  // Create root account if it doesn't exist
  const existing = await db.collection("accounts").findOne({ username: "root" });
  if (!existing) {
    const rootId = new (require("mongodb").ObjectId)();
    await db.collection("accounts").insertOne({
      _id: rootId,
      username: "root",
      password: hashPassword("password"),
      createdAt: new Date()
    });
    console.log("✅ Root account created");
    // Migrate all existing users (no accountId) to root
    await db.collection("users").updateMany(
      { accountId: { $exists: false } },
      { $set: { accountId: rootId.toString() } }
    );
    console.log("✅ Existing users migrated to root account");
  }
}

function fetchJSON(apiUrl) {
  return new Promise((resolve, reject) => {
    https.get(apiUrl, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("Failed to parse JSON: " + data.slice(0, 200))); }
      });
    }).on("error", reject);
  });
}

async function getOwnedGames(steamId) {
  const data = await fetchJSON(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_API_KEY}&steamid=${steamId}&include_appinfo=true&include_played_free_games=true`);
  return data.response?.games || [];
}

async function getAchievements(appId, steamId) {
  try {
    const data = await fetchJSON(`https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=${STEAM_API_KEY}&steamid=${steamId}&appid=${appId}`);
    if (data.playerstats?.success === false) return null;
    return data.playerstats?.achievements || null;
  } catch { return null; }
}

async function getAchievementSchema(appId) {
  try {
    const data = await fetchJSON(`https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${STEAM_API_KEY}&appid=${appId}`);
    const achievements = data.game?.availableGameStats?.achievements || [];
    const map = {};
    for (const a of achievements) map[a.name] = { displayName: a.displayName, description: a.description || "", icon: a.icon, icongray: a.icongray };
    return map;
  } catch { return {}; }
}

const DISPLAY_CATEGORIES = new Set(["Single-player","Multi-player","Co-op","Online Co-op","Local Co-op","Online PvP","Local PvP","Cross-Platform Multiplayer","Steam Achievements","Steam Trading Cards","Steam Cloud","Family Sharing","Full controller support","Partial Controller Support"]);
const MULTIPLAYER_CATEGORIES = new Set(["Multi-player","Co-op","Online Co-op","Local Co-op","Online PvP","Local PvP","Cross-Platform Multiplayer"]);

async function getFullGameMeta(appId) {
  const [storeData, spyData] = await Promise.all([
    fetchJSON(`https://store.steampowered.com/api/appdetails?appids=${appId}&filters=genres,categories`).catch(() => null),
    fetchJSON(`https://steamspy.com/api.php?request=appdetails&appid=${appId}`).catch(() => null)
  ]);
  const appData = storeData?.[appId];
  const genres = appData?.success ? (appData.data?.genres || []).map(g => g.description) : [];
  const rawCategories = appData?.success ? (appData.data?.categories || []) : [];
  const categories = rawCategories.map(c => c.description).filter(c => DISPLAY_CATEGORIES.has(c));
  const rawTags = spyData?.tags || {};
  const tags = Object.entries(rawTags).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name]) => name);
  return { genres, tags, categories };
}

async function getGameTagsRaw(appId) {
  try { const data = await fetchJSON(`https://steamspy.com/api.php?request=appdetails&appid=${appId}`); return data.tags || {}; }
  catch { return {}; }
}

async function getGameTagsAndCategories(appId) {
  const [spyData, storeData] = await Promise.all([
    fetchJSON(`https://steamspy.com/api.php?request=appdetails&appid=${appId}`).catch(() => null),
    fetchJSON(`https://store.steampowered.com/api/appdetails?appids=${appId}&filters=categories`).catch(() => null)
  ]);
  const tags = spyData?.tags || {};
  const appData = storeData?.[appId];
  const rawCats = appData?.success ? (appData.data?.categories || []).map(c => c.description) : [];
  return { tags, categories: rawCats };
}

async function getPlayerAchievementStats(appId, steamId) {
  try {
    const achievements = await getAchievements(appId, steamId);
    if (!achievements) return { supported: false, unlocked: 0, total: 0, pct: 0 };
    const total = achievements.length;
    const unlocked = achievements.filter(a => a.achieved === 1).length;
    return { supported: true, unlocked, total, pct: total ? Math.round(unlocked / total * 100) : 0 };
  } catch { return { supported: false, unlocked: 0, total: 0, pct: 0 }; }
}

function isPurelySignlePlayer(categories) {
  return categories.includes("Single-player") && !categories.some(c => MULTIPLAYER_CATEGORIES.has(c));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on("error", reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function json(res, status, data, extraHeaders = {}) {
  const headers = { "Content-Type": "application/json", ...extraHeaders };
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const steamId = parsed.query.steamid;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // ── Serve frontend ──────────────────────────────────────────────────────
  if (pathname === "/" || pathname === "/index.html") {
    const filePath = path.join(__dirname, "index.html");
    fs.readFile(filePath, (err, content) => {
      if (err) { res.writeHead(500); res.end("Could not load index.html"); return; }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(content);
    });
    return;
  }

  // ── AUTH ENDPOINTS ──────────────────────────────────────────────────────

  // POST /api/auth/register
  if (pathname === "/api/auth/register" && req.method === "POST") {
    try {
      const { username, password } = await readBody(req);
      if (!username || !password || username.length < 2 || password.length < 4) {
        return json(res, 400, { error: "Username must be 2+ chars, password 4+ chars" });
      }
      const existing = await db.collection("accounts").findOne({ username: username.toLowerCase() });
      if (existing) return json(res, 409, { error: "Username already taken" });
      const result = await db.collection("accounts").insertOne({
        username: username.toLowerCase(),
        displayUsername: username,
        password: hashPassword(password),
        createdAt: new Date()
      });
      const token = generateToken();
      sessions.set(token, { accountId: result.insertedId.toString(), username: username.toLowerCase(), displayUsername: username, createdAt: Date.now() });
      json(res, 200, { ok: true, username: username.toLowerCase(), displayUsername: username }, { "Set-Cookie": setCookieHeader(token) });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  // POST /api/auth/login
  if (pathname === "/api/auth/login" && req.method === "POST") {
    try {
      const { username, password } = await readBody(req);
      const account = await db.collection("accounts").findOne({ username: username.toLowerCase() });
      if (!account || account.password !== hashPassword(password)) {
        return json(res, 401, { error: "Invalid username or password" });
      }
      const token = generateToken();
      sessions.set(token, { accountId: account._id.toString(), username: account.username, displayUsername: account.displayUsername || account.username, createdAt: Date.now() });
      json(res, 200, { ok: true, username: account.username, displayUsername: account.displayUsername || account.username }, { "Set-Cookie": setCookieHeader(token) });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  // POST /api/auth/logout
  if (pathname === "/api/auth/logout" && req.method === "POST") {
    const cookie = req.headers.cookie || "";
    const match = cookie.match(/session=([a-f0-9]+)/);
    if (match) sessions.delete(match[1]);
    json(res, 200, { ok: true }, { "Set-Cookie": clearCookieHeader() });
    return;
  }

  // GET /api/auth/me
  if (pathname === "/api/auth/me" && req.method === "GET") {
    const session = getSession(req);
    if (!session) return json(res, 200, { loggedIn: false });
    json(res, 200, { loggedIn: true, username: session.username, displayUsername: session.displayUsername });
    return;
  }

  // ── USERS (Steam accounts) — scoped by login session ───────────────────

  // GET /api/users
  if (pathname === "/api/users" && req.method === "GET") {
    const session = getSession(req);
    if (!session) return json(res, 200, []); // not logged in = empty list
    try {
      const users = await db.collection("users").find({ accountId: session.accountId }).sort({ displayName: 1 }).toArray();
      json(res, 200, users.map(u => ({ steamId: u.steamId, displayName: u.displayName, lastUsed: u.lastUsed })));
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  // POST /api/users
  if (pathname === "/api/users" && req.method === "POST") {
    const session = getSession(req);
    if (!session) return json(res, 401, { error: "Not logged in" });
    try {
      const { steamId: sid, displayName } = await readBody(req);
      if (!sid || !/^\d{17}$/.test(sid)) return json(res, 400, { error: "Invalid steamId" });
      await db.collection("users").updateOne(
        { steamId: sid, accountId: session.accountId },
        { $set: { steamId: sid, accountId: session.accountId, displayName: displayName || sid, lastUsed: new Date() } },
        { upsert: true }
      );
      json(res, 200, { ok: true });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  // DELETE /api/users/:steamid
  const deleteMatch = pathname.match(/^\/api\/users\/(\d{17})$/);
  if (deleteMatch && req.method === "DELETE") {
    const session = getSession(req);
    if (!session) return json(res, 401, { error: "Not logged in" });
    try {
      await db.collection("users").deleteOne({ steamId: deleteMatch[1], accountId: session.accountId });
      json(res, 200, { ok: true });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  // ── STEAM GAME/ACHIEVEMENT ENDPOINTS (no auth required) ─────────────────

  if (pathname === "/api/games") {
    if (!steamId) return json(res, 400, { error: "Missing steamid" });
    try {
      const games = await getOwnedGames(steamId);
      games.sort((a, b) => (b.playtime_forever || 0) - (a.playtime_forever || 0));
      json(res, 200, games);
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  const achMatch = pathname.match(/^\/api\/achievements\/(\d+)$/);
  if (achMatch) {
    const appId = achMatch[1];
    if (!steamId) return json(res, 400, { error: "Missing steamid" });
    try {
      const [achievements, schema, meta] = await Promise.all([getAchievements(appId, steamId), getAchievementSchema(appId), getFullGameMeta(appId)]);
      if (!achievements) { json(res, 200, { supported: false, achievements: [], genres: meta.genres, tags: meta.tags, categories: meta.categories }); return; }
      const enriched = achievements.map(a => {
        const m = schema[a.apiname] || {};
        return { apiname: a.apiname, achieved: a.achieved === 1, unlocktime: a.unlocktime, displayName: m.displayName || a.apiname, description: m.description || "", icon: a.achieved === 1 ? m.icon : m.icongray };
      });
      enriched.sort((a, b) => Number(b.achieved) - Number(a.achieved));
      json(res, 200, { supported: true, achievements: enriched, genres: meta.genres, tags: meta.tags, categories: meta.categories });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  // ── GROUP ENDPOINTS ──────────────────────────────────────────────────────

  if (pathname === "/api/group/games" && req.method === "GET") {
    const steamIds = (parsed.query.steamids || "").split(",").filter(s => /^\d{17}$/.test(s));
    if (steamIds.length < 2) return json(res, 400, { error: "Need at least 2 valid steamids" });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });
    const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    try {
      send({ type: "status", msg: "Fetching libraries…" });
      const libraries = await Promise.all(steamIds.map(id => getOwnedGames(id)));
      const userMaps = libraries.map(games => { const m = {}; for (const g of games) m[g.appid] = g; return m; });
      const sharedGames = [];
      for (const [appid, game] of Object.entries(userMaps[0])) {
        if (userMaps.every(m => m[appid])) {
          const perUser = steamIds.map((sid, i) => ({ steamId: sid, playtime: userMaps[i][appid]?.playtime_forever || 0, lastPlayed: userMaps[i][appid]?.rtime_last_played || 0 }));
          sharedGames.push({ appid: parseInt(appid), name: game.name, img: game.img_icon_url, perUser });
        }
      }
      const sample = sharedGames.slice(0, 60);
      const sampleCount = sample.length;
      send({ type: "status", msg: `Found ${sharedGames.length} shared games. Scanning tags & filtering single-player…`, total: sampleCount, scanned: 0 });
      const tagTotals = {}, allTagNames = new Set();
      const multiplayerGameIds = new Set();
      for (let i = 0; i < sampleCount; i++) {
        if (i > 0 && i % 10 === 0) await sleep(1000);
        const { tags: rawTags, categories } = await getGameTagsAndCategories(sample[i].appid);
        if (!isPurelySignlePlayer(categories)) multiplayerGameIds.add(sample[i].appid);
        for (const [tag, count] of Object.entries(rawTags)) { allTagNames.add(tag); tagTotals[tag] = (tagTotals[tag] || 0) + count; }
        send({ type: "progress", scanned: i + 1, total: sampleCount });
      }
      const filteredSharedGames = sharedGames.filter(g => {
        if (multiplayerGameIds.has(g.appid)) return true;
        return !sample.some(s => s.appid === g.appid);
      });
      const topTags = Object.entries(tagTotals).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name]) => name);
      const allTags = [...allTagNames].sort();
      send({ type: "done", sharedCount: filteredSharedGames.length, totalShared: sharedGames.length, singlePlayerRemoved: sharedGames.length - filteredSharedGames.length, sharedGames: filteredSharedGames, topTags, allTags });
    } catch (e) { send({ type: "error", msg: e.message }); }
    res.end();
    return;
  }

  if (pathname === "/api/group/filter" && req.method === "GET") {
    const steamIds = (parsed.query.steamids || "").split(",").filter(s => /^\d{17}$/.test(s));
    const tags = (parsed.query.tags || "").split(",").map(t => t.toLowerCase().trim()).filter(Boolean);
    const mode = parsed.query.mode === "any" ? "any" : "all";
    const appids = (parsed.query.appids || "").split(",").map(Number).filter(Boolean);
    if (!tags.length || !appids.length) return json(res, 400, { error: "Missing tags or appids" });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });
    const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    try {
      const matched = [];
      send({ type: "progress", scanned: 0, total: appids.length });
      for (let i = 0; i < appids.length; i++) {
        if (i > 0 && i % 10 === 0) await sleep(1000);
        const { tags: rawTags, categories } = await getGameTagsAndCategories(appids[i]);
        if (isPurelySignlePlayer(categories)) { send({ type: "progress", scanned: i + 1, total: appids.length }); continue; }
        const gameTags = Object.keys(rawTags).map(t => t.toLowerCase());
        const matches = mode === "all" ? tags.every(tag => gameTags.includes(tag)) : tags.some(tag => gameTags.includes(tag));
        if (matches) matched.push(appids[i]);
        send({ type: "progress", scanned: i + 1, total: appids.length });
      }
      send({ type: "done", matched });
    } catch (e) { send({ type: "error", msg: e.message }); }
    res.end();
    return;
  }

  if (pathname === "/api/group/gamedetails" && req.method === "GET") {
    const appId = parsed.query.appid;
    const steamIds = (parsed.query.steamids || "").split(",").filter(s => /^\d{17}$/.test(s));
    if (!appId || !steamIds.length) return json(res, 400, { error: "Missing appid or steamids" });
    try {
      const [meta, ...achStats] = await Promise.all([getFullGameMeta(appId), ...steamIds.map(sid => getPlayerAchievementStats(appId, sid))]);
      json(res, 200, { genres: meta.genres, tags: meta.tags, categories: meta.categories, userStats: steamIds.map((sid, i) => ({ steamId: sid, ...achStats[i] })) });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  json(res, 404, { error: "Not found" });
});

connectMongo().then(() => {
  server.listen(PORT, () => console.log(`\n🎮 Steam Tracker running at http://localhost:${PORT}\n`));
}).catch(err => { console.error("❌ MongoDB connection failed:", err.message); process.exit(1); });