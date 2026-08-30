/* ============================================================
   塔科夫跳蚤行情 - 前端逻辑
   数据源: 前端直连 json.tarkov.dev REST（无需自建后端）
   说明: ① REST 全量接口被 CDN 锁死 8 天缓存，用时间戳参数
        (?v=<ts>) 绕过，实测可拿到实时数据（当天 updated）；
        ② 全量响应约 16MB，故自动刷新间隔加大到 5 分钟；
        ③ 首次同步后裁剪字段写入 localStorage，二次打开秒出数据，
           后台再静默拉新；拉取失败降级用本地缓存（stale-while-error）；
        ④ 套利用 REST 的 sellToTrader（商人收购价）计算，排除黑商 Fence。
   ============================================================ */

const API_BASE = "https://json.tarkov.dev"; // REST 直连根地址，路径按服务器区分
const GAME_MODES = {           // 三服（tarkov.dev 的 gameMode 路径段）
  "regular":    "PvP永久服",
  "pve":        "PvE服",
  "pvp-season": "PvP赛季服"
};
let gameMode = "regular";      // 当前服务器，切换后重新拉取对应行情
const apiUrl = () => `${API_BASE}/${gameMode}/items`; // 直连 REST，时间戳参数破 CDN 缓存
const REFRESH_MS = 5 * 60 * 1000;   // 全量约 16MB，每 5 分钟自动刷新
const STALE_TTL_MS = 30 * 60 * 1000; // 本地缓存最长容忍 30 分钟（拉取失败时降级用）
const CACHE_KEY = () => "tw_items_cache_v3_" + gameMode; // 裁剪后行情缓存（v3：游戏内 Handbook 分类；_<服>：三服各自独立缓存）
const TOP_N = 30;                   // 热榜/套利展示条数
const LS_KEY = "tw_watchlist_v2";   // 自选清单存储 key（v2：旧 v1 存的是占位符乱码名，弃用）
const FENCE_ID = "579dc571d53a0658a154fbec"; // 黑商 Fence 的 tarkov.dev trader id（套利排除）

let items = [];
let watch = [];
try { watch = JSON.parse(localStorage.getItem(LS_KEY) || "[]"); } catch (e) { watch = []; }

/* ---- 通用表头排序 ----
   cols: { key: { get: item => 数值, absFirst?: 该列首次点击先按绝对值（如涨跌） } }
   每个表格独立的 sort state：{ key, dir, abs } */
const normNum = n => (n == null || isNaN(n)) ? 0 : Number(n);
function sortList(list, cols, st) {
  if (!st.key) return list.slice();
  const get = cols[st.key].get;
  return list.slice().sort((a, b) => {
    const va = get(a), vb = get(b);
    // 字符串列（如物品类型）按文本排序
    if (typeof va === "string" || typeof vb === "string") {
      const sa = String(va == null ? "" : va), sb = String(vb == null ? "" : vb);
      return st.dir === "desc" ? sb.localeCompare(sa, "zh") : sa.localeCompare(sb, "zh");
    }
    let na = normNum(va), nb = normNum(vb);
    if (st.abs) { na = Math.abs(na); nb = Math.abs(nb); }
    return st.dir === "desc" ? nb - na : na - nb;
  });
}
function paintSort(panelSel, st) {
  document.querySelectorAll(panelSel + " th[data-sort]").forEach(th => {
    th.classList.remove("s-active", "s-asc", "s-desc");
    if (st.key && th.dataset.sort === st.key)
      th.classList.add("s-active", st.dir === "desc" ? "s-desc" : "s-asc");
  });
}
function bindSort(panelSel, cols, st, rerender) {
  document.querySelectorAll(panelSel + " th[data-sort]").forEach(th => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      const absFirst = !!(cols[key] && cols[key].absFirst);
      if (st.key === key) {
        if (absFirst && st.abs) { st.abs = false; st.dir = "desc"; } // 绝对值 -> 真实值
        else { st.dir = st.dir === "desc" ? "asc" : "desc"; st.abs = false; }
      } else {
        st.key = key; st.dir = "desc"; st.abs = absFirst;
      }
      rerender();
    });
  });
}

