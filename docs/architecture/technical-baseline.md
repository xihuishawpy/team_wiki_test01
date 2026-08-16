## OWN-71 技术基线与外部依赖决策包

版本：v0.1
日期：2026-08-15
依据：PRD v0.4、MVP 研发拆解 v0.1
状态：可用于 T01/OWN-75 搭建；真实外部资源仍需 Owner 授权

## 1. 结论

推荐采用一个私有应用仓库、一个专用私有内容仓库，以及“同代码库、同数据库、同制品、按权限拆运行角色”的模块化单体：

```text
浏览器
  │ HTTPS
  ▼
反向代理 / Ingress
  ├── web-api（无 GitHub App 私钥、无模型密钥）
  ├── publish-worker（仅发布 App 凭证）
  └── classify-worker（仅只读 App 凭证 + 模型密钥）
          │
          ├── PostgreSQL（事实状态、草稿、任务、分类、审计、派生搜索索引）
          ├── GitHub 私有内容仓库（已发布原文事实源）
          ├── 私有临时对象存储（草稿附件；生产环境）
          └── OpenAI-compatible 模型服务
```

三个运行角色来自同一镜像和代码库，不是微服务；通过启动命令、数据库角色和密钥注入范围形成最小权限边界。MVP 不引入 Redis、Kafka/RabbitMQ 或 Elasticsearch。后台任务使用 PostgreSQL 任务表，投递语义为 at-least-once，所有 handler 必须幂等。

当前可以立即推进：

- 按本文建立应用目录、模块接口、迁移、OpenAPI、测试入口和外部服务 fake。
- 用本地 PostgreSQL 跑数据库任务表、幂等状态机和故障注入测试。
- 审核并批准 ADR-001～006、数据库初稿和 API 初稿。

必须等待授权后推进：

- 创建或写入真实应用仓库、内容仓库、GitHub App 与 webhook。
- 部署到测试/生产环境、配置域名/HTTPS、数据库、对象存储与密钥管理。
- 向真实模型发送团队内容、创建首个管理员账号或导入真实评测文章。

两个现有业务仓库与本产品没有明确关联，不应使用或修改。

## 2. 推荐技术栈

| 层       | 建议                                                        | 约束与理由                                                                    |
| -------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 运行时   | Node.js 24 LTS、TypeScript strict                           | 2026-08 为 LTS；生产只用 Active/Maintenance LTS，镜像和 lockfile 固定精确版本 |
| 工作区   | pnpm workspace                                              | 单仓管理 web、API、worker、契约与测试；提交 lockfile                          |
| Web      | React + Vite，Markdown 编辑用 CodeMirror 6                  | 前后端边界清晰；预览必须做 HTML 白名单净化，禁止直接注入原始 HTML             |
| API      | NestJS + Fastify adapter，REST                              | 模块/依赖注入适合模块化单体；Fastify 由 Nest 官方适配                         |
| 契约     | OpenAPI 3.1，契约文件入库并在 CI lint                       | 本包附 `openapi-v0.1.yaml`；实现与契约不一致时 CI 失败                        |
| 数据访问 | PostgreSQL 18 当前 minor；Kysely/`pg` + 显式 SQL migration  | 保留 PostgreSQL 锁、约束、FTS/`pg_trgm` 和事务能力；不把 ORM 模型当领域模型   |
| 任务     | PostgreSQL `background_jobs` + `FOR UPDATE SKIP LOCKED`     | 满足 MVP 规模与可恢复性；`LISTEN/NOTIFY` 只能优化唤醒，不能作为事实源         |
| GitHub   | GitHub App installation token + Git Data API                | 多文件发布用 blob/tree/commit/ref，一次 ref 更新发布一个原子版本              |
| 模型     | OpenAI-compatible adapter + JSON Schema/Ajv                 | 服务端调用、结构化输出、超时/重试、供应商差异契约测试                         |
| 搜索     | PostgreSQL 派生索引；首版 `pg_trgm` + 权限过滤              | 中英文可先做语言无关的相似/子串检索；数据量或 P95 达阈值后再评估专用搜索      |
| 测试     | Vitest、Testcontainers、Playwright、GitHub/模型 fake server | 单元、数据库集成、契约、组件、E2E、安全和故障测试分层                         |
| 可观测   | OpenTelemetry 接口、结构化 JSON 日志、Prometheus 风格指标   | 日志禁止正文、密码、Cookie、App 私钥和模型密钥                                |

