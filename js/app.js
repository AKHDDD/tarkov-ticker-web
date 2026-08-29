/* ============================================================
   塔科夫跳蚤行情 - 前端逻辑
   数据源: tarkov.dev 社区公开 REST API（免费，无 key，CORS 全开）
   主数据 + 英文翻译表并行拉取，浏览器本地合并本地化
   注: GraphQL 端点当前故障（返回 unavailable），已切换 REST；
       请求 cache: no-cache 每次重新验证，服务端更新即拿新数据
   ============================================================ */

const API = "https://json.tarkov.dev/regular/items";          // REST 主数据（gzip/br 压缩后约 1.3MB）
const TRANS_API = "https://json.tarkov.dev/regular/items_en"; // 英文翻译表（本地化物品名）
const FENCE_ID = "579dc571d53a0658a154fbec";                  // 黑商 Fence 的 trader ID（套利时排除）
const REFRESH_MS = 5 * 60 * 1000;   // 默认 5 分钟自动刷新
const TOP_N = 30;                   // 热榜/套利展示条数
const LS_KEY = "tw_watchlist";      // 自选清单存储 key

let items = [];
let watch = [];
try { watch = JSON.parse(localStorage.getItem(LS_KEY) || "[]"); } catch (e) { watch = []; }

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

/* ---- 数据拉取 ---- */
async function fetchItems() {
  // REST：主数据 + 翻译表并行拉取（服务端 CORS 已全开，浏览器自动解压 gzip/br）
  const [mainRes, transRes] = await Promise.all([
    fetch(API, { cache: "no-cache" }),
    fetch(TRANS_API, { cache: "no-cache" })
  ]);
  if (!mainRes.ok) throw new Error("HTTP " + mainRes.status);
  const main = await mainRes.json();
  const trans = transRes.ok ? await transRes.json() : { data: {} };
  const dict = (main.data && main.data.items) || {};
  const t = trans.data || {};
  // REST 返回的 name/shortName 是占位符（"<id> Name"），用翻译表映射真实英文名
  items = Object.values(dict).map(it => {
    const name = t[it.name] || it.name;
    const shortName = t[it.shortName] || it.shortName;
    // 套利：商人最高收购价 − 跳蚤最低价（排除黑商 Fence）
    let bestTrader = 0;
    (it.sellToTrader || []).forEach(s => {
      if (s.trader === FENCE_ID) return;
      if ((s.priceRUB || 0) > bestTrader) bestTrader = s.priceRUB;
    });
    const lastLow = it.lastLowPrice || 0;
    return {
      ...it,
      name,
      shortName,
      types: it.types || [],
      bestTrader,
      profit: lastLow > 0 ? bestTrader - lastLow : 0
    };
  });
  return items.length;
}

/* ---- 渲染：自选 ---- */
function renderWatch() {
  const body = $("watchBody");
  const list = items.filter(i => watch.includes(i.shortName) || watch.includes(i.id));
  if (list.length === 0) {
    body.innerHTML = '<tr><td colspan="7" class="empty">自选为空 — 搜索物品名加入</td></tr>';
    return;
  }
  body.innerHTML = list.map(i => {
    const c = i.changeLast48hPercent;
    return `<tr>
      <td>${esc(i.shortName)}</td>
      <td>${esc(typeCn(i.types[0]))}</td>
      <td>${fmt(i.avg24hPrice)}</td>
      <td>${fmt(i.lastLowPrice)}</td>
      <td class="${cls(c)}">${pct(c)}</td>
      <td>${fmt(i.lastOfferCount)}</td>
      <td><button class="del" data-rm="${esc(i.shortName)}">✕</button></td>
    </tr>`;
  }).join("");
}

/* ---- 渲染：热榜（按 48h 绝对波动排序） ---- */
function renderHot() {
  const body = $("hotBody");
  const list = items
    .filter(i => (i.lastLowPrice || 0) > 0 && i.changeLast48hPercent != null)
    .sort((a, b) => Math.abs(b.changeLast48hPercent) - Math.abs(a.changeLast48hPercent))
    .slice(0, TOP_N);
  if (list.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="empty">暂无数据</td></tr>';
    return;
  }
  body.innerHTML = list.map(i => {
    const c = i.changeLast48hPercent;
    return `<tr>
      <td>${esc(i.shortName)}</td>
      <td>${esc(typeCn(i.types[0]))}</td>
      <td>${fmt(i.avg24hPrice)}</td>
      <td>${fmt(i.lastLowPrice)}</td>
      <td class="${cls(c)}">${pct(c)}</td>
      <td>${fmt(i.lastOfferCount)}</td>
    </tr>`;
  }).join("");
}

/* ---- 渲染：套利（商人价 − 跳蚤最低价） ---- */
function renderArb() {
  const body = $("arbBody");
  const list = items
    .filter(i => i.profit > 0)
    .sort((a, b) => b.profit - a.profit)
    .slice(0, TOP_N);
  if (list.length === 0) {
    body.innerHTML = '<tr><td colspan="5" class="empty">当前无正利润套利项</td></tr>';
    return;
  }
  body.innerHTML = list.map(i => `<tr>
    <td>${esc(i.shortName)}</td>
    <td>${fmt(i.lastLowPrice)}</td>
    <td>${fmt(i.bestTrader)}</td>
    <td class="profit-pos">+${fmt(i.profit)}</td>
    <td>${fmt(i.lastOfferCount)}</td>
  </tr>`).join("");
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
  btn.disabled = true;
  btn.textContent = "同步中";
  try {
    const n = await fetchItems();
    $("gameVersion").textContent = n + " 件物品";
    $("lastUpdate").textContent = now();
    renderWatch(); renderHot(); renderArb();
  } catch (e) {
    $("gameVersion").textContent = "加载失败: " + e.message;
    console.error(e);
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

/* ---- 启动 ---- */
load();
setInterval(load, REFRESH_MS);
