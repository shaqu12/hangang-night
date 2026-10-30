// 밤 한강 돗자리: 접속한 사람마다 캐릭터 하나. 방 하나에 돗자리 CAP개, 차면 다음 방.
// 들어오면 산책로에 서 있다가, 빈 돗자리를 누르면 그 자리로 간다(먼저 요청이 도착한 사람이 차지).
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const CAP = 30;              // 방 하나의 돗자리 수 (index.html의 SEATS와 같아야 함)
const MAX_ROOMS = 20;        // 최대 600명
const PER_IP = +process.env.PER_IP || 20;          // IP당 동시 접속 (통신사·학교 와이파이는 여러 사람이 IP 하나를 같이 써서 넉넉히)
const EMOJIS = ["🌙", "✨", "🍜", "👋", "💤", "❤️"];
const COLORS = ["#e9a87c", "#8fb8de", "#b8d98f", "#e6c76f", "#d79bc4", "#9fd6cf", "#f0f0ea", "#c9a6f2", "#f29b9b", "#7fa3c9"];
const EMO_GAP = 1200;        // 이모지 최소 간격(ms)
const SIT_GAP = 600;         // 자리 옮기기 최소 간격(ms)
const ACTS = ["sit", "lie", "star", "ramen", "chicken", "photo", "stretch", "doze"];   // 돗자리 위 행동
const ACT_GAP = 400;

const page = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const ogImage = fs.readFileSync(path.join(__dirname, "og.jpg"));
const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); return res.end("ok"); }
  if (req.url === "/stats") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ total: total(), rooms: rooms.map(r => r.users.size), today: summary(day), yesterday: prevDay && summary(prevDay) }, null, 1));
  }
  if (req.url === "/og.jpg") { res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" }); return res.end(ogImage); }
  const am = /^\/(amb-(?:river|city|crick)\.mp3)$/.exec(req.url);
  if (am) return sendAudio(req, res, path.join(__dirname, am[1]));
  // 카카오톡·인스타 링크 미리보기는 이미지 주소가 절대 주소여야 해서 요청한 주소를 넣어 준다
  const origin = (req.headers["x-forwarded-proto"] || "http") + "://" + (req.headers["x-forwarded-host"] || req.headers.host);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
  res.end(page.replaceAll("%ORIGIN%", origin));
});

