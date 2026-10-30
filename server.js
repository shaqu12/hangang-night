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
const EMOJIS = ["❤️", "👍", "😂", "🥺", "👋", "✨", "🌙"];   // 마음(감정) 이모지. 행동(라면·눕기 등)은 ACTS로 따로
const COLORS = ["#e9a87c", "#8fb8de", "#b8d98f", "#e6c76f", "#d79bc4", "#9fd6cf", "#f0f0ea", "#c9a6f2", "#f29b9b", "#7fa3c9"];
const EMO_GAP = 1200;        // 이모지 최소 간격(ms)
const SIT_GAP = 600;         // 자리 옮기기 최소 간격(ms)
const ACTS = ["sit", "lie", "star", "ramen", "chicken", "photo", "stretch", "doze"];   // 돗자리 위 행동
const ACT_GAP = 400;
const FW_GAP = 2500;         // 폭죽 최소 간격(ms). 연타로 하늘을 덮지 못하게
const FOUNTAIN_P = +process.env.FOUNTAIN_P || .12;   // 폭죽 1발마다 다리 무지개분수가 켜질 확률
const FOUNTAIN_LEN = 25000, FOUNTAIN_GAP = 60000;   // 쇼 25초, 방마다 끝나고 1분은 다시 안 켜짐
const NICK_GAP = 3000, NICK_MAX = 5;
// 닉네임: 5자까지. 안 정하면 서버가 귀여운 한강 이름(띄어쓰기 없이 5자 이내)을 붙인다. 같은 이름 허용.
const NICK_A = ["졸린", "배부른", "꾸벅", "느긋한", "말랑", "반짝", "수줍은", "멍한", "신난", "포근", "늦잠", "산책"];
const NICK_B = ["수달", "냥이", "오리", "멍멍", "너구리", "토끼", "펭귄", "곰", "부엉", "해달", "고래", "다람"];
const randNick = () => { for (;;) { const n = NICK_A[Math.random() * NICK_A.length | 0] + NICK_B[Math.random() * NICK_B.length | 0]; if ([...n].length <= NICK_MAX) return n; } };
// 욕설·비하·음란어. 비교 전에 띄어쓰기·숫자·기호를 빼고, 영어는 1→i 0→o 같은 바꿔치기를 되돌리고, 같은 글자 반복을 줄인다.
// 자음만 친 경우(ㅅㅂ 등)는 단어의 초성과도 비교한다. 운영자 사칭 단어도 막는다(운영자 본인은 허용).
const BAD = ["시발", "씨발", "씨빨", "씨팔", "시팔", "시바", "십발", "씹", "병신", "븅신", "빙신", "좆", "좃", "존나", "졸라", "개새", "개색", "개세", "새끼", "색기", "섀끼", "미친", "미쳤", "지랄", "썅", "쌍놈", "닥쳐", "꺼져", "엠창", "느금", "니애미", "니미", "애미", "애비", "에미", "한남", "한녀", "김치녀", "된장녀", "틀딱", "급식충", "맘충", "짱깨", "쪽바리", "흑형", "깜둥", "장애", "애자", "찐따", "병자", "죽어", "뒤져", "자살",
  "섹스", "섹", "쎅", "야동", "야사", "보지", "보짓", "자지", "잦이", "꼴려", "꼴림", "발기", "사정", "정액", "자위", "딸딸", "딸치", "오르가", "가슴만", "젖", "유두", "꼭지", "엉덩", "변태", "강간", "몰카", "성기", "음경", "음란", "야한", "벗어", "알몸", "누드", "fuck", "fuk", "shit", "bitch", "sex", "porn", "nigg", "dick", "pussy", "cunt", "asshole", "boob", "tits", "nude", "cock", "penis", "vagina", "horny", "milf", "hentai", "xxx", "slut", "whore", "rape"];
