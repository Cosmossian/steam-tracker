const http = require("http");
const https = require("https");
const url = require("url");
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const STEAM_API_KEY = "332A0BDAEA7F4786C0BF5F5A8A0A7C3B";
const PORT = 3000;
const MONGO_URL = process.env.MONGO_URL || "mongodb://admin:password@localhost:27017/";
const DB_NAME = "steamtracker";

let db;

async function connectMongo() {
  const client = new MongoClient(MONGO_URL, {
    tls: true,
    tlsAllowInvalidCertificates: false,
    serverSelectionTimeoutMS: 5000,
  });
  await client.connect();
  db = client.db(DB_NAME);
  console.log("✅ Connected to MongoDB");
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
  const apiUrl = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_API_KEY}&steamid=${steamId}&include_appinfo=true&include_played_free_games=true`;
  const data = await fetchJSON(apiUrl);
  return data.response?.games || [];
}

async function getAchievements(appId, steamId) {
  const apiUrl = `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=${STEAM_API_KEY}&steamid=${steamId}&appid=${appId}`;
  try {
    const data = await fetchJSON(apiUrl);
    if (data.playerstats?.success === false) return null;
    return data.playerstats?.achievements || null;
  } catch { return null; }
}

async function getAchievementSchema(appId) {
  const apiUrl = `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${STEAM_API_KEY}&appid=${appId}`;
  try {
    const data = await fetchJSON(apiUrl);
    const achievements = data.game?.availableGameStats?.achievements || [];
    const map = {};
    for (const a of achievements) {
      map[a.name] = { displayName: a.displayName, description: a.description || "", icon: a.icon, icongray: a.icongray };
    }
    return map;
  } catch { return {}; }
}

// Categories we care about displaying
const DISPLAY_CATEGORIES = new Set([
  "Single-player", "Multi-player", "Co-op", "Online Co-op", "Local Co-op",
  "Online PvP", "Local PvP", "Cross-Platform Multiplayer",
  "Steam Achievements", "Steam Trading Cards", "Steam Cloud", "Family Sharing",
  "Full controller support", "Partial Controller Support"
]);

// Categories that indicate multiplayer capability
const MULTIPLAYER_CATEGORIES = new Set([
  "Multi-player", "Co-op", "Online Co-op", "Local Co-op",
  "Online PvP", "Local PvP", "Cross-Platform Multiplayer"
]);

async function getFullGameMeta(appId) {
  // Fetch genres, tags, and categories all in one store API call + steamspy
  const [storeData, spyData] = await Promise.all([
    fetchJSON(`https://store.steampowered.com/api/appdetails?appids=${appId}&filters=genres,categories`).catch(() => null),
    fetchJSON(`https://steamspy.com/api.php?request=appdetails&appid=${appId}`).catch(() => null)
  ]);

  const appData = storeData?.[appId];
  const genres = appData?.success ? (appData.data?.genres || []).map(g => g.description) : [];

  // Categories: return all that are in our display list
  const rawCategories = appData?.success ? (appData.data?.categories || []) : [];
  const categories = rawCategories
    .map(c => c.description)
    .filter(c => DISPLAY_CATEGORIES.has(c));

  // Tags from steamspy
  const rawTags = spyData?.tags || {};
  const tags = Object.entries(rawTags)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name]) => name);

  return { genres, tags, categories };
}

async function getGameTagsRaw(appId) {
  const apiUrl = `https://steamspy.com/api.php?request=appdetails&appid=${appId}`;
  try {
    const data = await fetchJSON(apiUrl);
    return data.tags || {};
  } catch { return {}; }
}

