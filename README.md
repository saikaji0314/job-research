# Job Research｜岗位采集与调研

通过输入城市、关键词、薪资、经验等条件，采集岗位列表和完整 JD，保存来源与快照，筛选并导出结果，供个人求职或招聘市场调研使用。

## 当前状态

0.3.1 增加可选安卓 BOSS App 后端，通过真实搜索界面的“最新优先”发现岗位；网页后端保持默认排序。支持登录后的多词采集、正文与身份核验、SQLite、恢复、资格筛选及 CSV 分组导出。网页首轮真实采集 30 条，26 条取得正文；App 已做少量真实取证，批量验证范围见 [验证记录](docs/validation.md)。

仅支持 BOSS，平台页面或接口变化可能影响适配。完整 JD 来自带岗位 ID 的接口响应，或经 URL、canonical 链接、标题和公司一致性核对的页面正文；无法核对时保留失败状态，列表标签不冒充正文。测试边界见 [验证记录](docs/validation.md)。

App 后端通过 USB 与使用者的安卓手机交互，读取界面正文及本地复制的岗位链接，不使用未核实的搜索接口参数。网页未验证支持“最新优先”，不得将默认排序结果视作最新。App 使用和边界见 [安卓采集](docs/android-app.md)。

## 首版目标

- 首个渠道：BOSS 直聘；先尝试 20～30 条岗位线索，核对完整 JD 后再扩量、增加渠道。
- 城市和岗位关键词由使用者输入，不内置特定城市、职业方向或求职者背景。
- 薪资范围、经验、学历、行业、公司规模、用工类型和排除词等通过配置表达；未设置的条件不构成筛选限制。
- 区分必须满足、排除与优先条件。缺失字段保留未知，原始采集记录保留，支持修改条件后重新筛选。
- 不同来源通过平台适配器接入，通用筛选逻辑不依赖 BOSS 的枚举值。首版只实现 BOSS，并不代表其他平台已经可用。

## 首版流程

配置搜索 → 用户完成登录 → 多关键词发现岗位 → 保存列表证据 → 逐条补完整 JD → 去重与分组 → 导出 JSONL／CSV 和批次摘要 → 人工抽查。

采用 Node.js、Patchright、SQLite、本地命令行；改编 `npe_get_jobs` 中适用的列表映射和城市解析并保留出处。配置文件输入条件，命令行覆盖常用条件；首版使用确定性规则，不需要模型 API Key。

## 安装与运行

需要 Node.js 24+、pnpm 11 和已安装的 Chrome（默认）。支持通过 `--browser msedge` 使用 Edge；使用 `chromium` 时需自行安装对应 Patchright 浏览器。本项目不使用系统日常浏览器 Profile。

在仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
node src/cli/index.js --help
Copy-Item config/research.example.json config/research.local.json
```

编辑本地配置的 `regionName` 和 `keywords`，填写实际城市和搜索词，再按需设置筛选项。城市必须能在平台城市字典中唯一识别，区县名称只能解析到所属城市，首版不执行区县级搜索筛选。

```powershell
node src/cli/index.js validate --config config/research.local.json
node src/cli/index.js login
node src/cli/index.js collect --config config/research.local.json
```

`login` 会打开独立窗口，完成登录或人工验证后自动保存会话并退出。`collect` 默认同时采集列表与详情；只采集列表可加 `--phase list`。程序顺序读取详情，默认间隔 3 秒。遇到登录失效或平台验证会暂停并导出已取得结果，不持续重试。

## 继续采集与重新筛选

以下 `批次ID` 替换为程序输出的实际 ID：

```powershell
node src/cli/index.js batches
node src/cli/index.js collect --resume "批次ID" --phase details
node src/cli/index.js collect --resume "批次ID" --phase details --retry-failed
node src/cli/index.js export --batch "批次ID" --min-salary 20
```

继续批次使用原搜索计划，已成功取得的正文不重复访问；`--retry-failed` 才会重试缺正文、失败或身份不符的记录。若需要更新已成功岗位的当前状态，应创建新采集批次，历史正文不代表当前仍可投。

重新导出不会访问招聘平台。不指定配置文件时沿用批次条件，命令行参数覆盖指定项；提供 `--config` 则以该文件的一整套配置为基础。每次导出独立保存条件和运行 ID，不覆盖旧结果。

默认数据库 `data/jobs.db`，Profile `.profiles/boss`，导出 `output/<batchId>/<runId>/`，均不纳入 Git。可通过 `--db`、`--profile-dir`、`--output` 自定义，路径相对当前工作目录解释。

## 配置与数据

仓库中的 `config/research.example.json` 是通用模板，搜索城市和关键词需要填写；个人资格与偏好默认为未指定，不对应任何真实求职者。默认启用完整正文质量门槛，缺正文记录不会进入通过清单。

实际使用时复制为 `config/research.local.json`，再填写自己的条件。该文件以及登录资料、数据库和导出结果均被 Git 忽略。实际采集数据可在本机重新筛选，无需因修改薪资条件就重新访问招聘平台；若扩大城市或搜索词范围，则需要补充采集。

| 配置 | 语义 |
| --- | --- |
| `regionName`、`keywords` | 平台搜索城市和关键词，多关键词分别执行 |
| `collection.maxUniqueJobs` | 批次去重上限 1～500；不是保证可取得数量 |
| `collection.source`、`searchSort` | 网页为 web/default；App 为 android-app/latest；不支持网页 latest |
| `collection.targetMatchedJobs` | 可选 App 严格通过目标；null 不设目标；不把挑战、待核实或原始线索计入目标 |
| `collection.appFilters` | App 经验多选、BOSS 活跃范围与沟通过职位开关，应用后重新打开核验；枚举见 [安卓采集](docs/android-app.md) |
| `preferences.titleInclude` | 标题包含任一词即满足，空数组不限制 |
| `preferences.salary` | 月薪上下限，单位 K，区间有交集即满足；未知薪资待核实 |
| `salary.periodInclude` | 允许的薪资周期：month、day、hour、year；例如仅接受月薪时填 month，不将日薪自动换算月薪 |
| `candidate.educationLevel` | 可选候选学历；按岗位最低学历与候选学历比较，例如候选本科不能通过硕士硬要求 |
| `candidate.experienceYears` | 可选候选工作年数，与岗位最低年限比较，无法解析时待核实 |
| `candidate.challengeMaxRequiredYears` | 可接受挑战岗位的最低年限上限；此类记录单列 challenge，不混入主清单 |
| `excludeInternships` | 是否排除标题或正文中明确的实习／在校专属岗位；日薪另由薪资周期条件控制 |
| `requireCompleteDetails` | 默认 true，缺正文或正文未通过身份核验时进入待核实；列表研究可显式关闭 |
| `experienceInclude`、`educationInclude`、`industriesInclude`、`companyScalesInclude` | 可选允许值精确匹配；与候选资格比较为不同功能，可分别设置 |
| `employment.include/exclude/prefer` | 用工类型硬条件／排除／偏好；类型 `direct`、`outsourcing`、`onsite`、`agency` |
| `excludeKeywords` | 标题、公司、标签及完整 JD 中的排除词；未取得正文时无法确认排除词不存在 |

个人资格配置只保存在本地文件中；空值不限制相应维度。学历比较只支持明确的最低层级，复杂组合保留未知，不推断专业、学制等其他资格。

筛选状态优先级：明确冲突 `rejected` → 信息不足 `review` → 年限超出但在允许挑战范围 `challenge` → 其余 `matched`。`matched` 仅表示通过已设结构化规则，不等于技能适配或确认可投；默认要求完整正文，但可以显式关闭该质量门槛。用工性质只识别有限明确陈述，未知不能视为直招，偏好只用于排序。公司线索辅助识别见 [后续需求](docs/backlog.md)。

## 导出文件说明

0.2.0 起 `jobs.csv` 改为仅含 matched 的通过清单，旧版同名文件曾包含全部记录。每次导出创建新目录，旧文件不会被覆盖。

| 文件 | 内容 |
| --- | --- |
| `jobs.csv` | 通过所有已设条件的记录 |
| `jobs-challenge.csv` | 年限稍高但在明确允许范围内的挑战记录 |
| `jobs-review.csv` | 需要补正文、核对薪资或其他必要信息的记录 |
| `jobs-rejected.csv` | 明确不符合至少一项条件，附原因 |
| `jobs-all.csv`、`jobs.jsonl` | 全部采集记录与筛选证据，供审计与重新筛选 |
| `summary.json` | 生效条件、各组计数和文件对应关系 |

CSV 同时提供英文状态码与中文状态、可读筛选原因、详情缺失原因及证据。优先查看 jobs.csv 和 jobs-challenge.csv；审计全集中的 rejected 不是推荐结果。

App 的列表卡片没有可直接读取的岗位 ID，明确冲突可先排除并记录在 `app-list-observations.jsonl`，其指纹仅代表观察线索。取得正文和官方分享链接后才进入正式岗位表；摘要分别统计原始线索、已核验岗位和严格通过目标。`publicationLabelRaw` 仅保存平台可见原文，不恢复已撤回的发布日期条件。

## 测试与离线演示

```powershell
node --test
node src/cli/index.js import-fixture --input test/fixtures/jobs.jsonl
```

样例全部虚构，导入后可使用相同导出命令验证筛选。默认测试不访问网络，也不启动浏览器。运行真实 Chrome 的完全拦截请求测试：

```powershell
$env:JOB_RESEARCH_BROWSER_TEST = '1'
node --test
```

该测试只使用本地伪造页面，不访问招聘平台；验证采集动作不产生发送或投递请求。

## 文档与配置

- [协作约定](AGENTS.md)
- [首版设计与数据约定](docs/design.md)
- [实施计划与验收](docs/implementation.md)
- [搜索与筛选配置示例](config/research.example.json)
- [上游参考与复用记录](docs/upstream.md)
- [开发文档与公开内容约定](docs/contributing.md)
- [验证记录](docs/validation.md)

本仓库只执行发现、详情读取、本地存储和导出；不提供打招呼、建立沟通、投递或发送简历的命令。登录资料和实际采集数据留在本机，不纳入 Git。