const IMPOSTOR = ["운영", "관리자", "관리인", "어드민", "admin", "매니저", "manager", "개발자", "공식", "official", "staff", "스탭", "스태프"];
const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const toCho = w => [...w].map(ch => { const c = ch.charCodeAt(0) - 0xac00; return c >= 0 && c < 11172 ? CHO[Math.floor(c / 588)] : ch; }).join("");
const BAD_CHO = BAD.filter(w => /^[가-힣]{2,}$/.test(w)).map(toCho).concat(["ㅅㅂ", "ㅆㅂ", "ㅂㅅ", "ㅈㄴ", "ㅅㄲ", "ㅁㅊ", "ㅈㄹ", "ㅗ", "ㅄ", "ㅈㅈ", "ㅂㅈ", "ㅅㅅ"]);
function cleanNick(raw, admin, max = NICK_MAX) {
  if (typeof raw !== "string") return null;
  const n = [...raw.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\u3164\uffa0]/g, "").replace(/\s+/g, " ").trim()].slice(0, max).join("").trim();
  if (!n) return null;
  if (admin === "free") return n;                                                       // 운영자 글은 거르지 않는다
  const low = n.toLowerCase(), squash = x => x.replace(/[^a-z가-힣ㄱ-ㅎㅏ-ㅣ]/g, "").replace(/(.)\1+/g, "$1");
  const flats = [squash(low.replace(/[1!|]/g, "i").replace(/0/g, "o").replace(/3/g, "e").replace(/[4@]/g, "a").replace(/[5$]/g, "s").replace(/7/g, "t")), squash(low)];   // 숫자를 글자로 / 숫자를 빼고
  const hasJamo = /[ㄱ-ㅎ]/.test(n), cho = hasJamo ? toCho(flats[1]).replace(/[^ㄱ-ㅎ]/g, "") : "";   // 자음을 섞어 친 경우만 초성으로도 비교
  if (flats.some(f => BAD.some(w => f.includes(w))) || (hasJamo && BAD_CHO.some(w => cho.includes(w)))) return false;
  if (!admin && flats.some(f => IMPOSTOR.some(w => f.includes(w)))) return false;
  return n;   // false = 걸러짐
}
// 운영자: Render 환경 변수 ADMIN_KEY와 같은 키로 들어온 사람. 왕관 이름표, 황금 폭죽(1초 간격), 분수·유성우 켜기
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const isAdminKey = k => ADMIN_KEY.length >= 8 && typeof k === "string" && k.length === ADMIN_KEY.length && require("crypto").timingSafeEqual(Buffer.from(k), Buffer.from(ADMIN_KEY));
const WISH_MAX = 15, LANTERN_GAP = 15000, HEART_GAP = 1500;   // 소원 풍등 글자 수·간격, 하트 간격
const FW_KINDS = 5, FW_COLORS = 7;   // index.html FW_SHAPES·FW_HUES 길이와 같아야 함