版本冻结规则：T01 创建仓库时记录 Node、PostgreSQL 和所有 npm 包的精确版本；自动升级只允许产生 PR，禁止生产环境浮动拉取 `latest`。

## 3. 应用仓库与模块边界

建议应用仓库结构：

```text
apps/
  web/                  # React UI
  api/                  # HTTP、认证入口、webhook 快速接收
  worker/               # publish / classify / reconcile 三种启动角色
packages/
  contracts/            # OpenAPI、JSON Schema、生成类型
  domain/               # 领域值对象、事件、错误码；不依赖 Nest/DB/GitHub
  modules/
    identity-access/
    content-drafts/
    publication/
    github-sync/
    taxonomy/
    classification/
    discovery/
    audit/
    platform-health/
  adapters/
    postgres/
    github/
    model/
    object-storage/
  observability/
migrations/
tests/
  contract/
  integration/
  e2e/
  security/
```

模块只能写自己的表，通过公开 application service 或领域事件协作。禁止控制器跨模块直接访问 repository，禁止分类模块调用内容写接口。

| 模块            | 拥有的数据/能力                      | 可以依赖                                     | 禁止                                       |
| --------------- | ------------------------------------ | -------------------------------------------- | ------------------------------------------ |
| identity-access | 用户、角色、会话、登录节流、授权策略 | audit                                        | 读取密码明文；用前端路由代替服务端授权     |
| content-drafts  | 草稿、草稿附件、乐观锁               | identity-access、object storage              | 调用 GitHub；自动保存产生 commit           |
| publication     | 发布请求、文章稳定身份、版本引用     | content-drafts、GitHub publisher、audit      | 先标记成功再提交 GitHub；把分类写入原文    |
| github-sync     | webhook、对账、外部版本              | publication、discovery、classification       | 未验签先解析/入队；按浮动分支分类          |
| taxonomy        | 受控类型/主题/项目、taxonomy version | identity-access、audit                       | 复用已删除稳定 ID；模型自由创建受控节点    |
| classification  | 任务、分类、反馈、模型配置引用       | immutable content reader、taxonomy、audit    | 内容写权限；记录完整正文；执行正文中的指令 |
| discovery       | 列表、权限安全搜索、派生索引         | publication、classification、identity-access | 用索引绕过记录级权限；把索引当原文事实源   |
| audit           | 追加式审计                           | identity context                             | 更新/删除既有审计；记录秘密或正文          |
| platform-health | liveness/readiness/依赖状态          | adapters                                     | 在响应中泄露地址凭证、堆栈或私有仓库信息   |

领域事件采用同库事务写入任务表：

- `article.version_recorded` → 建索引、创建分类任务。
- `taxonomy.version_changed` → 标记受影响分类待复核。
- `github.external_version_detected` → 建版本、索引、分类。
- `classification.completed` → 刷新派生分类视图。

事件 payload 只保存 ID、版本和必要状态；正文由 handler 按不可变 commit SHA 获取。

## 4. 部署与权限拓扑

### 4.1 运行角色

| 角色             | 网络出口                             | 密钥                                   | 数据库权限                                          |
| ---------------- | ------------------------------------ | -------------------------------------- | --------------------------------------------------- |
| web-api          | PostgreSQL、对象存储；默认不直连模型 | session/CSRF、对象存储引用             | 认证、草稿、查询、webhook inbox；不能读取模型密钥值 |
| publish-worker   | PostgreSQL、GitHub API、对象存储     | Publisher App 私钥                     | claim publish jobs；写发布/版本/审计                |
| classify-worker  | PostgreSQL、GitHub API、模型 API     | Reader App 私钥、模型 secret reference | claim classification jobs；只写分类/运行审计        |
| reconcile-worker | PostgreSQL、GitHub API               | Reader App 私钥                        | webhook/版本对账与可重建索引                        |

所有容器非 root 运行、根文件系统只读，临时目录限额；出口网络按目的域名/IP 收敛。生产至少两个 web-api 副本可以横向扩展，worker 可从 1 开始；会话与任务均不依赖本机内存。

### 4.2 健康检查

