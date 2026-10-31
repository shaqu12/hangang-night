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
// ✈️ 하늘 비행기 바라는 점: 운영자에게 가는 의견. 메모리 + 파일 + 서버 로그 한 줄. Render 무료는 재시작·배포·잠들 때 디스크가 지워지므로
// 새 글은 접속 중인 운영자 폰으로 바로 보내 폰에 사본을 쌓고(편지함을 열 때마다 합침), 서버가 꺼질 때 남은 글을 로그에 한 번 더 남긴다
const FB_FILE = path.join(__dirname, "feedback.json");
let feedback = []; try { feedback = JSON.parse(fs.readFileSync(FB_FILE, "utf8")); } catch {}
const fbCount = new Map();   // IP 해시별 오늘 보낸 수 (rollDay 때 비움)
function saveFeedback(f) {
  f.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  feedback.push(f); if (feedback.length > 500) feedback.shift();
  fs.writeFile(FB_FILE, JSON.stringify(feedback), () => {});
  console.log("[바라는점] " + JSON.stringify(f));
  for (const r of rooms) for (const o of r.users.values()) if (o.admin) send(o.ws, { t: "letter", f, n: feedback.length });
}
const isAdminKey = k => ADMIN_KEY.length >= 8 && typeof k === "string" && k.length === ADMIN_KEY.length && require("crypto").timingSafeEqual(Buffer.from(k), Buffer.from(ADMIN_KEY));
const WISH_MAX = 15, LANTERN_GAP = 15000, HEART_GAP = 1500;   // 소원 풍선 글자 수·간격, 하트 간격
const FW_KINDS = 5, FW_COLORS = 7;   // index.html FW_SHAPES·FW_HUES 길이와 같아야 함

// "나에게 하고 싶은 말"은 서버로 오지 않고 폰 안에서만 거른다. 그래서 욕설·음란어 목록을 페이지에 끼워 준다.
// 마음 글에는 흔히 쓰는 말(사정·벗어나다·젖다·한남대교)과 위기 표현(죽고 싶다·자살 등, 상담 번호를 안내해야 함)은 막지 않는다
const MIND_OK = ["죽어", "뒤져", "자살", "미친", "미쳤", "장애", "병자", "꺼져", "닥쳐", "사정", "벗어", "젖", "한남"];
const MIND_BAD = BAD.filter(w => !MIND_OK.includes(w)), MIND_BAD_CHO = MIND_BAD.filter(w => /^[가-힣]{2,}$/.test(w)).map(toCho).concat(["ㅅㅂ", "ㅆㅂ", "ㅂㅅ", "ㅈㄴ", "ㅅㄲ", "ㅈㄹ", "ㅄ", "ㅈㅈ", "ㅂㅈ", "ㅅㅅ"]);
// 긴 글 거르기(index.html mindBad와 같은 방식): 낱말마다, 띄어 쓴 한 글자 낱말은 이어 붙여 비교
function badText(text) {
  const words = []; let run = "";
  for (const w of text.normalize("NFC").toLowerCase().split(/\s+/)) { if ([...w].length === 1) run += w; else { if (run) words.push(run); run = ""; words.push(w); } }
  if (run) words.push(run);
  const squash = x => x.replace(/[^a-z가-힣ㄱ-ㅎㅏ-ㅣ]/g, "").replace(/(.)\1+/g, "$1");
  return words.some(w => {
    const flats = [squash(w.replace(/[1!|]/g, "i").replace(/0/g, "o").replace(/3/g, "e").replace(/[4@]/g, "a").replace(/[5$]/g, "s").replace(/7/g, "t")), squash(w)];
    const cho = /[ㄱ-ㅎ]/.test(w) ? toCho(flats[1]).replace(/[^ㄱ-ㅎ]/g, "") : "";
    return flats.some(f => MIND_BAD.some(b => f.includes(b))) || (cho && MIND_BAD_CHO.some(b => cho.includes(b)));
  });
}
// 후원 주소(카카오페이 송금 링크 등): Render 환경 변수 DONATE_URL. https 주소만 받는다. 없으면 페이지에 "준비 중"
const DONATE_URL = /^https:\/\/[^\s"'<>\\]+$/.test(process.env.DONATE_URL || "") ? process.env.DONATE_URL : "https://qr.kakaopay.com/Ej7ooGTO1";   // 기본: 운영자 카카오페이 송금 링크
const page = fs.readFileSync(path.join(__dirname, "index.html"), "utf8").replace("/*HN_BAD*/[]", JSON.stringify(MIND_BAD)).replace("/*HN_BAD_CHO*/[]", JSON.stringify(MIND_BAD_CHO)).replace('/*HN_DONATE*/""', JSON.stringify(DONATE_URL));
const ogImage = fs.readFileSync(path.join(__dirname, "og.jpg"));
const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); return res.end("ok"); }
  if (req.url === "/admin/feedback") {
    if (!isAdminKey(req.headers["x-admin-key"])) { res.writeHead(403); return res.end("forbidden"); }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ items: feedback.slice().reverse() }));
  }
  if (req.url === "/stats") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ total: total(), rooms: rooms.map(r => r.users.size), today: summary(day), yesterday: prevDay && summary(prevDay), days: history, since: startedAt }, null, 1));
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
const startedAt = new Date().toISOString();   // 이 서버가 켜진 때(숫자는 이때부터 센다)
let day = newDay(), prevDay = null, history = [];   // history: 지난 날 요약(최근 7일, 메모리에만 — 재시작·배포 때 지워지고 Render 로그 [stats] 줄이 남는다)
function summary(d) {
  const s = [...d.secs].sort((a, b) => a - b), mid = s.length ? s[s.length >> 1] : 0;
  return { date: d.date, visits: d.visits, people: d.people.size, finished: s.length,
    avgMin: s.length ? +(s.reduce((a, b) => a + b, 0) / s.length / 60).toFixed(1) : 0, medianMin: +(mid / 60).toFixed(1),
    over5min: s.filter(x => x >= 300).length, peak: d.peak, sources: d.sources };
}
function rollDay() { if (day.date !== kstDate()) { fbCount.clear(); const sm = summary(day); console.log("[stats] " + JSON.stringify(sm)); history.unshift(sm); history = history.slice(0, 7); prevDay = day; day = newDay(); } }
setInterval(() => { rollDay(); console.log("[stats-now] " + JSON.stringify(summary(day))); }, 3600e3);   // 한 시간마다 지금까지 숫자를 로그에 남겨 둔다
setInterval(() => { rollDay(); if (new Date().getMinutes() === 0) console.log("[stats] " + JSON.stringify(summary(day))); }, 60000);
const ipKey = ip => require("crypto").createHash("sha256").update(ip + day.date).digest("hex").slice(0, 12);  // IP는 저장하지 않고 하루짜리 해시만