// "나에게 하고 싶은 말"은 서버로 오지 않고 폰 안에서만 거른다. 그래서 욕설·음란어 목록을 페이지에 끼워 준다.
// 마음 글에는 흔히 쓰는 말(사정·벗어나다·젖다·한남대교)과 위기 표현(죽고 싶다·자살 등, 상담 번호를 안내해야 함)은 막지 않는다
const MIND_OK = ["죽어", "뒤져", "자살", "미친", "미쳤", "장애", "병자", "꺼져", "닥쳐", "사정", "벗어", "젖", "한남"];
const MIND_BAD = BAD.filter(w => !MIND_OK.includes(w)), MIND_BAD_CHO = MIND_BAD.filter(w => /^[가-힣]{2,}$/.test(w)).map(toCho).concat(["ㅅㅂ", "ㅆㅂ", "ㅂㅅ", "ㅈㄴ", "ㅅㄲ", "ㅈㄹ", "ㅄ", "ㅈㅈ", "ㅂㅈ", "ㅅㅅ"]);
const page = fs.readFileSync(path.join(__dirname, "index.html"), "utf8").replace("/*HN_BAD*/[]", JSON.stringify(MIND_BAD)).replace("/*HN_BAD_CHO*/[]", JSON.stringify(MIND_BAD_CHO));
const ogImage = fs.readFileSync(path.join(__dirname, "og.jpg"));
const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); return res.end("ok"); }
  if (req.url === "/stats") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ total: total(), rooms: rooms.map(r => r.users.size), today: summary(day), yesterday: prevDay && summary(prevDay) }, null, 1));
  }
  if (req.url === "/og.jpg") { res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" }); return res.end(ogImage); }
  const am = /^\/(amb-(?:river|city|crick)\.mp3)(?:\?v=\d+)?$/.exec(req.url);
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
  if (!r && rooms.length < MAX_ROOMS) { r = { no: rooms.length + 1, users: new Map(), fountainAt: 0 }; rooms.push(r); }
  return r;
}
const adminHere = room => [...room.users.values()].some(o => o.admin);
const pub = u => ({ id: u.id, seat: u.seat, color: u.color, act: u.act, nick: u.nick, admin: u.admin || undefined });
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

  const u = { id: nextId++, seat: null, color: COLORS[Math.floor(Math.random() * COLORS.length)], ws, lastEmo: 0, lastSit: 0, act: "sit", lastAct: 0, lastFw: 0, lastNick: 0, nick: null };
  let asked = null; try { asked = decodeURIComponent((/[?&]nick=([^&]{1,120})/.exec(req.url) || [])[1] || ""); } catch {}
  let key = null; try { key = decodeURIComponent((/[?&]admin=([^&]{1,200})/.exec(req.url) || [])[1] || ""); } catch {}
  u.admin = isAdminKey(key);
  u.nick = (u.admin ? cleanNick(asked, "free", 12) : cleanNick(asked)) || randNick();   // 운영자 닉네임은 12자까지, 거르지 않음
  room.users.set(u.id, u);
  ws.alive = true;
  send(ws, { t: "init", you: u.id, admin: u.admin, adminHere: adminHere(room) || u.admin, room: room.no, cap: CAP, emojis: EMOJIS, users: [...room.users.values()].map(pub), fountain: Date.now() - room.fountainAt < FOUNTAIN_LEN ? (Date.now() - room.fountainAt) / 1000 : null });
  broadcast(room, { t: "join", user: pub(u) }, ws);
  if (u.admin) broadcast(room, { t: "adminHere", on: true, nick: u.nick }, ws);
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
    } else if (m.t === "admin" && u.admin && (m.do === "fountain" || m.do === "meteor")) {
      // 운영자 버튼: 분수는 쉬는 시간 무시하고 바로, 유성우는 22초
      const now = Date.now();
      if (now - (u.lastAdmin || 0) < 3000) return;
      u.lastAdmin = now;
      if (m.do === "fountain") { room.fountainAt = now; broadcast(room, { t: "fountain" }); }
      else broadcast(room, { t: "meteor" });
    } else if (m.t === "lantern") {
      // 소원 풍등: 한 줄 소원(15자, 욕설·음란어는 글 없이 풍등만). 운영자가 방에 있으면 금빛
      const now = Date.now();
      if (!u.admin && now - (u.lastLantern || 0) < LANTERN_GAP) return;
      u.lastLantern = now;
      const w = !m.w ? "" : u.admin ? cleanNick(m.w, "free", 40) || "" : cleanNick(m.w, true, WISH_MAX) || "";
      broadcast(room, { t: "lantern", id: u.id, w, gold: adminHere(room) || undefined });
    } else if (m.t === "heart" && Number.isInteger(m.to) && m.to !== u.id && room.users.has(m.to)) {
      const now = Date.now();
      if (!u.admin && now - (u.lastHeart || 0) < HEART_GAP) return;
      u.lastHeart = now;
      broadcast(room, { t: "heart", from: u.id, to: m.to, e: EMOJIS.includes(m.e) ? m.e : undefined });
    } else if (m.t === "say" && u.admin && typeof m.text === "string") {
      // 말풍선은 운영자만 (제한 없음, 80자까지 화면에 맞게)
      const text = cleanNick(m.text, "free", 80); if (text) broadcast(room, { t: "say", id: u.id, text });
    } else if (m.t === "nick") {
      const now = Date.now();
      if (!u.admin && now - u.lastNick < NICK_GAP) return send(ws, { t: "nickbad", why: "wait" });
      const n = u.admin ? cleanNick(m.n, "free", 12) : cleanNick(m.n);
      if (!n) return send(ws, { t: "nickbad", why: n === false ? "bad" : "empty" });
      u.lastNick = now; u.nick = n;
      broadcast(room, { t: "nick", id: u.id, n });
    } else if (m.t === "fw" && typeof m.p === "number" && m.p >= 0 && m.p <= 1) {
      // 폭죽: 모양·색·씨앗은 서버가 정해서 모두의 화면에 같은 불꽃이 터지게 한다
      const now = Date.now();
      if (now - u.lastFw < (u.admin ? 1000 : FW_GAP)) return;
      u.lastFw = now;
      const r = n => Math.floor(Math.random() * n);
      if (now - room.fountainAt > FOUNTAIN_LEN + FOUNTAIN_GAP && Math.random() < FOUNTAIN_P) { room.fountainAt = now + 1600; setTimeout(() => broadcast(room, { t: "fountain" }), 1600); }   // 폭죽이 터질 즈음 켠다
      const x = typeof m.x === "number" && m.x >= 0 && m.x <= 1 ? Math.round(m.x * 1000) / 1000 : undefined;   // 조준한 가로 위치(화면 비율)
      broadcast(room, { t: "fw", id: u.id, p: Math.round(m.p * 100) / 100, x, k: r(FW_KINDS), h: r(FW_COLORS), h2: r(FW_COLORS), s: r(1e9), gold: u.admin || undefined });
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
    if (u.admin && !adminHere(room)) broadcast(room, { t: "adminHere", on: false });
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

// Render가 새 버전을 올리며 서버를 끌 때: 모두에게 알리고 닫는다. 페이지는 바로 다시 붙고 자리·행동·닉네임을 되찾는다
process.on("SIGTERM", () => {
  for (const r of rooms) broadcast(r, { t: "restart" });
  setTimeout(() => { for (const c of wss.clients) c.close(1012, "restart"); setTimeout(() => process.exit(0), 300); }, 200);
});
server.listen(PORT, () => console.log("listening on", PORT));
