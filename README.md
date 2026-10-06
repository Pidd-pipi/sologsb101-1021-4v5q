# 篆刻印章与钤印记录台（gbsealcarve）

面向篆刻作者、印社与印章收藏者的创作留档工具：把每一方印石的印稿设计、刻制过程与历次钤印效果逐条记录，并按印谱顺序汇总成册。

核心动作：**建印石档案 → 设计印文与释文 → 按刀法排刻制工序 → 登记钤印所用印泥与纸张并评级 → 导出印谱清单与方数**。

纯前端单页应用（Svelte 5 + TypeScript + Vite + Svelte SPA Router + Tailwind CSS），**无后端、无数据库服务、无 API 服务**，全部数据保存在浏览器本地（IndexedDB / Dexie + 少量 localStorage 元数据）。

---

## 一、Docker 一键启动（推荐）

```bash
# 1. 首次启动先复制环境变量模板
cp .env.example .env

# 2. 构建并启动
docker compose up -d --build
```

启动完成后访问：**http://localhost:22821**

常用命令：

```bash
docker compose ps                 # 查看服务状态（healthy 表示就绪）
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 代码改动后重新构建
```

> 端口可在 `.env` 中通过 `FRONTEND_PORT` 修改；容器名固定为 `${COMPOSE_PROJECT_NAME:-gbsealcarve}-frontend`。
> 容器无状态：不连接数据库、不挂载命名卷，数据全部在浏览器本地；迁移设备请使用 `/catalog` 页的「导出 / 导入 JSON 备份」。

---

## 二、技术栈

| 分类 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Svelte 5（runes：`$state` / `$derived` / `$effect` / `$props`） | 页面按路由懒加载由 Vite 分包 |
| 语言 | TypeScript（`strict: true`，`noUnusedLocals`） | `npm run build` 内含 `svelte-check --threshold error` 类型检查 |
| UI | Tailwind CSS 3（手写组件，无 UI 组件库） | `tailwind.config.js` 定制「石墨 / 朱印 / 米纸」主题色 |
| 构建工具 | Vite 6 + `@sveltejs/vite-plugin-svelte` | 开发服务器端口 22821 |
| 状态管理 | Svelte store（`writable` / `derived`） | `stoneStore` / `designStore` / `carveStore` / `impressionStore` |
| 路由 | Svelte SPA Router（hash 模式，`svelte-spa-router`） | 地址形如 `/#/stones`；`index.html` 内置脚本把 `/stones` 路径式深链重写为 hash 形式 |
| 本地存储 | Dexie 4（IndexedDB 封装）+ localStorage | 含数据结构版本号与 v1→v2→v3 升级迁移（v3 增加借展批次表） |
| 容器化 | Docker 多阶段构建：`node:20-alpine` → `nginx:alpine` | 构建阶段类型检查 + 打包，运行阶段仅托管静态产物 |

---

## 三、本地开发方式

```bash
cd frontend
npm install
npm run dev        # 开发服务器 http://localhost:22821
npm run build      # 类型检查 + 生产构建，产物在 frontend/dist
npm run preview    # 本地预览构建产物（http://localhost:22821）
```

要求 Node.js 20 及以上（与 Docker 构建阶段镜像 `node:20-alpine` 保持一致）。

---

## 四、页面与路由

| 路由（hash 形式） | 页面 | 主要职责 | 消费模型 |
| --- | --- | --- | --- |
| `/#/stones` | 印石台账 | 新建印石、按石种与钮式筛选（同步 URL query），显示已刻方数、谱录方数、闲置天数与借展状态 | Stone、Design、LoanBatch |
| `/#/designs` | 印稿设计与释文 | 朱文白文、边框式样与章法备注录入，标记采用稿（同石采用稿唯一）；借出中印稿只读 | Design、Stone |
| `/#/carve` | 刻制工序看板 | 按印稿列出刀法步骤、拖拽或上下移排序、批量完成；全部完成回写印石为「已刻」；借出中锁定 | Carve、Design |
| `/#/impressions` | 钤印登记与效果比对 | 同稿多枚并列展示印泥、纸张、压力与评级，按评级择优并一键回填采用稿效果；借出中锁定 | Impression、Design |
| `/#/catalog` | 印谱汇总与导出 | 排序重编号、收录状态切换、印谱清单生成、JSON 导入导出与清空重播种；借出条目只读 | Catalog 及全部模型 |
| `/#/loans` | 借展点交与归还核还 | 从已收录未借出印章选批出库，登记借展方 / 归还日 / 印谱快照；整批事务点交与归还，并发拒绝、失败回滚重试 | LoanBatch 及全部模型 |

