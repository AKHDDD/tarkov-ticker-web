---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 5cfd1853fe6ccfe434a3cc3a6a8f47ec_7a3fe913a35e11f193c6525400f8a581
    ReservedCode1: 6zkWpb8Hi9m4ajm4GwIIjDu7plyWw5Es9os5KutnMZSI++x5rLAIALTXB3fHEq3dGNGSlvUT0VFZyQSKiovpGzfaMaubnpITQFe/Ig/SzZSk0Gfmd+wZXScCeEr3nndaa4WokUP6xWcaYgEUE38NWhAKVYE25VLbTcTZUJV6qEqfKf6DyTAbmx8qjIQ=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 5cfd1853fe6ccfe434a3cc3a6a8f47ec_7a3fe913a35e11f193c6525400f8a581
    ReservedCode2: 6zkWpb8Hi9m4ajm4GwIIjDu7plyWw5Es9os5KutnMZSI++x5rLAIALTXB3fHEq3dGNGSlvUT0VFZyQSKiovpGzfaMaubnpITQFe/Ig/SzZSk0Gfmd+wZXScCeEr3nndaa4WokUP6xWcaYgEUE38NWhAKVYE25VLbTcTZUJV6qEqfKf6DyTAbmx8qjIQ=
---

# 塔科夫跳蚤行情 · Tarkov Market Ticker（网页版）

纯静态网页行情站：实时均价 / 24h 最低 / 48h 涨跌 / 商人套利利润，支持自选清单（存浏览器本地）。
数据来源 [tarkov.dev](https://tarkov.dev) 社区公开 REST API（免费、无需 key、前端直连）。
实现要点：REST 全量接口被 CDN 锁死 8 天缓存，前端用时间戳参数 `?v=<ts>` 绕过拿到实时价；
全量约 16MB，裁剪字段后写入 localStorage（约 1.5MB），二次打开秒出、后台静默拉新，
拉取失败降级用本地缓存（容忍 30 分钟）。无需任何后端 / Worker。

## 项目结构

```
tarkov-ticker-web/
├── index.html            # 单页：状态栏 + 3 Tab + 广告位
├── css/style.css         # 军绿战术风格
├── js/app.js             # 数据拉取 / 渲染 / 自选 / 自动刷新(5min)
├── privacy-policy.html   # AdSense 必需
└── robots.txt
```

## 第一步：本地预览

直接双击 `index.html` 打开即可（前端直连 API，无需本地服务）。
注意：刷新频率默认 5 分钟，tarkov.dev 有 rate limit，勿调低（改 `js/app.js` 顶部 `REFRESH_MS`）。

## 第二步：免费部署（二选一）

### 方案 A：Cloudflare Pages（推荐）
国内访问相对稳定，免费额度对个人站完全够用。
1. 注册 Cloudflare，进 [Cloudflare Pages](https://pages.cloudflare.com) → Create project
2. 连接你的 GitHub 仓库（把本项目文件推到仓库）→ 框架选 **None**（纯静态）
3. 构建命令留空，输出目录填 `.`，直接 Deploy
4. 免费子域名 `xxx.pages.dev` 即可访问；后续可绑自定义域名（免费）

### 方案 B：GitHub Pages（你之前用过）
1. 把本项目推到 GitHub 仓库
2. Settings → Pages → Source 选 `main` 分支根目录
3. 访问 `https://<你的用户名>.github.io/<仓库名>/`
   - 注意：子路径部署时，`index.html` 里相对路径（css/js）已经用相对写法，可正常工作
   - 国内访问 GitHub Pages 可能不稳定，建议优先方案 A

## 第三步：接入广告

### 3.1 申请 Google AdSense
1. 访问 [AdSense](https://adsense.google.com) 用 Google 账号申请
2. **审核门槛（重要）**：AdSense 对新站审核严格，常见卡点：
   - 站点需要有一定内容量和访问量（新站直接申请大概率被拒）
   - 必须有隐私政策页（本站已内置，接入后记得核对 Cookie 说明）
   - 内容不能违反政策（游戏数据站一般合规，但请勿放违规内容）
3. **建议节奏**：先免费部署上线 → 让站点运行 1-2 周积累内容和爬虫收录 → 再申请
4. 通过后：AdSense 后台 → 广告 → 自动广告（打开"自动广告"开关即可全站自动注入，最省事），或手动创建展示广告单元

### 3.2 替换广告位
本站已预留两个广告位，在 `index.html` 中找到：
- 顶部：`<div class="ad-slot" id="ad-top">`
- 底部：`<div class="ad-slot" id="ad-bottom">`

将 `<!-- 顶部广告位：部署后把本行替换为 AdSense 广告代码 -->` 整行替换为 AdSense 提供的广告代码块即可。
（若启用 AdSense 自动广告，则无需手动替换，占位 div 可保留或删除。）

### 3.3 收入现实预期（务必先看）
- 塔科夫行情站是**极小众流量**，即使做起来 AdSense 收入通常也在 **每月几美元** 量级
- 流量来源几乎全靠 SEO + 玩家社区分享，冷启动周期长
- 广告只适合作为"顺带收入"，不要预期它能养站

## 维护

- 改刷新频率：`js/app.js` 的 `REFRESH_MS`（单位毫秒，建议 ≥ 300000，全量 16MB 不宜太频繁）
- 改缓存容忍时长：`js/app.js` 的 `STALE_TTL_MS`
- 自选清单：用户浏览器 localStorage 自动保存，无需后端

## 免责

仅供游戏参考，与 Battlestate Games 无关；数据版权归 tarkov.dev 社区。
*（内容由AI生成，仅供参考）*
