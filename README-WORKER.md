---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 5cfd1853fe6ccfe434a3cc3a6a8f47ec_ab26ae76a36e11f192a2525400287e28
    ReservedCode1: IFjT1WLJeflmri/Gm/DlBh2PMkpbGcOdXAsykrLihXi6MJyEAsKNQ+fX9P/tfz/qN71j8l8sDmXuCS45ALiJb+0qnHlxBAwmA6WJnPllMmz0+kEOMc69EicMnEAt3rhfbRtQ99jyee+pmLvuZPSh5M4jeyYD82yj2VjSR5UfAEF63iK5l+geeoRxMLc=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 5cfd1853fe6ccfe434a3cc3a6a8f47ec_ab26ae76a36e11f192a2525400287e28
    ReservedCode2: IFjT1WLJeflmri/Gm/DlBh2PMkpbGcOdXAsykrLihXi6MJyEAsKNQ+fX9P/tfz/qN71j8l8sDmXuCS45ALiJb+0qnHlxBAwmA6WJnPllMmz0+kEOMc69EicMnEAt3rhfbRtQ99jyee+pmLvuZPSh5M4jeyYD82yj2VjSR5UfAEF63iK5l+geeoRxMLc=
---

# Worker 部署说明（免费方案 C：GraphQL 单源 · 30 秒刷新）

## 为什么换成 GraphQL 单源
- **Tarkov-Market**：实时扫描源，但 API key 现为 Patreon 付费专享，放弃。
- **tarkov.dev REST**：全量接口被 Cloudflare CDN 锁死（`max-age=691200`，8 天），
  加 query 参数也无法绕过；且数据中心 IP 直连会被 WAF 403，Worker 回源同样不可用。
- **tarkov.dev GraphQL**（`https://api.tarkov.dev/graphql`）：官方实时通道，免费、无需 key，
  字段齐全（lastLowPrice / avg24hPrice / low24hPrice / high24hPrice /
  changeLast48hPercent / sellFor{vendor,priceRUB} / iconLink / types / updated）。

因此用一个 Cloudflare Worker 做 GraphQL 代理：
- 边缘缓存 30 秒，前端 30 秒轮询即可拿到 30 秒级新鲜数据（远快于旧版 2 分钟）
- Worker 是唯一回源客户端，频率可控，不易触发 rate limit
- 上游故障时自动降级返回旧数据（stale-while-error，容忍 5 分钟），不会白屏
- 顺带把约 2MB 全量压缩成只含展示字段的精简 JSON

## 架构
```
浏览器(30s轮询) --> CF Worker(边缘缓存30s + stale降级) --> tarkov.dev GraphQL(免费实时)
```

## 部署步骤

### 1. 部署 Worker（无需任何 key / 注册）
```bash
cd worker
# 安装 wrangler（若未装）
npm i -g wrangler
# 登录 Cloudflare 账号（首次会开浏览器授权）
wrangler login
# 部署
wrangler deploy
```
部署完成后会输出形如 `https://tarkov-ticker-xxxx.workers.dev` 的地址。

> 注意：tarkov.dev GraphQL 近期偶发故障（HTTP 422，官方 6 月底重构后端所致）。
> 部署后若返回 502 属上游问题，恢复后自动可用；可访问 https://api.tarkov.dev/graphql
> 确认上游状态，或用 Worker 的 /health 与响应 `meta.stale` 观察。

### 2. 前端指向 Worker
编辑 `js/app.js` 顶部：
```js
const API = "https://你的worker.workers.dev/";
```
刷新间隔已是 30 秒（`REFRESH_MS`），无需再改。

### 3. 提交上线
```bash
git add -A && git commit -m "feat: 切换到免费 GraphQL 数据源, 30秒实时刷新" && git push
```
GitHub Pages 生效后（1-2 分钟），Ctrl+F5 强刷即可。

## 验证
- 打开站点后 F12 → Network，应看到对 `你的worker.workers.dev` 的 30s 周期请求
- 顶栏"上次刷新"应明显比旧版更频繁更新
- 价格变动时数字红绿闪烁（涨绿跌红）
- 上游故障时响应 `meta.stale=true`，前端仍显示最近一次数据，不白屏

## 常见问题
- **Worker 返回 502**：查看响应 `error` 字段——`GraphQL HTTP xxx` 表示 tarkov.dev 上游故障；
  等其恢复即可，本站无需改动。
- **数据比想象中旧**：GraphQL 数据由 tarkov.dev 后端定期刷新（约 30-60 分钟量级）；
  可看物品 `updated` 字段判断上游更新时间，这是第三方免费源的客观上限。
- **想拉更多物品**：调大 `worker.js` 里 `GQL_QUERY` 的 `limit`（默认 1000）。
- **担心 rate limit**：Worker 是单客户端回源，30s/次频率很低；若遇 429 会自动走 stale 降级，
  不影响前端显示。
*（内容由AI生成，仅供参考）*