/* 热榜：默认按 48h 涨跌绝对波动降序 */
let hotSort = { key: "chg", dir: "desc", abs: true };
const HOT_COLS = {
  type:   { get: i => gameCat(i) },
  avg:    { get: i => i.avg24hPrice },
  low:    { get: i => i.low24hPrice },
  high:   { get: i => i.high24hPrice },
  price:  { get: i => i.lastLowPrice },
  chg:    { get: i => i.changeLast48hPercent, absFirst: true },
  offers: { get: i => i.lastOfferCount }
};

/* 自选：默认保持加入顺序，点击表头后排序 */
let watchSort = { key: null, dir: "desc", abs: false };
const WATCH_COLS = {
  type:   { get: i => gameCat(i) },
  avg:    { get: i => i.avg24hPrice },
  low:    { get: i => i.low24hPrice },
  high:   { get: i => i.high24hPrice },
  price:  { get: i => i.lastLowPrice },
  chg:    { get: i => i.changeLast48hPercent, absFirst: true },
  offers: { get: i => i.lastOfferCount }
};

/* 套利：默认按单件利润降序 */
let arbSort = { key: "profit", dir: "desc", abs: false };
const ARB_COLS = {
  type:   { get: i => gameCat(i) },
  price:  { get: i => i.lastLowPrice },
  trader: { get: i => i.bestTrader },
  profit: { get: i => i.profit, absFirst: true },
  offers: { get: i => i.lastOfferCount }
};

/* ---- 价格变动标记（刷新时对比上一次，实现"跳动"反馈） ---- */
let prevPrice = {};   // shortName -> 上一次的当前最低价 lastLowPrice
function markChanges() {
  const cur = {};
  items.forEach(i => { cur[i.shortName] = i.lastLowPrice || 0; });
  items.forEach(i => {
    const p = prevPrice[i.shortName];
    const n = cur[i.shortName];
    i._chg = (p != null && p > 0 && n > 0 && p !== n) ? (n > p ? "up" : "down") : "";
  });
  prevPrice = cur;
}

/* ---- 工具函数 ---- */
const $ = id => document.getElementById(id);
const fmt = n => (n == null || n <= 0) ? "-" : Number(n).toLocaleString("en-US");
const pct = n => (n == null) ? "-" : (n > 0 ? "+" : "") + Number(n).toFixed(1) + "%";
const cls = n => (n == null || n === 0) ? "" : (n > 0 ? "up" : "down");
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const typeCn = t => ({
  weapon: "武器", gun: "武器", ammo: "弹药", ammoBox: "弹药", armor: "护甲",
  armorPlate: "护甲", gear: "装备", keys: "钥匙", medical: "医疗", meds: "医疗",
  food: "食物", drink: "饮品", stimulant: "药剂", injectors: "注射器",
  backpack: "背包", rig: "胸挂", mods: "改装件", barter: "杂物",
  "common loot": "杂物", "quest item": "任务", provisions: "补给",
  special: "特殊", info: "信息", household: "家具",
  container: "容器", glasses: "护目镜", grenade: "手雷", headphones: "耳机",
  helmet: "头盔", noFlea: "禁售", poster: "海报", preset: "预设",
  specialSlot: "特殊槽", wearable: "穿戴品"
}[t] || t);

/* ---- 游戏内 Handbook 顶级分类（物品按游戏内分类归属） ----
   tarkov.dev 每条物品带 handbookCategories 数组，其末位即游戏内
   Handbook 顶级大类 ID（对应游戏内物品栏的 10 大类，见游戏内截图），
   用该 ID 映射中文名即可实现"游戏内分类"筛选。 */
