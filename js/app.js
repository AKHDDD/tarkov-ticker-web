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

const API = "https://json.tarkov.dev/regular/items";  // 直连 REST，时间戳参数破 CDN 缓存
const REFRESH_MS = 5 * 60 * 1000;   // 全量约 16MB，每 5 分钟自动刷新
const STALE_TTL_MS = 30 * 60 * 1000; // 本地缓存最长容忍 30 分钟（拉取失败时降级用）
const CACHE_KEY = "tw_items_cache";  // 裁剪后行情缓存
const TOP_N = 30;                   // 热榜/套利展示条数
const LS_KEY = "tw_watchlist";      // 自选清单存储 key
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
    let va = normNum(get(a)), vb = normNum(get(b));
    if (st.abs) { va = Math.abs(va); vb = Math.abs(vb); }
    return st.dir === "desc" ? vb - va : va - vb;
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
  weapon: "武器", ammo: "弹药", armor: "护甲", gear: "装备", keys: "钥匙",
  medical: "医疗", food: "食物", drink: "饮品", stimulant: "药剂",
  backpack: "背包", rig: "胸挂", mods: "改装件", barter: "杂物",
  "common loot": "杂物", "quest item": "任务", provisions: "补给",
  special: "特殊", info: "信息", household: "家具"
}[t] || t);
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
// 单条裁剪：只保留渲染所需字段，并计算套利（最高商人收购价 − 跳蚤最低价，排除 Fence）
function toItem(it) {
  const price = Number(it.lastLowPrice) || 0;
  let best = 0;
  for (const s of (it.sellToTrader || [])) {
    const v = String(s.trader || "");
    if (v === FENCE_ID) continue; // 排除黑商 Fence
    const p = Number(s.priceRUB ?? s.price) || 0;
    if (p > best) best = p;
  }
  return {
    id: it.id,
    shortName: it.shortName || it.name || it.id,
    name: it.name || it.shortName || it.id,
    iconLink: it.iconLink || "",
    avg24hPrice: Number(it.avg24hPrice) || 0,
    low24hPrice: Number(it.low24hPrice) || 0,
    high24hPrice: Number(it.high24hPrice) || 0,
    lastLowPrice: price,
    changeLast48hPercent: it.changeLast48hPercent ?? 0,
    lastOfferCount: it.lastOfferCount ?? 0,
    types: it.types || [],
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
// 本地缓存读写（裁剪后体积小，远低于 localStorage 5MB 上限）
function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (!c || !Array.isArray(c.items) || c.items.length === 0) return null;
    return c;
  } catch (e) { return null; }
}
function writeCache(arr) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), items: arr }));
  } catch (e) { /* 存储满/禁用时忽略 */ }
}

// 拉取最新数据（返回 { items, stale }）；失败时若本地缓存未超容忍期则降级复用
async function fetchLatest() {
  const res = await fetch(API + "?v=" + Date.now(), { cache: "no-store" });
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
  const list = sortList(items.filter(i => watch.includes(i.shortName) || watch.includes(i.id)), WATCH_COLS, watchSort);
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
      <td>${esc(typeCn(i.types[0]))}</td>
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
  let list = items.filter(i => (i.lastLowPrice || 0) > 0);
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
      <td>${esc(typeCn(i.types[0]))}</td>
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
  const list = sortList(items.filter(i => i.profit > 0), ARB_COLS, arbSort).slice(0, TOP_N);
  if (list.length === 0) {
    body.innerHTML = '<tr><td colspan="5" class="empty">当前无正利润套利项</td></tr>';
    return;
  }
  body.innerHTML = list.map(i => `<tr>
    <td>${icon(i)}${esc(i.shortName)}</td>
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
    renderWatch(); renderHot(); renderArb();
    $("gameVersion").textContent = freshCache.length + " 件物品（缓存）";
    $("lastUpdate").textContent = now();
  }
  btn.disabled = true;
  btn.textContent = "同步中";
  try {
    const r = await fetchItems();
    markChanges();
    $("gameVersion").textContent = r.n + " 件物品" + (r.stale ? "（离线降级）" : "");
    $("lastUpdate").textContent = now();
    if (r.stale) console.warn("拉取失败，使用本地缓存:", r.err);
    renderWatch(); renderHot(); renderArb();
  } catch (e) {
    if (!freshCache) {
      $("gameVersion").textContent = "加载失败: " + e.message;
      console.error(e);
    }
  }
  btn.disabled = false;
  btn.textContent = "刷新";
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