未知路径由 `routes/NotFound.svelte` 给出友好空态（不白屏）。筛选条件写入 hash query（`?kw=&stoneType=&knobStyle=` 等），刷新后可完整还原。

---

## 五、数据模型

| 模型 | 文件 | 关键字段 | 说明 |
| --- | --- | --- | --- |
| Stone 印石 | `src/lib/types/stone.ts` | `id` `name` `stoneType`（寿山/青田/昌化/巴林） `sizeMm`（长×宽×高） `knobStyle`（平顶/桥钮/古兽/薄意） `purchaseDate` `state`（在刻/已刻/闲置） | 新建后进入印稿设计，卡片回显已刻方数与最近钤印日期 |
| Design 印稿 | `src/lib/types/design.ts` | `id` `stoneId` `sealText` `annotation` `style`（朱文/白文） `borderStyle`（无框/双边/借边/瓦当） `layoutNote` `adopted` | 同石多稿，采用稿唯一，采用后带出到刻制与钤印 |
| Carve 刻制工序 | `src/lib/types/carve.ts` | `id` `designId` `seq` `knifeMethod`（冲刀/切刀/双刀/修整） `minutes` `operator` `state`（未开始/进行中/已完成） | 拖拽调序，全部完成即回写印石为已刻 |
| Impression 钤印记录 | `src/lib/types/impression.ts` | `id` `designId` `inkBrand` `paperType`（连史纸/宣纸/罗纹纸） `pressure`（轻/中/重） `grade`（优/良/一般/废） `stampedAt` | 同稿多次钤印按评级排序择优，可一键回填采用稿效果 |
| Catalog 印谱条目 | `src/lib/types/catalog.ts` | `id` `stoneId` `designId` `orderNo` `included`（待收录/已收录/不收录） `note` `loanLocked` | 调整排序后自动重编号并汇总已收录方数；印石借出期间只读 |
| LoanBatch 借展批次 | `src/lib/types/loan.ts` | `id` `batchNo` `borrower` `dueDate` `loanedAt` `handler` `status`（待点交/借出中/部分归还/已归还） `items[]` `snapshot` `lastError` | 整批点交 / 归还核还；明细含状态（待点交/借出中/已核还/缺损待处理/灭失）、缺损与养护结论、核对人；`snapshot` 为点交时五表全量印谱快照 |

数据结构版本号 `DB_VERSION` 定义在 `src/lib/utils/db.ts`，当前为 `v3`：`v1` 为初版五表结构；`v2` 补充 `stones.purchaseDate`、`designs.borderStyle`、`carves.operator`、`impressions.paperType`、`catalogs.included` 等索引，并在 Dexie `.upgrade()` 中回填历史记录缺失字段；`v3` 新增 `loans` 借展批次表，并为五张业务表补充 `loanLocked` 锁定字段与索引。旧档案缺借展字段时一律按「未借出」兼容（`loanLocked` 缺省即未锁定），旧版备份（无 `loans` 集合）可正常导入。

### 借展点交事务约定

- **出库范围**：只能选择印谱中 `included='included'`（已收录）且未被在借批次占用的印石。
- **整批原子提交**：点交在单个 Dexie 事务内完成「冲突复检 → 印谱快照 → 明细置借出 → 印石 / 印稿 / 工序 / 钤印 / 印谱条目整批加锁 → 批次落库」；任一写入失败整批回滚，不留半成品。
- **并发拒绝**：多标签或多批次同时点交时，事务内复检印石占用；先完成的借出生效，后提交批次抛冲突错误被拒绝，原清单以「待点交」草稿留档，冲突解除后可一键「原清单重试点交」。
- **锁定只读**：借出期间印稿、刻制工序、钤印记录与印谱收录 / 排序均只读（store 写入口有守卫，页面按钮禁用）。
- **归还核还**：逐方选择「完好 / 缺损 / 灭失」并填写缺损描述与养护结论；完好方立即解锁归位，缺损 / 灭失列入待处理并保持锁定，落实养护后在批次内「养护处理核销」才解锁。归还同样整批事务提交。
- **同步显示**：台账、印谱与借展批次订阅同一份 IndexedDB；标签重新可见时自动刷新，避免用旧清单覆盖先完成的借出。