- `GET /health/live`：仅证明进程事件循环可响应；不探测外部系统。
- `GET /health/ready`：数据库和 migration 必须正常；GitHub/模型故障显示 degraded，但不应让已有文章阅读整体下线。
- `GET /api/admin/system-health`：仅管理员可见，显示依赖状态、最后成功时间、队列深度、错误码；不显示 endpoint 中的查询参数、仓库私密信息或任何 secret。

### 4.3 配置分层

- 普通配置：环境名、端口、功能开关、阈值、仓库 owner/name/default branch。
- secret reference：数据库凭证、session/CSRF key、GitHub App 私钥、webhook secret、模型 key、对象存储凭证。
- 仓库只提交 `.env.example` 占位符；真实值进入平台 secret manager。应用启动时校验缺项，错误只报配置名，不回显值。

## 5. 数据库与任务方案

完整 DDL 初稿见 `schema-v0.1.sql`。核心不变量：

1. `articles.github_path` 永久固定且唯一，格式为 `content/<article_id>/index.md`。
2. 发布请求创建不可变 `draft_publish_snapshots`；自动保存可以继续，但 worker 只能读取快照。
3. `article_versions` 同时保存 `body_hash`（作者 Markdown）和 `content_hash`（规范化 `index.md` 文件）；文章读取必须指定已记录 commit。
4. `publish_requests.idempotency_key` 在用户范围唯一；相同 key + 相同输入返回原结果，相同 key + 不同输入返回 `409 IDEMPOTENCY_CONFLICT`。
5. 每个版本最多一个当前分类；历史分类、模型、提示词和 taxonomy version 不删除。`taxonomy_node_revisions` 可还原分类时的受控词表。
6. webhook 以 `X-GitHub-Delivery` 唯一去重。
7. 审计 append-only；应用角色无 UPDATE/DELETE 权限。
8. 搜索数据明确标记 derived，只用于检索，正文展示必须回到 commit SHA。

发布文件采用唯一的、可测试的规范化编码：

- UTF-8、LF 换行、文件末尾恰好一个换行；不对作者正文做润色或语义转换。
- `index.md` 由平台管理的 YAML front matter（`article_id`、精确标题）和作者 Markdown 正文组成；平台字段与作者正文分别 hash。
- `title_hash` 是精确标题 UTF-8 的 SHA-256，`body_hash` 是规范化作者正文 UTF-8 的 SHA-256，`content_hash` 是最终 `index.md` bytes 的 SHA-256。
- `input_hash` 覆盖标题、正文和按路径排序的附件 SHA-256 manifest；任何输入变化都会导致不同 hash。
- YAML 序列化必须使用固定字段顺序和 escaping；解析回读后标题/正文必须逐字节匹配快照，才可标记发布成功。

### 5.1 后台任务

`background_jobs` 保存 `kind`、`dedupe_key`、`payload`、`status`、`attempts`、`available_at`、lease 和最后错误码。`UNIQUE(kind, dedupe_key)` 防止重复入队。

claim 语义：

```sql
WITH candidate AS (
  SELECT id
  FROM background_jobs
  WHERE status IN ('queued', 'retry')
    AND available_at <= now()
    AND (lease_until IS NULL OR lease_until < now())
  ORDER BY priority DESC, available_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE background_jobs j
SET status = 'running',
    lease_owner = :worker_id,
    lease_until = now() + interval '60 seconds',
    attempts = attempts + 1,
    updated_at = now()
FROM candidate
WHERE j.id = candidate.id
RETURNING j.*;
```

- handler 完成业务事务后标记 `succeeded`；崩溃则 lease 到期后可重取。
- retry 使用带抖动的指数退避；分类最多 3 次，之后产出 `needs_review`，不能无限重试。
- 发布失败不丢草稿；自动重试只覆盖明确可重试错误，鉴权/权限/校验错误等待管理员处理。
- job payload 有 `schema_version`；未知版本进入 dead letter 并告警。
- 每个 handler 先检查领域唯一键，因此重复执行不会产生第二个版本、分类或 webhook 处理结果。

### 5.2 并发和一致性