// Returns { tags: {}, categories: [] } for group filtering
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
  const hasSinglePlayer = categories.includes("Single-player");
  const hasMultiplayer = categories.some(c => MULTIPLAYER_CATEGORIES.has(c));
  return hasSinglePlayer && !hasMultiplayer;
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

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const steamId = parsed.query.steamid;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (pathname === "/" || pathname === "/index.html") {
    const filePath = path.join(__dirname, "index.html");
    fs.readFile(filePath, (err, content) => {
      if (err) { res.writeHead(500); res.end("Could not load index.html"); return; }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(content);
    });
    return;
  }

  if (pathname === "/api/users" && req.method === "GET") {
    try {
      const users = await db.collection("users").find({}).sort({ lastUsed: -1 }).toArray();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(users.map(u => ({ steamId: u.steamId, displayName: u.displayName, lastUsed: u.lastUsed }))));
    } catch (e) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  if (pathname === "/api/users" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const { steamId: sid, displayName } = body;
      if (!sid || !/^\d{17}$/.test(sid)) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Invalid steamId" })); return; }
      await db.collection("users").updateOne({ steamId: sid }, { $set: { steamId: sid, displayName: displayName || sid, lastUsed: new Date() } }, { upsert: true });
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true }));
    } catch (e) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  const deleteMatch = pathname.match(/^\/api\/users\/(\d{17})$/);
  if (deleteMatch && req.method === "DELETE") {
    try {
      await db.collection("users").deleteOne({ steamId: deleteMatch[1] });
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true }));
    } catch (e) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  if (pathname === "/api/games") {
    if (!steamId) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing steamid" })); return; }
    try {
      const games = await getOwnedGames(steamId);
      games.sort((a, b) => (b.playtime_forever || 0) - (a.playtime_forever || 0));
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(games));
    } catch (e) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  const achMatch = pathname.match(/^\/api\/achievements\/(\d+)$/);
  if (achMatch) {
    const appId = achMatch[1];
    if (!steamId) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing steamid" })); return; }
    try {
      const [achievements, schema, meta] = await Promise.all([
        getAchievements(appId, steamId),
        getAchievementSchema(appId),
        getFullGameMeta(appId)
      ]);
      if (!achievements) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ supported: false, achievements: [], genres: meta.genres, tags: meta.tags, categories: meta.categories }));
        return;
      }
      const enriched = achievements.map((a) => {
        const m = schema[a.apiname] || {};
        return { apiname: a.apiname, achieved: a.achieved === 1, unlocktime: a.unlocktime, displayName: m.displayName || a.apiname, description: m.description || "", icon: a.achieved === 1 ? m.icon : m.icongray };
      });
      enriched.sort((a, b) => Number(b.achieved) - Number(a.achieved));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ supported: true, achievements: enriched, genres: meta.genres, tags: meta.tags, categories: meta.categories }));
    } catch (e) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // GET /api/group/games — SSE, now also filters out purely single-player games
  if (pathname === "/api/group/games" && req.method === "GET") {
    const steamIds = (parsed.query.steamids || "").split(",").filter(s => /^\d{17}$/.test(s));
    if (steamIds.length < 2) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Need at least 2 valid steamids" })); return; }

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    try {
      send({ type: "status", msg: "Fetching libraries…" });
      const libraries = await Promise.all(steamIds.map(id => getOwnedGames(id)));
      const userMaps = libraries.map(games => { const m = {}; for (const g of games) m[g.appid] = g; return m; });

      // Intersection
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

      const tagTotals = {};
      const allTagNames = new Set();
      const multiplayerGameIds = new Set(); // appids confirmed to have multiplayer

      for (let i = 0; i < sampleCount; i++) {
        if (i > 0 && i % 10 === 0) await sleep(1000);
        const { tags: rawTags, categories } = await getGameTagsAndCategories(sample[i].appid);

        // Track multiplayer eligibility
        if (!isPurelySignlePlayer(categories)) {
          multiplayerGameIds.add(sample[i].appid);
        }

        for (const [tag, count] of Object.entries(rawTags)) {
          allTagNames.add(tag);
          tagTotals[tag] = (tagTotals[tag] || 0) + count;
        }
        send({ type: "progress", scanned: i + 1, total: sampleCount });
      }

      // For games NOT in the sample, we can't check categories — include them by default
      // (they'll be filtered at roll time if needed)
      const filteredSharedGames = sharedGames.filter(g => {
        if (multiplayerGameIds.has(g.appid)) return true; // confirmed multiplayer
        // if not in sample, include optimistically
        const inSample = sample.some(s => s.appid === g.appid);
        return !inSample; // not sampled = include
      });

      const topTags = Object.entries(tagTotals).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name]) => name);
      const allTags = [...allTagNames].sort();

      send({
        type: "done",
        sharedCount: filteredSharedGames.length,
        totalShared: sharedGames.length,
        singlePlayerRemoved: sharedGames.length - filteredSharedGames.length,
        sharedGames: filteredSharedGames,
        topTags,
        allTags
      });
    } catch (e) { send({ type: "error", msg: e.message }); }
    res.end();
    return;
  }

  // GET /api/group/filter — SSE, tags + mode, also re-checks categories
  if (pathname === "/api/group/filter" && req.method === "GET") {
    const steamIds = (parsed.query.steamids || "").split(",").filter(s => /^\d{17}$/.test(s));
    const tags = (parsed.query.tags || "").split(",").map(t => t.toLowerCase().trim()).filter(Boolean);
    const mode = parsed.query.mode === "any" ? "any" : "all";
    const appids = (parsed.query.appids || "").split(",").map(Number).filter(Boolean);

    if (!tags.length || !appids.length) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Missing tags or appids" })); return; }

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    try {
      const matched = [];
      send({ type: "progress", scanned: 0, total: appids.length });

      for (let i = 0; i < appids.length; i++) {
        if (i > 0 && i % 10 === 0) await sleep(1000);
        const { tags: rawTags, categories } = await getGameTagsAndCategories(appids[i]);

        // Skip purely single-player games in group mode
        if (isPurelySignlePlayer(categories)) {
          send({ type: "progress", scanned: i + 1, total: appids.length });
          continue;
        }

        const gameTags = Object.keys(rawTags).map(t => t.toLowerCase());
        const matches = mode === "all"
          ? tags.every(tag => gameTags.includes(tag))
          : tags.some(tag => gameTags.includes(tag));

        if (matches) matched.push(appids[i]);
        send({ type: "progress", scanned: i + 1, total: appids.length });
      }

      send({ type: "done", matched });
    } catch (e) { send({ type: "error", msg: e.message }); }
    res.end();
    return;
  }

  // GET /api/group/gamedetails
  if (pathname === "/api/group/gamedetails" && req.method === "GET") {
    const appId = parsed.query.appid;
    const steamIds = (parsed.query.steamids || "").split(",").filter(s => /^\d{17}$/.test(s));
    if (!appId || !steamIds.length) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Missing appid or steamids" })); return; }
    try {
      const [meta, ...achStats] = await Promise.all([getFullGameMeta(appId), ...steamIds.map(sid => getPlayerAchievementStats(appId, sid))]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ genres: meta.genres, tags: meta.tags, categories: meta.categories, userStats: steamIds.map((sid, i) => ({ steamId: sid, ...achStats[i] })) }));
    } catch (e) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

connectMongo().then(() => {
  server.listen(PORT, () => console.log(`\n🎮 Steam Tracker running at http://localhost:${PORT}\n`));
}).catch(err => { console.error("❌ MongoDB connection failed:", err.message); process.exit(1); });