---

## 六、目录结构

```
sologsb101-1021/
├── frontend/                     # 前端源码
│   ├── src/
│   │   ├── lib/
│   │   │   ├── types/            # stone.ts design.ts carve.ts impression.ts catalog.ts loan.ts
│   │   │   ├── stores/           # stoneStore.ts designStore.ts carveStore.ts impressionStore.ts loanStore.ts
│   │   │   ├── components/common/# GradeTag.svelte FilterBar.svelte StatBadge.svelte EmptyPanel.svelte
│   │   │   ├── hooks/            # useCarveProgress.ts useIdbTable.ts
│   │   │   ├── utils/            # stone.ts db.ts export.ts loan.ts lock.ts
│   │   │   └── router/           # index.ts（路由表 + 导航项）
│   │   ├── routes/               # stones/+page.svelte designs/+page.svelte carve/+page.svelte
│   │   │                         # impressions/+page.svelte catalog/+page.svelte loans/+page.svelte NotFound.svelte
│   │   ├── App.svelte            # 应用外壳（导航 + 首屏初始化）
│   │   ├── main.js main.ts       # 入口：main.js 引用 main.ts 的 bootstrap()
│   │   └── app.css               # Tailwind 入口 + 基础层 / 组件层
│   ├── public/favicon.svg
│   ├── index.html package.json tsconfig.json vite.config.ts
│   ├── svelte.config.js tailwind.config.js postcss.config.js
│   ├── Dockerfile                # 多阶段构建（node:20-alpine → nginx:alpine）
│   ├── nginx.conf                # SPA fallback + gzip + 静态资源缓存
│   └── .dockerignore
├── docker-compose.yml            # 顶层 name、container_name、端口映射
├── .env / .env.example           # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── README.md
```

分层约定：页面组件只读 store 并调用导出的动作函数更新，跨页状态不留在组件内部；`useIdbTable()` 提供页面级 `liveQuery` 响应式订阅（`/catalog` 的印谱条目读写、`/stones` 的谱录方数统计均走它）。

---

## 七、数据存储说明

- **IndexedDB（Dexie，数据库名 `gbsealcarve`）**：6 张业务表 `stones` / `designs` / `carves` / `impressions` / `catalogs` / `loans`，由 `src/lib/utils/db.ts` 统一定义 schema、版本号与升级迁移；`initDatabase()` 首次打开时自动播种**三层互相引用**的演示数据（Stone → Design → Carve / Impression，另有 Stone → Catalog，固定 id 如 `stone_01`、`design_0101`、`carve_010101`），播种幂等，保证每个页面打开都有内容。
- **localStorage**：仅存元数据 —— `gbsealcarve:db-version`（本地结构版本）、`gbsealcarve:last-backup-at`（最近导出时间）、`gbsealcarve:ui-prefs`（当前印石 / 印稿）。
- **备份**：`/catalog` 页可导出 JSON（6 张表全量数据 + 结构版本号；旧版备份缺 `loans` 集合时按空兼容），导入时校验 `app` 字段与各集合数组完整性，覆盖导入前二次确认；另有印谱清单 TXT 与钤印台账 CSV。
- **隐私与无状态**：数据不上传任何服务器，容器不挂载命名卷；清理浏览器站点数据或更换浏览器会丢失档案，请定期导出备份。

---

## 八、开发提示

- 类型检查与构建：`cd frontend && npm run build`（含 `svelte-check`，必须零错误）。
- 端口一致性：开发服务器（`vite.config.ts`）、预览服务、compose 的 `FRONTEND_PORT` 默认值均为 `22821`。
- 路由为 hash 模式：`http://localhost:22821/#/stones` 可直接访问；导航到 `/stones` 这类路径式地址时，`index.html` 的内联脚本会自动重写为 hash 形式，随后由 nginx 的 `try_files $uri $uri/ /index.html` 兜底。
- 若部署在中文路径下，`docker-compose.yml` 顶层的 `name: gbsealcarve` 可保证项目名不为空，`docker compose config --quiet` 不会报错。
- 容器运行阶段执行了 `RUN chmod -R a+rX /usr/share/nginx/html`，避免宿主机静态资源权限为 0600 时 nginx worker 读取失败返回 403。