- 草稿更新：`PATCH` 携带 revision/`If-Match`，SQL `WHERE revision = :base`；0 行即 `409 DRAFT_VERSION_CONFLICT`。
- 发布：同一事务复制当前 revision 为不可变发布快照并创建请求；发布期间的新编辑形成下一 revision，不改变当前发布输入。
- taxonomy：稳定 ID 不复用；每次变更原子递增全局 taxonomy version。
- 分类：结果写入时验证 version 仍是文章当前版本；旧结果保留为 superseded，不覆盖当前展示。
- GitHub/数据库无法组成分布式事务，使用持久化 `publish_requests` 状态机恢复，见下一节。

## 6. GitHub 仓库、App 与幂等发布 PoC

### 6.1 仓库清单

需要仓库管理员创建并授权：

| 资源         | 建议                               | 关键设置                                                       |
| ------------ | ---------------------------------- | -------------------------------------------------------------- |
| 应用实现仓库 | 新建私有仓库，名称由 Owner 确认    | main 保护、必需 review/CI、禁止直推、secret scanning、依赖更新 |
| 内容仓库     | 新建专用私有仓库，禁止混入应用代码 | 默认分支保护；仅 Publisher App 可写；成员默认只通过平台访问    |

内容仓库约定：

```text
content/<article_uuid>/index.md
content/<article_uuid>/assets/<attachment_uuid>-<sanitized-name>
```

路径只使用应用生成 UUID；用户文件名必须净化，禁止 `..`、绝对路径、控制字符、大小写碰撞和软链接。单文件、单文章、附件类型/总量上限由 Owner 确认；未确认时生产上传关闭。

### 6.2 GitHub App 最小权限

推荐用两个只安装到专用内容仓库的 GitHub App，以兑现“Agent 无正文写权限”：

| App           | Repository permissions                     | Events                 | secret 所在进程           |
| ------------- | ------------------------------------------ | ---------------------- | ------------------------- |
| Publisher App | Contents: Read & write；其他全部 No access | `push`                 | publish-worker            |
| Reader App    | Contents: Read-only；其他全部 No access    | 无（或不启用 webhook） | classify/reconcile-worker |

GitHub App 自带 webhook 由 Publisher App 接收 `push`。不申请 Administration、Metadata write、Pull requests、Issues、Actions、Workflows、Members 或用户授权。若组织政策禁止两个 App，必须由安全评审批准“写凭证仅注入 publish-worker、分类进程零凭证”的降级方案；只靠提示词禁止写入不予接受。

仓库管理员还需确认：

- 安装范围选择 Only select repositories，且只有内容仓库。
- webhook URL 使用 HTTPS；secret 高熵并存 secret manager。
- 默认分支 ruleset 阻止成员直接 push；只允许应急管理员和 Publisher App 的受控 bypass。
- 禁止 Publisher App 写 `.github/workflows/**`；代码也做路径 allowlist。
- App 私钥轮换、撤销、审计负责人和响应 SLA。

### 6.3 webhook 接收

HTTP 入口必须保留原始 request bytes：

1. 使用 `X-Hub-Signature-256` 做 HMAC-SHA256 恒定时间比较，失败返回 401 且不解析业务 payload。
2. 校验 `X-GitHub-Event` 仅允许 `push`/`ping`；未知事件 202 忽略。
3. 以 `X-GitHub-Delivery` 插入唯一 inbox 行；重复 delivery 返回 202，不重复执行。
4. 校验 installation、repository ID、owner/name 和 ref 都与配置一致。
5. 10 秒内返回 2XX，实际处理进入数据库任务。
6. push 只处理允许分支和 `content/**`；外部修改生成来源为 github 的版本并重新索引/分类。
7. 定时按分支 head 和已记录 SHA 对账，补偿 webhook 漏送；所有派生索引可重建。

### 6.4 多文件原子发布与幂等恢复

不要逐文件调用 Contents API 形成多个 commit。PoC 使用 Git Data API：

1. API 在一个数据库事务中创建不可变发布快照和 `publish_requests`，保存 idempotency key、draft revision、输入 hash 和 base commit SHA。
2. publish-worker 获取 installation token，读取当前 ref；若与 base 不同，重新检查文章路径是否冲突。
3. 为 `index.md` 和附件创建 blobs，以当前 tree 为 `base_tree` 创建新 tree。
4. 创建一个 commit，parent 为当前 head；commit message 追加 `Publish-Request-ID: <uuid>`。
5. 在更新 ref 前把 candidate commit SHA 持久化。
6. 非 force 更新默认分支 ref；成功后读取指定 commit 的文件并核验 SHA-256。
7. 数据库事务写 `article_versions`、标记发布成功并插入索引/分类任务。