// 배경 소리 (강물·도시·풀벌레 3개). 사파리는 오디오에 Range(206) 응답이 필요하다.
function sendAudio(req, res, AUDIO) {
  let size; try { size = fs.statSync(AUDIO).size; } catch { res.writeHead(404); return res.end(); }
  const head = { "content-type": "audio/mpeg", "accept-ranges": "bytes", "cache-control": "public, max-age=86400" };
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  if (!m) { res.writeHead(200, { ...head, "content-length": size }); return req.method === "HEAD" ? res.end() : fs.createReadStream(AUDIO).pipe(res); }
  const start = m[1] ? +m[1] : size - +m[2], end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
  if (start >= size || start > end) { res.writeHead(416, { "content-range": `bytes */${size}` }); return res.end(); }
  res.writeHead(206, { ...head, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
  req.method === "HEAD" ? res.end() : fs.createReadStream(AUDIO, { start, end }).pipe(res);
}

// 오늘(한국 시간) 방문 기록. 메모리에만 있어서 서버가 잠들거나 재시작하면 0부터 다시 센다.
// 그래서 매시 정각과 날짜가 바뀔 때 Render 로그에도 한 줄씩 남긴다.
const kstDate = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const newDay = () => ({ date: kstDate(), visits: 0, people: new Set(), secs: [], peak: 0, sources: {} });
let day = newDay(), prevDay = null;
function summary(d) {
  const s = [...d.secs].sort((a, b) => a - b), mid = s.length ? s[s.length >> 1] : 0;
  return { date: d.date, visits: d.visits, people: d.people.size, finished: s.length,
    avgMin: s.length ? +(s.reduce((a, b) => a + b, 0) / s.length / 60).toFixed(1) : 0, medianMin: +(mid / 60).toFixed(1),
    over5min: s.filter(x => x >= 300).length, peak: d.peak, sources: d.sources };
}
function rollDay() { if (day.date !== kstDate()) { console.log("[stats] " + JSON.stringify(summary(day))); prevDay = day; day = newDay(); } }
setInterval(() => { rollDay(); if (new Date().getMinutes() === 0) console.log("[stats] " + JSON.stringify(summary(day))); }, 60000);
const ipKey = ip => require("crypto").createHash("sha256").update(ip + day.date).digest("hex").slice(0, 12);  // IP는 저장하지 않고 하루짜리 해시만

const rooms = [];            // [{ no, users: Map<id, user> }]
const ips = new Map();
let nextId = 1;
const total = () => rooms.reduce((n, r) => n + r.users.size, 0);

function pickRoom() {
  let r = rooms.find(r => r.users.size < CAP);
  if (!r && rooms.length < MAX_ROOMS) { r = { no: rooms.length + 1, users: new Map() }; rooms.push(r); }
  return r;
}
const pub = u => ({ id: u.id, seat: u.seat, color: u.color, act: u.act });
function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room, msg, except) {
  const s = JSON.stringify(msg);
  for (const u of room.users.values()) if (u.ws !== except && u.ws.readyState === 1) u.ws.send(s);
}
function sendCounts() {
  const t = total();
  for (const r of rooms) broadcast(r, { t: "count", room: r.users.size, total: t });
}

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 256 });
wss.on("connection", (ws, req) => {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if ((ips.get(ip) || 0) >= PER_IP) { send(ws, { t: "full", why: "ip" }); return ws.close(); }
  const room = pickRoom();
  if (!room) { send(ws, { t: "full", why: "rooms" }); return ws.close(); }
  ips.set(ip, (ips.get(ip) || 0) + 1);
  rollDay();
  const from = (/[?&]from=([\w-]{1,20})/.exec(req.url) || [, "direct"])[1], since = Date.now();
  day.visits++; day.people.add(ipKey(ip)); day.sources[from] = (day.sources[from] || 0) + 1;

  const u = { id: nextId++, seat: null, color: COLORS[Math.floor(Math.random() * COLORS.length)], ws, lastEmo: 0, lastSit: 0, act: "sit", lastAct: 0 };
  room.users.set(u.id, u);
  ws.alive = true;
  send(ws, { t: "init", you: u.id, room: room.no, cap: CAP, emojis: EMOJIS, users: [...room.users.values()].map(pub) });
  broadcast(room, { t: "join", user: pub(u) }, ws);
  sendCounts();
  day.peak = Math.max(day.peak, total());

  ws.on("pong", () => { ws.alive = true; });
  ws.on("message", raw => {
    ws.alive = true;
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === "emo" && EMOJIS.includes(m.e)) {
      const now = Date.now();
      if (now - u.lastEmo < EMO_GAP) return;
      u.lastEmo = now;
      broadcast(room, { t: "emo", id: u.id, e: m.e });
    } else if (m.t === "act" && ACTS.includes(m.a) && m.a !== u.act) {
      const now = Date.now();
      if (now - u.lastAct < ACT_GAP) return;
      u.lastAct = now; u.act = m.a;
      broadcast(room, { t: "act", id: u.id, a: u.act });
    } else if (m.t === "sit" && Number.isInteger(m.seat) && m.seat >= 0 && m.seat < CAP && m.seat !== u.seat) {
      const now = Date.now();
      if (now - u.lastSit < SIT_GAP) return;
      u.lastSit = now;
      for (const o of room.users.values()) if (o.seat === m.seat) return send(ws, { t: "taken", seat: m.seat });
      u.seat = m.seat;
      broadcast(room, { t: "seat", id: u.id, seat: u.seat });
    }
  });
  ws.on("close", () => {
    if (day.secs.length < 20000) day.secs.push(Math.round((Date.now() - since) / 1000));
    room.users.delete(u.id);
    const n = ips.get(ip) - 1; n > 0 ? ips.set(ip, n) : ips.delete(ip);
    broadcast(room, { t: "leave", id: u.id });
    sendCounts();
  });
});

// 끊긴 연결 정리 (30초마다 ping, 응답 없으면 종료)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false; ws.ping();
  }
}, 30000);

server.listen(PORT, () => console.log("listening on", PORT));
