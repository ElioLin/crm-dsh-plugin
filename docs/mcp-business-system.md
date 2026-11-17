# 业务系统随场景同步到 MCP：现状与改造清单

本文对应插件 **场景工作台 v1.8.0**。它说明「业务系统」为什么需要同步、当前用哪种方式已经能完整往返、
以及控制平面（`sfoa-enterprise-mcp`）还需要做哪些改造才能把它升级成可筛选、可统计的一等字段。

## 1. 为什么必须同步

插件 v1.7.0 起，每张场景卡片都有一个**必填**字段 `businessSystem`（CRM / TAPD / 其他，或任何自定义系统名，
≤32 字符），它决定两件事：

1. 进入场景时落到哪个工作区（`<workspaceRoot>/<businessSystemKey>`，没有就建）；
2. 面板的过滤维度（原来按「业务分类」，现在按业务系统）。

如果它只存在本地，那么一张公司标准场景被推到服务端、再到另一台机器拉下来时，业务系统会退回 `CRM`
（`fromRemoteScenario` 的兜底值），用户看到的是「明明建的是 TAPD 场景，装下来变成 CRM，还跑到了 CRM 的工作区」。

图标 `icon` 也是同一类问题：`fromRemoteScenario` 一直在读 `icon`，但 1.7.x 的写回里没有它，
「推上去再拉回来」图标会被重置成默认值。

## 2. 当前实现（v1.8.0，已可用，无需服务端改动）

`lib/core/registry.js` 的 `toRemoteWritePayload` 把这两个字段放进 **`scenarioPayload`**，而不是请求体顶层：

```js
const scenarioPayload = {
  pinnedSkills: [...],
  welcomeMessage: '',
  inputDraft: '',
  prePinnedContext: {...},
  sourceType: 'COMPANY_STANDARD',
  readonlyForNormalUser: true,
  businessSystem: 'TAPD',   // 空值不写，避免把「未填写」当成一次清空
  icon: 'workflow',
};
```

原因在控制平面的契约里：

- `packages/sfoa-control-plane/src/dsh-scenario-contracts.ts` 的 `dshScenarioCreateSchema` /
  `dshScenarioUpdateSchema` 是 `.strict()`：**顶层多一个键就 400**；
- 同一个文件里的 `dshScenarioPayloadSchema` 是 `.passthrough()`，注释明说
  「the server is a store, not a schema owner for the client UI」，插件自有字段原样保存与返回；
- 插件侧 `fromRemoteScenario` 的 `pick()` 是 `payload[key] ?? source[key]`，**先读 payload 再读顶层**，
  所以放进去就能完整往返。

结论：**业务系统与图标今天已经能同步，不需要服务端先改契约。** 服务端只要继续 `passthrough`、不要清洗 payload 即可。

## 3. 建议的改造（控制平面，可选但推荐）

放在 payload 里的代价是服务端「看不见」它：不能按业务系统查询、不能做统计、管理后台也没有这一栏。
要做到这些，需要把它提升为顶层一等字段。

### 3.1 契约（`packages/sfoa-control-plane/src/dsh-scenario-contracts.ts`）

```ts
export const dshBusinessSystemSchema = z.string().trim().min(1).max(32)
  // 与插件一致：不能含 \ / : * ? " < > |，它会作为工作区目录名
  .refine((v) => !/[\\/:*?"<>|]/u.test(v), 'businessSystem must not contain \\ / : * ? " < > |');
```

- `dshScenarioCreateSchema` / `dshScenarioUpdateSchema` 增加
  `businessSystem: dshBusinessSystemSchema.optional()`；
- **不要**把它加进 `scenarioPayload` 的必填项，payload 继续 `passthrough()`；
- 老客户端不会发顶层字段 → 服务端按 payload 里的值兜底，再兜底 `CRM`（见 3.3）。

### 3.2 记录与查询

- `packages/sfoa-control-plane/src/contracts.ts` 的 `DshStandardScenarioRecord` 增加
  `businessSystem: string`（响应总是有值，缺省 `CRM`）；
- `dshScenarioListQuerySchema` 增加 `businessSystem?: string`，`GET /api/dsh/scenarios` 支持
  `?businessSystem=TAPD` 精确过滤（大小写不敏感）；
- 数据库：加列并回填。已有行的值从 `scenarioPayload.businessSystem` 取，取不到用 `'CRM'`；
  `revision` / `version` 的语义不变（**不要**因为这次迁移给每行 +1）。

### 3.3 归一化优先级（必须写清，否则两边会打架）

服务端读一个场景的业务系统时，按这个顺序取值：

1. 请求体顶层 `businessSystem`（新客户端）
2. `scenarioPayload.businessSystem`（v1.8.0 客户端）
3. `'CRM'`（1.7.0 之前的场景）