响应丢失/崩溃恢复：

- candidate SHA 已知：读取 ref；head 等于 candidate 或 candidate 是 head 祖先且目标文件 hash 相同，则认定已发布。
- candidate SHA 未记录但 ref 已更新：按 `Publish-Request-ID` 在限定窗口查 commit，且必须同时核验固定路径和输入 hash。
- ref 被并发推进且候选未合入：不 force push；基于新 head 重建 tree/commit，同一 publish request 最终只登记一个版本。
- 任何不确定状态保持 `reconciling`，页面不能显示成功；人工可安全重跑对账。

### 6.5 PoC 验收矩阵

| 用例               | 注入                            | 期望                                           |
| ------------------ | ------------------------------- | ---------------------------------------------- |
| 正常发布           | 1 篇 + 2 附件                   | 一个 commit、固定路径、DB SHA/hash 一致        |
| 重复 HTTP          | 同一 idempotency key 并发 10 次 | 一个发布请求、一个可见版本                     |
| key 复用冲突       | 同 key 不同 draft revision      | 409，不调用 GitHub                             |
| ref 更新响应丢失   | GitHub 成功后客户端超时         | 对账恢复成功，不产生第二 commit                |
| worker 崩溃        | commit 创建后、ref 更新前终止   | lease 恢复；不 force；最多一个可见版本         |
| 并发发布不同文章   | 两 worker 同 base               | 一方重基于新 head，两个版本均存在，无丢 commit |
| GitHub 403/429/5xx | fake server 返回错误            | 403 阻塞；429/5xx 退避；草稿不丢               |
| webhook 重放       | 同 delivery 重放                | inbox 一行、下游一次                           |
| webhook 伪造       | 错签名/错 repo/ref              | 401 或忽略，无任务                             |
| 权限负测           | Reader App 尝试更新 ref         | GitHub 403，并记录无敏感值的安全审计           |

在没有测试组织、仓库和 App 授权时，只运行 fake server 契约测试；不得拿现有业务仓库代替。

## 7. ADR-001～006 工程化落地稿

### ADR-001：GitHub 保存发布原文

- 状态：Accepted。
- 决定：一个专用私有内容仓库保存已发布 Markdown/附件；应用文章 ID 和 URL 稳定，分类永不移动路径。
- 实现：`content/<article_id>/index.md`；一次发布一个 Git commit；数据库只保存 commit SHA、内容 SHA-256、应用作者和派生状态。
- 一致性：`publish_requests` 状态机 + commit trailer + webhook inbox + 定时对账；读取必须指定 commit SHA。
- 安全：两个最小权限 GitHub App，只安装目标仓库；路径 allowlist；禁止 PAT。
- 验证：GitHub 故障/响应丢失/并发发布测试；commit 与数据库 hash 对账。
- 回退：关闭发布入口但保留草稿/阅读；未来存储适配器迁移时文章 ID/URL 不变。
- 复审触发：API 限额持续影响 SLO、仓库体积超阈值、组织合规禁止 GitHub。

### ADR-002：平台本地用户名密码认证

- 状态：Accepted。
- 决定：管理员建号/重置，无自由注册；服务端不透明 session cookie。
- 密码：Argon2id；参数由目标硬件基准测试确定，使单次校验达到安全评审目标且不压垮登录容量。保存算法和参数，支持登录后渐进 rehash。
- session：浏览器只持 256-bit 随机 token；数据库仅保存 token hash。Cookie 为 `HttpOnly; Secure; SameSite=Lax; Path=/`，登录/改密后旋转；首次改密、停用和管理员重置撤销相关会话。
- CSRF：所有状态变更请求验证独立 CSRF token 和 Origin/Referer；SameSite 不是唯一防线。
- 防爆破：账号 + IP 双维度节流、递增冷却、通用失败提示；审计不记录密码、token 或用户名是否存在。
- 授权：每个接口执行记录级策略；UI 隐藏按钮不构成授权。
- 恢复：首个管理员凭证必须通过已批准的带外通道一次性交付，首次登录强制改密。
- 复审触发：跨系统身份、成员规模扩大或合规要求出现时评估 OIDC/SSO。