const rooms = [];            // [{ no, users: Map<id, user> }]
const ips = new Map();
let nextId = 1;
// 고민 풍선(함께 나누기): 쓴 사람이 고를 때만, 이름 없이 같은 방 하늘에 60초 떠 있다. 메모리에만 두고 저장·로그 없음.
// 다른 사람은 정해진 공감 4가지만 보낼 수 있다(자유 댓글 없음). 공감 하나마다 10초 더, 최대 2분
const WORRY_LEN = 60000, WORRY_MAX = 120000, CHEERS = 4;
const CRISIS = /죽고\s*싶|죽을\s*것\s*같|죽어\s*버리|자살|사라지고\s*싶|없어지고\s*싶|살기\s*싫|살고\s*싶지\s*않|그만\s*살|끝내고\s*싶|목숨|뛰어\s*내리|자해|손목/;
let nextWorry = 1;
const pubWorry = (w, now) => ({ id: w.id, text: w.text, left: w.until - now, cheers: w.cheers });
const liveWorries = room => { const now = Date.now(); room.worries = room.worries.filter(w => w.until > now); return room.worries; };
const total = () => rooms.reduce((n, r) => n + r.users.size, 0);

function pickRoom() {
  let r = rooms.find(r => r.users.size < CAP);
  if (!r && rooms.length < MAX_ROOMS) { r = { no: rooms.length + 1, users: new Map(), fountainAt: 0, worries: [] }; rooms.push(r); }
  return r;
}
const adminHere = room => [...room.users.values()].some(o => o.admin);
const pub = u => ({ id: u.id, seat: u.seat, color: u.color, act: u.act, nick: u.nick, g: u.g, admin: u.admin || undefined });
function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room, msg, except) {
  const s = JSON.stringify(msg);
  for (const u of room.users.values()) if (u.ws !== except && u.ws.readyState === 1) u.ws.send(s);
}
function sendCounts() {
  const t = total();
  for (const r of rooms) broadcast(r, { t: "count", room: r.users.size, total: t });
}

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 8192 });   // 운영자 긴 글 때문에 넉넉히, 일반 사용자는 아래에서 256바이트로 자른다
// 운영자 글(말풍선·공지)은 길이 제한 없이(안전상 2000자), 줄바꿈은 살리고 제어 문자만 뺀다
const ADMIN_TEXT_MAX = 2000;
const freeText = raw => typeof raw !== "string" ? "" : [...raw.normalize("NFC").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, "").replace(/\n{3,}/g, "\n\n")].slice(0, ADMIN_TEXT_MAX).join("").trim();
let lastNotice = null;   // 운영자 공지: 메모리에만, 10분 동안 새로 들어온 사람에게도 보여 준다
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
  u.g = (/[?&]g=([mf])(?:&|$)/.exec(req.url) || [])[1];   // 캐릭터 성별(남 m·여 f, 없으면 선택 안 함)
  u.nick = (u.admin ? cleanNick(asked, "free", 12) : cleanNick(asked)) || randNick();   // 운영자 닉네임은 12자까지, 거르지 않음
  room.users.set(u.id, u);
  ws.alive = true;
  send(ws, { t: "init", you: u.id, admin: u.admin, letters: u.admin ? feedback.length : undefined, notice: lastNotice && Date.now() - lastNotice.at < 600000 ? lastNotice.text : undefined, adminHere: adminHere(room) || u.admin, room: room.no, cap: CAP, emojis: EMOJIS, users: [...room.users.values()].map(pub), worries: liveWorries(room).map(w => pubWorry(w, Date.now())), fountain: Date.now() - room.fountainAt < FOUNTAIN_LEN ? (Date.now() - room.fountainAt) / 1000 : null });
  broadcast(room, { t: "join", user: pub(u) }, ws);
  if (u.admin) broadcast(room, { t: "adminHere", on: true, nick: u.nick }, ws);
  sendCounts();
  day.peak = Math.max(day.peak, total());

  ws.on("pong", () => { ws.alive = true; });
  ws.on("message", raw => {
    if (!u.admin && raw.length > 256) return;
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
      // 소원 풍선: 한 줄 소원(15자, 욕설·음란어는 글 없이 풍선만). 운영자가 방에 있으면 금빛
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
      // 말풍선은 운영자만 (길이 제한 없음, 길면 말풍선이 여러 쪽으로 넘어간다)
      const text = freeText(m.text); if (text) broadcast(room, { t: "say", id: u.id, text });
    } else if (m.t === "notice" && u.admin && typeof m.text === "string") {
      // 운영자 공지: 모든 방 모든 사람 화면 위에 배너. 빈 글이면 공지를 내린다
      const text = freeText(m.text); lastNotice = text ? { text, at: Date.now() } : null;
      for (const r of rooms) broadcast(r, { t: "notice", text });
    } else if (m.t === "feedback" && typeof m.text === "string") {
      // 바라는 점(하늘 비행기): 누구나 300자까지, 1분에 하나·IP당 하루 5개, 욕설·음란어는 돌려보냄. 운영자만 게임 안 편지함에서 본다
      const now = Date.now(), k = ipKey(ip), used = fbCount.get(k) || 0;
      if (!u.admin && (now - (u.lastFb || 0) < 60000 || used >= 5)) return send(ws, { t: "feedbackBad", why: "wait" });
      const text = [...m.text.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim()].slice(0, 300).join("");
      if (!text) return send(ws, { t: "feedbackBad", why: "empty" });
      if (badText(text)) return send(ws, { t: "feedbackBad", why: "bad" });
      u.lastFb = now; fbCount.set(k, used + 1);
      saveFeedback({ at: new Date().toISOString(), nick: u.nick, room: room.no, text });
      send(ws, { t: "feedbackOk" });
    } else if (m.t === "worry" && typeof m.text === "string") {
      const now = Date.now();
      if (!u.admin && now - (u.lastWorry || 0) < 180000) return send(ws, { t: "worryBad", why: "wait" });
      const text = [...m.text.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim()].slice(0, 120).join("");
      if (!text) return send(ws, { t: "worryBad", why: "empty" });
      if (badText(text)) return send(ws, { t: "worryBad", why: "bad" });
      if (CRISIS.test(text)) return send(ws, { t: "worryBad", why: "crisis" });
      u.lastWorry = now;
      const list = liveWorries(room); if (list.length >= 6) list.shift();
      const w = { id: nextWorry++, text, until: now + WORRY_LEN, at: now, cheers: Array(CHEERS).fill(0), by: new Set(), owner: u.id };
      list.push(w);
      for (const o of room.users.values()) send(o.ws, { t: "worry", w: pubWorry(w, now), mine: o.id === u.id || undefined });
    } else if (m.t === "cheer" && Number.isInteger(m.w) && Number.isInteger(m.k) && m.k >= 0 && m.k < CHEERS) {
      const now = Date.now(), w = liveWorries(room).find(x => x.id === m.w);
      if (!w || w.owner === u.id || w.by.has(u.id) || now - (u.lastCheer || 0) < 1500) return;
      u.lastCheer = now; w.by.add(u.id); w.cheers[m.k]++; w.until = Math.min(w.at + WORRY_MAX, w.until + 10000);
      broadcast(room, { t: "cheer", w: w.id, k: m.k, left: w.until - now });
    } else if (m.t === "star" && typeof m.x === "number" && typeof m.y === "number" && m.x >= 0 && m.x <= 1 && m.y >= 0 && m.y <= 1) {
      // 별똥별 신호: 하늘을 누르면 같은 방 모두에게 그 자리에서 별똥별이 떨어진다. 10초에 한 번
      const now = Date.now(); if (now - (u.lastStar || 0) < 10000) return; u.lastStar = now;
      broadcast(room, { t: "star", id: u.id, x: Math.round(m.x * 1000) / 1000, y: Math.round(m.y * 1000) / 1000, d: Math.random() < .5 ? -1 : 1 });
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
  console.log("[stats 보관] " + JSON.stringify(summary(day)));                           // 배포로 꺼지기 직전 오늘 숫자
  for (const f of feedback) console.log("[바라는점 보관] " + JSON.stringify(f));        // 디스크가 지워지기 전에 로그에 한 번 더
  for (const r of rooms) broadcast(r, { t: "restart" });
  setTimeout(() => { for (const c of wss.clients) c.close(1012, "restart"); setTimeout(() => process.exit(0), 300); }, 200);
});
server.listen(PORT, () => console.log("listening on", PORT));
