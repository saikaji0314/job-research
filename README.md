# Job Research｜岗位采集与调研

通过输入城市、关键词、薪资、经验等条件，采集岗位列表和完整 JD，保存来源与快照，筛选并导出结果，供个人求职或招聘市场调研使用。

## 当前状态

首版 CLI 已实现：用户登录、多关键词列表采集、完整 JD 读取、身份校验、SQLite 批次与快照、中断继续、条件筛选和 JSONL／CSV 导出。25 项测试通过；首轮真实采集 30 条去重岗位，26 条取得正文，并完成 5 条页面抽查。

仅支持 BOSS，平台页面或接口变化可能影响适配。完整 JD 来自带岗位 ID 的接口响应，或经 URL、canonical 链接、标题和公司一致性核对的页面正文；无法核对时保留失败状态，列表标签不冒充正文。测试边界见 [验证记录](docs/validation.md)。

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

仓库中的 `config/research.example.json` 是通用模板，搜索城市和关键词需要填写；可选筛选项默认为未指定，不对应任何真实求职者。

实际使用时复制为 `config/research.local.json`，再填写自己的条件。该文件以及登录资料、数据库和导出结果均被 Git 忽略。实际采集数据可在本机重新筛选，无需因修改薪资条件就重新访问招聘平台；若扩大城市或搜索词范围，则需要补充采集。

| 配置 | 语义 |
| --- | --- |
| `regionName`、`keywords` | 平台搜索城市和关键词，多关键词分别执行 |
| `collection.maxUniqueJobs` | 批次去重上限 1～500；不是保证可取得数量 |
| `preferences.titleInclude` | 标题包含任一词即满足，空数组不限制 |
| `preferences.salary` | 月薪上下限，单位 K，区间有交集即满足；未知薪资待核实 |
| `experienceInclude`、`educationInclude`、`industriesInclude`、`companyScalesInclude` | 规范化后的允许值精确匹配，不推断学历等级或行业上下位关系 |
| `employment.include/exclude/prefer` | 用工类型硬条件／排除／偏好；类型 `direct`、`outsourcing`、`onsite`、`agency` |
| `excludeKeywords` | 标题、公司、标签及完整 JD 中的排除词；未取得正文时无法确认排除词不存在 |

未配置的维度不限制；未知字段进入 `review`，已确认冲突进入 `rejected`，其余为 `matched`。`matched` 仅表示满足已设置的可核对条件，不代表个人能力适配、完整 JD 已取得或确认可投。用工性质仅识别正文中的少量明确陈述；无法判断的保持 `unknown`，偏好只用于排序。

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