### ADR-003：草稿、分类和索引不提交 Git

- 状态：Accepted。
- 决定：草稿是数据库事实；发布原文是 GitHub 事实；分类和搜索是按 commit SHA 派生数据。
- 实现：自动保存仅更新 `drafts.revision`；发布后数据库不把正文用于展示，只保留可重建搜索文档。
- 一致性：所有派生表携带 commit SHA/content hash；对账可删除并重建派生数据。
- 备份：数据库 PITR + 对象存储生命周期；内容仓库独立备份/镜像。恢复演练必须验证二者时间点差异。
- 验证：自动保存 Git commit 计数为 0；清空派生索引后可从 GitHub + 分类数据重建。
- 复审触发：恢复时间目标无法满足或双存储不一致率超门槛。

### ADR-004：Markdown 优先编辑器

- 状态：Accepted。
- 决定：单一 Markdown 编辑模式 + 实时预览 + 工具栏，不做富文本双向转换。
- 安全：预览和详情共用同一解析/净化策略；默认禁用原始 HTML，链接协议 allowlist，外链图片策略和附件 MIME/魔数双校验。
- 数据：标题进入平台管理 front matter，正文保持独立字节区段；发布模板不得静默改写作者正文。UTF-8/LF 规范化和三类 hash 规则固定并做回读校验。
- 并发：revision/ETag 乐观锁；浏览器本地恢复副本只作故障兜底，不能覆盖服务器新版本。
- 验证：XSS corpus、超大文档、代码块、中文、附件失败、多窗口冲突。
- 复审触发：试点中非技术作者完成率明显不足。

### ADR-005：受控分类 + 动态标签

- 状态：Accepted。
- 决定：7 个固定内容类型；主题/项目由管理员维护；标签由 Agent 生成 2～5 个。
- 稳定性：taxonomy node 使用不复用的 UUID；停用不删除；每次变更产生 taxonomy version。
- 输出：模型只能返回当前版本允许 ID；项目可空；动态标签做 Unicode/大小写/空白归一并保留原值。
- 决策：任一必填维度置信度低于可配置阈值（初始 0.80）进入 needs_review；阈值变更留审计。
- 验证：未知 ID、停用 ID、同义/大小写标签、旧 taxonomy 结果、人工纠正时正文 hash 不变。
- 复审触发：纠正率、待确认积压或分类导航效果持续不达目标。

### ADR-006：服务端 OpenAI-compatible 模型适配层

- 状态：Accepted。
- 决定：模型配置只在服务端，供应商实现置于 adapter 后；业务只依赖 `classify(input): ClassificationResult`。
- 输入：指定 commit 的标题/正文、允许的分类 ID、版本；附件不发送。正文标为不可信数据。
- 输出：严格 JSON Schema，`additionalProperties: false`；不接受摘要、补丁或工具调用；reason 不超过 80 汉字。
- 安全：先做密钥/敏感信息检测；命中时不发送外部模型并转人工。请求/响应日志不含正文；只记录 ID、版本、token/费用统计、耗时、错误码。
- 可靠性：连接/总超时、响应大小上限、最多 3 次可重试错误、熔断和 AI kill switch。关闭 AI 不影响写作、发布、阅读、搜索。
- 评估：固定 golden set、Schema 合规率、一级分类准确率、纠正率和供应商契约测试。
- 复审触发：数据条款/成本/SLO 变化，或兼容接口行为无法被 adapter 收敛。

## 8. API、错误与数据契约

API 初稿见 `openapi-v0.1.yaml`，数据库初稿见 `schema-v0.1.sql`。

统一约定：

- base path `/api`；JSON UTF-8；时间为 RFC 3339 UTC；ID 为应用生成 UUID。
- 状态变更响应包含 `request_id`；错误格式为 `{code,message,request_id,details?}`，message 不泄露内部信息。
- `POST /drafts/{id}/publish` 必须携带 `Idempotency-Key`；草稿 PATCH 使用 `If-Match` 或 body revision。
- 浏览器认证为安全 Cookie；所有状态变更携带 `X-CSRF-Token`。
- 列表使用 cursor 分页，不用不稳定 offset；排序字段有固定 tie-breaker。
- 文章详情返回精确 commit SHA；不能让客户端传任意仓库路径/SHA 越权读取。
- webhook endpoint 不使用 session/CSRF，而使用 GitHub HMAC 和 repository allowlist。