const HANDBOOK_TOP_CN = {
  "5b5f71a686f77447ed5636ab": "武器零件&配件", // Weapon parts & mods
  "5b47574386f77428ca22b33f": "装备",          // Gear
  "5b5f78dc86f77409407a7f8e": "武器",          // Weapons
  "5b47574386f77428ca22b346": "弹药",          // Ammo
  "5b47574386f77428ca22b33e": "交换用物品",    // Barter items
  "5b47574386f77428ca22b342": "钥匙",          // Keys
  "5b47574386f77428ca22b341": "情报物品",      // Info items
  "5b47574386f77428ca22b340": "饮食",          // Provisions
  "5b47574386f77428ca22b344": "医疗物品",      // Medication
  "5b47574386f77428ca22b345": "特殊装备",      // Special equipment
  "5b619f1a86f77450a702a6f3": "任务物品",      // Task items
  "6a35427afc3f27b15905a876": "通行证文档",    // Battle Pass documents
  "5b47574386f77428ca22b343": "地图",          // Maps
  "5b5f78b786f77447ed5636af": "货币",          // Money
  "5b5f750686f774093e6cb503": "装备改装件",    // Gear mods
  "5b5f736886f774094242f193": "照明与激光",    // Light & laser devices
};
// 物品 → 游戏内大类中文名（handbook 末位；无 handbook 时回退 typeCn 兜底）
function gameCat(i) {
  const hb = i.handbookCategories || [];
  const topId = hb.length ? hb[hb.length - 1] : "";
  const cn = HANDBOOK_TOP_CN[topId];
  if (cn) return cn;
  return typeCn((i.types && i.types[0]) || "") || "其他";
}

/* ---- 游戏内分类筛选：从数据中收集大类下拉，选中后三表按分类过滤 ---- */
let typeFilter = "";  // 当前选中的游戏内大类（中文名），空 = 全部
// 按游戏内 Handbook 顺序优先排序，其余按拼音
const TYPE_ORDER = ["交换用物品", "装备", "武器零件&配件", "武器", "弹药",
  "饮食", "医疗物品", "钥匙", "情报物品", "特殊装备", "任务物品",
  "通行证文档", "地图", "货币", "装备改装件", "照明与激光", "其他"];
function collectTypes() {
  const set = new Set();
  items.forEach(i => {
    const t = gameCat(i);
    if (t) set.add(t);
  });
  const opts = [...set].sort((a, b) => {
    const ia = TYPE_ORDER.indexOf(a), ib = TYPE_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b, "zh");
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  const sel = $("typeFilter");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">全部类型</option>' +
    opts.map(t => `<option value="${esc(t)}">${t}</option>`).join("");
  if (opts.includes(prev)) sel.value = prev; else sel.value = "";
  typeFilter = sel.value;
}
function matchType(i) {
  if (!typeFilter) return true;
  return gameCat(i) === typeFilter;
}
const now = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });

/* ---- 物品图标 / 高点预警 ---- */
const icon = i => i.iconLink
  ? `<img class="ico" src="${esc(i.iconLink)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
  : '<span class="ico ico-empty"></span>';
// 高点预警：当前最低挂牌价 lastLowPrice 达到/接近 24h 高点 high24hPrice
const alertState = i => {
  const low = i.lastLowPrice || 0, high = i.high24hPrice || 0;
  if (low <= 0 || high <= 0) return null;
  if (low >= high) return "high";        // 已达 24h 高点
  if (low >= high * 0.9) return "near";  // 接近 24h 高点（90% 阈值）
  return null;
};
const alertBadge = st => st === "high" ? '<span class="badge b-high">▲高点</span>'
  : st === "near" ? '<span class="badge b-near">▲近高</span>' : "";
const alertCls = st => st === "high" ? "alert-high" : st === "near" ? "alert-near" : "";

/* ---- 数据拉取：前端直连 REST（时间戳破 CDN 缓存）+ 本地缓存降级 ---- */
// REST 对 name/shortName 脱敏为 "{id} Name/ShortName" 占位符，
// 用 wikiLink（真实英文名）或 normalizedName（slug）还原可读物品名
function realName(it) {
  const w = it.wikiLink || "";
  const m = w.match(/\/wiki\/([^/?#]+)/);
  if (m) {
    try {
      const nm = decodeURIComponent(m[1]).replace(/_/g, " ").trim();
      if (nm && nm !== it.id && !/ (?:Name|ShortName)$/.test(nm)) return nm;
    } catch (e) { /* ignore */ }
  }
  const s = (it.normalizedName || "").replace(/-/g, " ").trim();
  return (s && s !== it.id) ? s : "";
}
const isPh = s => /^[0-9a-f]{24} (?:Name|ShortName)$/.test(String(s || ""));
// 单条裁剪：只保留渲染所需字段，并计算套利（最高商人收购价 − 跳蚤最低价，排除 Fence）
function toItem(it) {
  const price = Number(it.lastLowPrice) || 0;
  // 涨跌失真保护：48h 前基价 ≤0（含负值，数据异常）或涨跌超过 ±1000% 时，
  // 该百分比视为不可信（显示 "-"，且不参与热榜 chg 排序）
  let chgPct = it.changeLast48hPercent ?? 0;
  const chgAbs = Number(it.changeLast48h) || 0;
  if (chgAbs !== 0 && (price - chgAbs <= 0 || Math.abs(chgPct) > 1000)) chgPct = null;
  // 冷门样本坍缩保护：在售挂单 ≤1 且 24h 四价完全相同（统计坍缩为单一挂单价）时，
  // 涨跌百分比是单点噪声、无统计意义，同样视为不可信显示 "-"
  if (chgPct != null && (it.lastOfferCount ?? 0) <= 1) {
    const vals = [Number(it.avg24hPrice) || 0, Number(it.low24hPrice) || 0, Number(it.high24hPrice) || 0, price];
    const present = vals.filter(v => v > 0);
    if (present.length > 0 && new Set(present).size === 1) chgPct = null;
  }
  let best = 0;
  for (const s of (it.sellToTrader || [])) {
    const v = String(s.trader || "");
    if (v === FENCE_ID) continue; // 排除黑商 Fence
    const p = Number(s.priceRUB ?? s.price) || 0;
    if (p > best) best = p;
  }
  // 名字还原：上游脱敏成占位符时用真实物品名替换
  let shortName = it.shortName || it.name || it.id;
  let name = it.name || it.shortName || it.id;
  if (isPh(name) || isPh(shortName)) {
    const rn = realName(it);
    if (rn) { shortName = rn; name = rn; }
  }
  return {
    id: it.id,
    shortName,
    name,
    iconLink: it.iconLink || "",
    avg24hPrice: Number(it.avg24hPrice) || 0,
    low24hPrice: Number(it.low24hPrice) || 0,
    high24hPrice: Number(it.high24hPrice) || 0,
    lastLowPrice: price,
    changeLast48hPercent: chgPct,
    lastOfferCount: it.lastOfferCount ?? 0,
    types: it.types || [],
    handbookCategories: it.handbookCategories || [],
    bestTrader: best,
    traderName: "",
    profit: price > 0 ? best - price : 0,
    updated: it.updated || null,
  };
}
// REST 全量字典 → 裁剪数组
function fromDict(dict) {
  return Object.keys(dict || {}).map(id => toItem(dict[id]));
}
// 本地缓存读写（裁剪后体积小，远低于 localStorage 5MB 上限；按服隔离）
function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY());
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (!c || !Array.isArray(c.items) || c.items.length === 0) return null;
    return c;
  } catch (e) { return null; }
}
function writeCache(arr) {
  try {
    localStorage.setItem(CACHE_KEY(), JSON.stringify({ ts: Date.now(), items: arr }));
  } catch (e) { /* 存储满/禁用时忽略 */ }
}

// 拉取最新数据（返回 { items, stale }）；失败时若本地缓存未超容忍期则降级复用
async function fetchLatest() {
  const res = await fetch(apiUrl() + "?v=" + Date.now(), { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const j = await res.json();
  const dict = (j && j.data && j.data.items) || null;
  if (!dict) throw new Error("上游数据格式异常");
  const arr = fromDict(dict);
  writeCache(arr);
  return { items: arr, stale: false };
}

async function fetchItems() {
  const cached = readCache();
  const fresh = (cached && Date.now() - cached.ts < STALE_TTL_MS) ? cached.items : null;
  try {
    const freshData = await fetchLatest();
    items = freshData.items;
    return { n: items.length, stale: false };
  } catch (e) {
    if (fresh) { items = fresh; return { n: items.length, stale: true, err: e.message }; }
    throw e;
  }
}

/* ---- 渲染：自选 ---- */
function renderWatch() {
  const body = $("watchBody");
  const list = sortList(items.filter(i => (watch.includes(i.shortName) || watch.includes(i.id)) && matchType(i)), WATCH_COLS, watchSort);
  if (list.length === 0) {
    body.innerHTML = '<tr><td colspan="9" class="empty">自选为空 — 搜索物品名加入</td></tr>';
    updateAlert();
    return;
  }
  body.innerHTML = list.map(i => {
    const c = i.changeLast48hPercent;
    const st = alertState(i);
    return `<tr class="${alertCls(st)}">
      <td>${icon(i)}${esc(i.shortName)} ${alertBadge(st)}</td>
      <td>${esc(gameCat(i))}</td>
      <td>${fmt(i.avg24hPrice)}</td>
      <td>${fmt(i.low24hPrice)}</td>
      <td>${fmt(i.high24hPrice)}</td>
      <td class="${i._chg ? "f-" + i._chg : ""}">${fmt(i.lastLowPrice)}</td>
      <td class="${cls(c)}">${pct(c)}</td>
      <td>${fmt(i.lastOfferCount)}</td>
      <td><button class="del" data-rm="${esc(i.shortName)}">✕</button></td>
    </tr>`;
  }).join("");
  paintSort("#panel-watch", watchSort);
  updateAlert();
}

/* 自选高点预警汇总（顶部状态条） */
function updateAlert() {
  const el = $("alertBadge");
  const list = items.filter(i => watch.includes(i.shortName) || watch.includes(i.id));
  const alerts = list.filter(i => alertState(i));
  if (alerts.length === 0) { el.style.display = "none"; return; }
  const high = alerts.filter(i => alertState(i) === "high").length;
  el.textContent = `▲ 自选 ${alerts.length} 件接近/已达 24h 高点（其中 ${high} 件已到高点）`;
  el.style.display = "inline-block";
}

/* ---- 渲染：热榜（表头可排序，默认按 48h 绝对波动） ---- */
function renderHot() {
  const body = $("hotBody");
  let list = items.filter(i => (i.lastLowPrice || 0) > 0 && matchType(i));
  // "涨跌 48h"列保留无涨跌数据不进入列表（维持原热榜口径）
  if (hotSort.key === "chg") list = list.filter(i => i.changeLast48hPercent != null);
  list = sortList(list, HOT_COLS, hotSort).slice(0, TOP_N);
  if (list.length === 0) {
    body.innerHTML = '<tr><td colspan="8" class="empty">暂无数据</td></tr>';
    return;
  }
  body.innerHTML = list.map(i => {
    const c = i.changeLast48hPercent;
    const inWatch = watch.includes(i.shortName);
    return `<tr>
      <td>${icon(i)}${esc(i.shortName)} <button class="addsel" data-add="${esc(i.shortName)}" ${inWatch ? "disabled" : ""}>${inWatch ? "✓" : "＋"}</button></td>
      <td>${esc(gameCat(i))}</td>
      <td>${fmt(i.avg24hPrice)}</td>
      <td>${fmt(i.low24hPrice)}</td>
      <td>${fmt(i.high24hPrice)}</td>
      <td class="${i._chg ? "f-" + i._chg : ""}">${fmt(i.lastLowPrice)}</td>
      <td class="${cls(c)}">${pct(c)}</td>
      <td>${fmt(i.lastOfferCount)}</td>
    </tr>`;
  }).join("");
  paintSort("#panel-hot", hotSort);
}

/* ---- 渲染：套利（商人价 − 跳蚤最低价） ---- */
function renderArb() {
  const body = $("arbBody");
  const list = sortList(items.filter(i => i.profit > 0 && matchType(i)), ARB_COLS, arbSort).slice(0, TOP_N);
  if (list.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="empty">当前无正利润套利项</td></tr>';
    return;
  }
  body.innerHTML = list.map(i => `<tr>
    <td>${icon(i)}${esc(i.shortName)}</td>
    <td>${esc(gameCat(i))}</td>
    <td>${fmt(i.lastLowPrice)}</td>
    <td>${fmt(i.bestTrader)}</td>
    <td class="profit-pos">+${fmt(i.profit)}</td>
    <td>${fmt(i.lastOfferCount)}</td>
  </tr>`).join("");
  paintSort("#panel-arb", arbSort);
}

/* ---- 搜索 + 加入自选 ---- */
function addToWatch() {
  const q = $("searchInput").value.trim().toLowerCase();
  if (!q) return;
  const hit = items.find(i =>
    i.shortName.toLowerCase() === q ||
    (i.name && i.name.toLowerCase() === q) ||
    (i.name && i.name.toLowerCase().includes(q)) ||
    i.shortName.toLowerCase().includes(q)
  );
  if (!hit) { $("watchHint").textContent = "未找到该物品"; return; }
  const key = hit.shortName;
  if (!watch.includes(key)) watch.push(key);
  localStorage.setItem(LS_KEY, JSON.stringify(watch));
  $("watchHint").textContent = "已加入: " + hit.shortName;
  $("searchInput").value = "";
  renderWatch();
}

/* ---- 刷新流程 ---- */
async function load() {
  const btn = $("btnRefresh");
  // 已有本地缓存且当前无数据 → 先秒出缓存，再后台拉新
  const cached = readCache();
  const freshCache = (cached && Date.now() - cached.ts < STALE_TTL_MS) ? cached.items : null;
  if (freshCache && items.length === 0) {
    items = freshCache;
    markChanges();
    renderWatch(); renderHot(); renderArb(); collectTypes();
    $("gameVersion").textContent = GAME_MODES[gameMode] + " · " + freshCache.length + " 件物品（缓存）";
    $("lastUpdate").textContent = now();
  }
  btn.disabled = true;
  btn.textContent = "同步中";
  try {
    const r = await fetchItems();
    markChanges();
    $("gameVersion").textContent = GAME_MODES[gameMode] + " · " + r.n + " 件物品" + (r.stale ? "（离线降级）" : "");
    $("lastUpdate").textContent = now();
    if (r.stale) console.warn("拉取失败，使用本地缓存:", r.err);
    renderWatch(); renderHot(); renderArb(); collectTypes();
  } catch (e) {
    if (!freshCache) {
      $("gameVersion").textContent = GAME_MODES[gameMode] + " 加载失败: " + e.message;
      console.error(e);
    }
  }
  btn.disabled = false;
  btn.textContent = "刷新";
}

/* ---- 服务器切换：清空旧服数据，重新拉取当前服行情 ---- */
function setGameMode(mode) {
  if (mode === gameMode) return;
  gameMode = mode;
  items = [];       // 清空旧服数据，防止跨服串数据
  prevPrice = {};   // 重置价格变动对比，避免跨服误报跳动
  $("gameVersion").textContent = GAME_MODES[gameMode] + " · 切换中...";
  renderWatch(); renderHot(); renderArb();
  load();           // 重新拉取当前服（有该服缓存则秒出）
}

/* ---- Tab 切换 ---- */
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    $("panel-" + tab.dataset.tab).classList.add("active");
  });
});

/* ---- 事件绑定 ---- */
$("btnRefresh").addEventListener("click", load);
$("btnAdd").addEventListener("click", addToWatch);
$("searchInput").addEventListener("keydown", e => { if (e.key === "Enter") addToWatch(); });
/* 服务器切换：三服按钮组 */
document.querySelectorAll(".mode-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    if (btn.dataset.mode === gameMode) return;
    document.querySelectorAll(".mode-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    setGameMode(btn.dataset.mode);
  });
});
/* 类型筛选：选中后三表按类型过滤 */
$("typeFilter").addEventListener("change", e => {
  typeFilter = e.target.value;
  renderWatch(); renderHot(); renderArb();
});
document.addEventListener("click", e => {
  if (e.target.classList && e.target.classList.contains("del")) {
    const key = e.target.dataset.rm;
    watch = watch.filter(w => w !== key);
    localStorage.setItem(LS_KEY, JSON.stringify(watch));
    renderWatch();
  }
});
/* 热榜等列表一键加入自选 */
document.addEventListener("click", e => {
  if (e.target.classList && e.target.classList.contains("addsel")) {
    const key = e.target.dataset.add;
    if (!watch.includes(key)) {
      watch.push(key);
      localStorage.setItem(LS_KEY, JSON.stringify(watch));
      renderWatch();
      renderHot();
      updateAlert();
    }
  }
});

/* ---- 启动 ---- */
bindSort("#panel-watch", WATCH_COLS, watchSort, renderWatch);
bindSort("#panel-hot", HOT_COLS, hotSort, renderHot);
bindSort("#panel-arb", ARB_COLS, arbSort, renderArb);
load();
setInterval(load, REFRESH_MS);
