/* ============================================================
   塔科夫跳蚤行情 - Cloudflare Worker 数据代理（免费方案 C）
   ------------------------------------------------------------
   单数据源：tarkov.dev GraphQL（免费、无 key、实时回源）
   背景：tarkov.dev REST 全量接口被 CDN 锁死（max-age 8 天），
         加参数无法绕过；Tarkov-Market 实时源需 Patreon 付费 key。
         GraphQL 是 tarkov.dev 官方实时通道，字段齐全（价格/24h
         高低点/48h 涨跌/商人收购价/图标），完全替代付费方案。
   Worker 边缘缓存 30s + 上游故障降级（stale-while-error），
   前端 30s 轮询即可拿到 30s 级新鲜数据。
   部署：wrangler deploy（见 README-WORKER.md）
   ============================================================ */

// ---------- 配置 ----------
const GQL_URL = "https://api.tarkov.dev/graphql";
const GQL_QUERY = `
query {
  items(lang: en, limit: 1000) {
    id name shortName types iconLink updated
    lastLowPrice avg24hPrice low24hPrice high24hPrice
    changeLast48hPercent lastOfferCount
    sellFor { vendor price priceRUB }
  }
}`;
const CACHE_TTL = 30;   // 正常缓存秒数（前端 30s 轮询的下限）
const STALE_TTL = 300;  // 上游故障时复用旧数据的最大秒数（5 分钟）

// ---------- GraphQL 回源 + 边缘缓存（stale-while-error） ----------
async function fetchItems(ctx, cacheKey) {
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  let cachedBody = null, cachedAt = 0;
  if (hit) {
    cachedAt = Number(hit.headers.get("x-cached-at") || 0);
    cachedBody = await hit.json();
  }
  // 命中且未过期 → 直接返回缓存
  if (cachedBody && cachedAt && Date.now() - cachedAt < CACHE_TTL * 1000) {
    return { data: cachedBody, stale: false };
  }

  let upstream = null;
  try {
    const res = await fetch(GQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ query: GQL_QUERY }),
    });
    if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
    upstream = await res.json();
    if (upstream.errors) throw new Error("GraphQL errors: " + JSON.stringify(upstream.errors).slice(0, 200));
  } catch (e) {
    // 上游故障：旧缓存仍在容忍期内则降级返回（标记 stale），否则抛出
    if (cachedBody && cachedAt && Date.now() - cachedAt < STALE_TTL * 1000) {
      return { data: cachedBody, stale: true, note: String(e && e.message || e) };
    }
    throw e;
  }

  // 成功回源 → 写入边缘缓存
  const store = new Response(JSON.stringify(upstream), {
    headers: { "Content-Type": "application/json; charset=utf-8", "x-cached-at": String(Date.now()) },
  });
  ctx.waitUntil(cache.put(cacheKey, store.clone()));
  return { data: upstream, stale: false };
}

// ---------- 套利：非跳蚤市场、非黑商 Fence 的最高商人收购价 ----------
function bestTraderOf(it) {
  let best = 0, name = "";
  for (const s of (it.sellFor || [])) {
    const v = String(s.vendor || "");
    if (/flea|fence/i.test(v)) continue; // 排除跳蚤市场与黑商 Fence
    const p = Number(s.priceRUB ?? s.price ?? 0);
    if (p > best) { best = p; name = v; }
  }
  return { best, name };
}

// ---------- 主处理 ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response("ok", {
        headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS" },
      });
    }
    if (url.pathname === "/health") {
      return json({ ok: true, time: new Date().toISOString() });
    }

    try {
      const { data, stale, note } = await fetchItems(ctx, "tarkov-graphql-items");
      const list = (data.data && data.data.items) || [];
      const t0 = Date.now();
      const out = list.map(it => {
        const price = it.lastLowPrice || 0;
        const t = bestTraderOf(it);
        return {
          id: it.id,
          shortName: it.shortName || it.name || it.id,
          name: it.name || it.shortName || it.id,
          iconLink: it.iconLink || "",
          avg24hPrice: it.avg24hPrice || 0,
          low24hPrice: it.low24hPrice || 0,
          high24hPrice: it.high24hPrice || 0,
          lastLowPrice: price,
          changeLast48hPercent: it.changeLast48hPercent ?? 0,
          lastOfferCount: it.lastOfferCount ?? 0,
          types: it.types || [],
          bestTrader: t.best,
          traderName: t.name,
          profit: price > 0 ? t.best - price : 0,
          updated: it.updated || null,
        };
      });

      return json({
        items: out,
        meta: {
          total: out.length,
          source: "tarkov.dev GraphQL (free)",
          stale,
          staleNote: note || null,
          generatedAt: new Date(t0).toISOString(),
        },
      });
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 502);
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}