关键错误码：

| HTTP    | code                                                                | 语义                               |
| ------- | ------------------------------------------------------------------- | ---------------------------------- |
| 400     | VALIDATION_ERROR                                                    | Schema/字段非法                    |
| 401     | AUTH_REQUIRED / INVALID_CREDENTIALS                                 | 未登录或登录失败；登录提示保持通用 |
| 403     | FORBIDDEN / FIRST_PASSWORD_CHANGE_REQUIRED                          | 无记录级权限或需先改密             |
| 404     | RESOURCE_NOT_FOUND                                                  | 不暴露无权资源是否存在             |
| 409     | DRAFT_VERSION_CONFLICT / IDEMPOTENCY_CONFLICT / PUBLISH_IN_PROGRESS | 并发或幂等冲突                     |
| 422     | CONTENT_NOT_CLASSIFIABLE                                            | 空正文/仅附件等需人工处理          |
| 429     | RATE_LIMITED                                                        | 登录或业务限流                     |
| 502/503 | GITHUB_UNAVAILABLE / MODEL_UNAVAILABLE                              | 外部依赖故障；不得丢草稿           |

## 9. 测试分层与 T01 门禁

| 层       | 覆盖                                                   | T01 最低门禁                          |
| -------- | ------------------------------------------------------ | ------------------------------------- |
| 静态     | format、lint、TypeScript strict、依赖漏洞、secret scan | 全部通过；禁止跨模块私有 import       |
| 单元     | 状态机、授权策略、hash/路径、重试分类                  | 领域核心分支覆盖并含失败分支          |
| DB 集成  | migration、约束、锁、job claim、审计 append-only       | 在真实 PostgreSQL 容器运行            |
| 外部契约 | GitHub App token/API/webhook、模型 JSON Schema         | fake server 全量；真实 sandbox 待授权 |
| 组件     | 每个模块经 HTTP/application service + DB               | 认证、草稿、发布状态、分类最小闭环    |
| E2E      | 浏览器登录→草稿→发布→阅读→分类                         | T01 先跑 smoke；后续任务逐步扩展      |
| 安全     | 越权、CSRF、XSS、提示注入、密钥泄漏、重放              | 原文写权限负测为不可豁免门禁          |
| 韧性     | GitHub/model 超时、429、响应丢失、worker 崩溃          | 幂等发布和任务 lease 可重复验证       |

T01/OWN-75 验收：

1. `docker compose` 或等价开发配置可重复启动 PostgreSQL、web-api、worker 和 fake external services。
2. 空库 migration up 成功；从上一 migration 升级成功；失败 migration 不留半状态。
3. `/health/live` 正常；数据库断开时 readiness 明确失败；GitHub/model 未配置时为 degraded 而非泄密崩溃。
4. worker 双实例并发 claim 不重复完成同一 dedupe job；崩溃后 lease 可恢复。
5. OpenAPI lint、生成类型漂移检查、单元/集成/E2E smoke 有统一命令。
6. 缺 secret 时 fail closed；日志/测试快照不含 secret 或正文。
7. 同一制品可分别以 api/publish/classify/reconcile 角色启动，且未注入的 secret 无法访问。

## 10. 外部输入与决策表

