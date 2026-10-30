// 밤 한강 돗자리: 접속한 사람마다 캐릭터 하나. 방 하나에 돗자리 CAP개, 차면 다음 방.
// 들어오면 산책로에 서 있다가, 빈 돗자리를 누르면 그 자리로 간다(먼저 요청이 도착한 사람이 차지).
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const CAP = 30;              // 방 하나의 돗자리 수 (index.html의 SEATS와 같아야 함)
const MAX_ROOMS = 20;        // 최대 600명
const PER_IP = +process.env.PER_IP || 4;           // IP당 동시 접속
const EMOJIS = ["🌙", "✨", "🍜", "👋", "💤", "❤️"];
const COLORS = ["#e9a87c", "#8fb8de", "#b8d98f", "#e6c76f", "#d79bc4", "#9fd6cf", "#f0f0ea", "#c9a6f2", "#f29b9b", "#7fa3c9"];
const EMO_GAP = 1200;        // 이모지 최소 간격(ms)
const SIT_GAP = 600;         // 자리 옮기기 최소 간격(ms)

const page = fs.readFileSync(path.join(__dirname, "index.html"));
const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); return res.end("ok"); }
  if (req.url === "/stats") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ total: total(), rooms: rooms.map(r => r.users.size) }));
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
  res.end(page);
});

const rooms = [];            // [{ no, users: Map<id, user> }]
const ips = new Map();
let nextId = 1;
const total = () => rooms.reduce((n, r) => n + r.users.size, 0);

function pickRoom() {
  let r = rooms.find(r => r.users.size < CAP);
  if (!r && rooms.length < MAX_ROOMS) { r = { no: rooms.length + 1, users: new Map() }; rooms.push(r); }
  return r;
}
const pub = u => ({ id: u.id, seat: u.seat, color: u.color });
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

  const u = { id: nextId++, seat: null, color: COLORS[Math.floor(Math.random() * COLORS.length)], ws, lastEmo: 0, lastSit: 0 };
  room.users.set(u.id, u);
  ws.alive = true;
  send(ws, { t: "init", you: u.id, room: room.no, cap: CAP, emojis: EMOJIS, users: [...room.users.values()].map(pub) });
  broadcast(room, { t: "join", user: pub(u) }, ws);
  sendCounts();

  ws.on("pong", () => { ws.alive = true; });
  ws.on("message", raw => {
    ws.alive = true;
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === "emo" && EMOJIS.includes(m.e)) {
      const now = Date.now();
      if (now - u.lastEmo < EMO_GAP) return;
      u.lastEmo = now;
      broadcast(room, { t: "emo", id: u.id, e: m.e });
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