写回响应时，**顶层与 payload 两处都带上同一个值**：老插件的 `pick()` 先读 payload，新插件读顶层，
两边都能拿到，且不会因为服务端「搬字段」而丢数据。

### 3.4 管理后台（`packages/sfoa-admin-web`）

- 新建/编辑标准场景的表单增加「业务系统」输入（必填，`datalist` 建议值 `CRM / TAPD / 其他`，允许自定义）；
- 场景列表增加「业务系统」列与筛选；
- 校验文案与插件保持一致：`业务系统必填：例如 CRM / TAPD / 其他，也可以填自己的系统名`、
  `业务系统不能超过 32 个字符`、`业务系统名不能包含 \ / : * ? " < > | 这些字符（它会作为工作区目录名）`。

### 3.5 测试

- `packages/sfoa-admin-api/src/test/dsh-scenarios.test.ts`：创建/更新带 `businessSystem` 往返；
  不传时响应返回 `CRM`；非法值（35 字符、含 `/`）返回 `DSH_SCENARIO_INPUT_INVALID`；
- `packages/sfoa-control-plane/src/test/dsh-scenario-service.test.ts`：payload 里的 `businessSystem`
  被提升为顶层字段；payload 里的未知键仍然原样保留（`passthrough` 不能被收紧）；
- 迁移测试：老行（只有 payload 里的值）迁移后顶层与 payload 一致。

## 4. 给负责 MCP 侧改造的智能体的 Prompt

> 直接复制下面整段作为任务描述。

---

**任务：把「业务系统」与「图标」提升为 DSH 标准场景的一等字段（`sfoa-enterprise-mcp` 仓库）**

背景：DSH 插件「场景工作台」v1.7.0 起每张场景卡片都有必填的 `businessSystem`（CRM / TAPD / 其他 / 自定义，
≤32 字符，会作为工作区目录名），它决定进入场景时落在哪个工作区；v1.8.0 起插件已通过
`scenarioPayload.businessSystem` 与 `scenarioPayload.icon` 把它同步到 MCP（利用 payload 的 `passthrough()`），
所以**数据已经在往返**，但服务端看不见它：不能按业务系统筛选、不能统计、管理后台也没有这一栏。

请按下面的顺序改造，保持向后兼容：

1. 先读这三个文件，确认现状（不要凭猜测改契约）：
   - `packages/sfoa-control-plane/src/dsh-scenario-contracts.ts`（顶层 `.strict()`、payload `.passthrough()`）
   - `packages/sfoa-control-plane/src/contracts.ts`（`DshStandardScenarioRecord`）
   - `packages/sfoa-control-plane/src/dsh-scenario-service.ts`（归一化与 revision 语义）
2. 契约层：新增 `dshBusinessSystemSchema`（trim、1–32 字符、拒绝 `\ / : * ? " < > |`），
   在 create / update 两个对象里加 **optional** 的 `businessSystem`，**不要**改动 payload schema 的
   `passthrough()`（插件还依赖它存 `icon` 与未来的自有字段）。
3. 记录层：`DshStandardScenarioRecord` 增加 `businessSystem: string`；读取优先级
   ① 顶层 `businessSystem` → ② `scenarioPayload.businessSystem` → ③ `'CRM'`；
   写响应时**顶层与 payload 都带上同一个值**（保证 1.8.0 老插件用 `pick()` 先读 payload 仍能拿到）。
4. 存储层：加列 + 回填（老行从 payload 取，取不到用 `CRM`）；**不要**因为迁移给 `revision` 或 `version` 加一。
5. 查询层：`GET /api/dsh/scenarios` 支持 `?businessSystem=X` 精确过滤（大小写不敏感），
   并在 `dshScenarioListQuerySchema` 里加 `businessSystem?: string`。
6. 管理后台（`packages/sfoa-admin-web`）：新建/编辑标准场景表单加「业务系统」（必填，`datalist`
   建议 `CRM / TAPD / 其他`，允许自定义），列表加该列与筛选；校验文案与插件一致
   （`业务系统必填：例如 CRM / TAPD / 其他，也可以填自己的系统名` 等三条）。
7. 测试：创建/更新带 `businessSystem` 往返；缺省返回 `CRM`；非法值（35 字符 / 含 `/`）返回
   `DSH_SCENARIO_INPUT_INVALID`；payload 里的未知键仍原样保留；老数据迁移后顶层与 payload 一致。
8. 文档：更新该接口的契约文档（字段含义、取值优先级、过滤参数），并在变更记录里写明
   「1.8.0 插件已经用 payload 同步，本次是把字段提升为可查询的一等字段，不是新增数据来源」。

**不要做的事**：不要收紧 `dshScenarioPayloadSchema`；不要要求客户端必须发顶层字段（老插件不支持）；
不要为了让字段出现而伪造 `version` / `revision`（服务端拥有这两个值）。