| 决策/输入            | Owner                          | 所需值                                      | 阻塞                       | 建议默认值                         | 安全边界                                 |
| -------------------- | ------------------------------ | ------------------------------------------- | -------------------------- | ---------------------------------- | ---------------------------------------- |
| 应用实现仓库         | 产品 Owner + GitHub 仓库管理员 | org、repo、默认分支、维护者                 | T01 提交/PR、后续全部编码  | 新建独立私有仓库                   | 未授权前只交付附件，不改现有仓库         |
| 内容仓库             | 产品 Owner + 仓库管理员        | org、repo、repo ID、默认分支                | GitHub PoC、T04+           | 新建独立私有仓库                   | Only selected repository；成员无 PAT     |
| GitHub Apps          | 仓库管理员 + 安全负责人        | 两个 App、installation ID、轮换人           | 真实 PoC、发布/分类        | Publisher RW + Reader R            | secret 不进前端/仓库/日志                |
| webhook              | 基础设施 + 仓库管理员          | HTTPS URL、secret、允许 repo/ref            | 同步 PoC、T10              | `/api/webhooks/github` + push      | HMAC、delivery 去重、10 秒内应答         |
| 运行平台             | 基础设施负责人                 | 容器平台、区域、CPU/内存、出口策略          | T01 部署、估算             | 同镜像多角色                       | 非 root、只读 FS、最小出口               |
| PostgreSQL           | DBA/基础设施                   | 18 可用性、HA、PITR、连接上限               | T01 部署及全部数据能力     | PostgreSQL 18 当前 minor           | TLS、独立角色、备份恢复演练              |
| 草稿附件存储         | 基础设施 + 安全                | S3-compatible endpoint/bucket/保留期        | T03 图片/附件              | 生产私有对象存储；开发本地 fake    | 私有、加密、短期孤儿清理、下载鉴权       |
| 域名/HTTPS           | 基础设施                       | 域名、证书、代理头约定                      | 登录 Cookie、webhook、试点 | 单一内部域名                       | Secure cookie、HSTS、可信代理白名单      |
| secret manager       | 安全/基础设施                  | 产品、引用格式、轮换流程                    | T01 生产、GitHub/模型      | 平台托管 secret manager            | 只注入需要的进程，不以普通 env dump 输出 |
| 首个管理员           | 产品 Owner + 安全              | 用户名、带外交付方式                        | T02 验收                   | 一次性随机初始密码                 | 不在 issue、聊天、日志中提交真实密码     |
| 主题/项目/知识管理员 | 产品 Owner                     | 初始节点、稳定 ID、管理员名单               | T06/T07                    | 7 内容类型固定；主题/项目最小集    | 不让模型创建受控值                       |
| 模型服务             | 产品 Owner + 安全/法务         | base URL、model、数据条款、地域、保留、预算 | 真实 T07                   | OpenAI-compatible；未批准则 AI off | 不把真实正文发送到未批准服务             |
| 分类阈值/限制        | 产品 + 知识管理员              | 0.80 是否批准、文档/标签上限                | T07 验收                   | threshold 0.80、tags 2～5、retry 3 | 配置变更审计，可快速关闭 AI              |
| 搜索语言/SLO         | 产品 + 基础设施                | 中文占比、规模、P95 目标                    | T09 技术验收               | PostgreSQL `pg_trgm`               | 权限先过滤；索引可删除重建               |
| 试点与评测集         | 产品 Owner + 安全              | 10～20 人、最多 100 篇、授权范围            | 离线评估、灰度放行         | 不足 100 用全部并披露样本量        | 脱敏、最小访问、不可发未批准模型         |
| RPO/RTO/保留期       | 产品 Owner + DBA/安全          | DB/对象/审计保留与恢复目标                  | T10 上线门禁               | 需明确，本文不擅自假设             | 没有恢复演练不得生产放量                 |

## 11. 开工清单与风险

T01 开工前至少需要确认应用仓库和目标运行平台。若仅需要本地骨架，可以在新建的明确授权仓库中用 fake 服务开工，但真实 GitHub/model 集成继续保持关闭。

上线前不可降级风险：

- Reader/Classifier 获得 Contents write。
- webhook 未验签、未按 delivery ID 去重或接收任意仓库/ref。
- GitHub commit 未成功就显示 published。
- 幂等 key 可对应不同输入，或并发发布会 force push。
- Markdown/附件没有净化和记录级授权。
- 日志、错误、健康检查回显正文或 secret。
- 搜索结果/固定 URL 没有执行与文章读取相同的权限策略。
- 无数据库与内容仓库的联合恢复演练。

## 12. 官方依据

- Node.js release schedule: https://nodejs.org/en/about/previous-releases
- PostgreSQL versioning policy: https://www.postgresql.org/support/versioning/
- NestJS Fastify adapter: https://docs.nestjs.com/techniques/performance
- GitHub App permissions: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app
- Git data trees/commits/refs: https://docs.github.com/en/rest/git/trees
- Webhook validation: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
- Webhook best practices: https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks
- OpenAPI specification: https://spec.openapis.org/oas/v3.1.2.html
