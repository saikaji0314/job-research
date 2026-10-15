# 安卓 App 最新优先采集

此后端使用 Android 官方 ADB 和可选依赖 [uiautomator2](https://github.com/openatx/uiautomator2) 3.7.0，在使用者已登录的 BOSS App 中操作搜索、最新排序、详情展开和复制链接。无需模型 API，不接入联系、消息、投递或简历发送操作。

## 准备和运行

需要 Python 3.8+、安卓手机、已授权的 USB 调试连接，以及已登录的 BOSS App。首次运行时界面依赖会通过 USB 启动临时 UiAutomator 服务。手机保持解锁、BOSS 在前台；暂不支持 iPhone。

```powershell
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements-android.txt
node src/cli/index.js collect-app --config config/research.local.json --limit 300 --target-matched 50 --python .venv/Scripts/python.exe --adb-path "ADB可执行文件路径"
```

城市需已在 App 搜索中选好，程序核对其与输入条件一致，未实现自动更改城市。关键词支持中文，通过控件输入，不使用 adb input text 猜测 Unicode 支持。`--device` 可在多设备时指定手机，只用于当前进程，不写入批次配置。其他求职资格仍来自本地通用配置。

`collect-app` 显式使用 source=android-app、searchSort=latest。每个关键词搜索后重新选择并核对“最新优先”；切换关键词或提交筛选面板可能重置排序，不能仅在首次设置。它是平台按词返回的顺序，不保证跨关键词的全局时间排序或首次上架日期。

## 原生筛选与本地筛选

collection.appFilters 支持以下输入，公共默认值不包含求职者偏好：

| 字段 | 含义 |
| --- | --- |
| experienceInclude | App 经验选项数组，可多选；空数组表示不限制。可选在校生、应届生、经验不限、1年以内、1-3年、3-5年、5-10年、10年以上 |
| bossActivity | null 表示不限制；today、within3days、thisWeek、thisMonth 对应平台今日、3日内、本周、本月活跃；不自行换算自然周为滚动天数 |
| showContactedWithin30Days | true 显示、false 隐藏；null 保留当前值并记录实测状态 |

每词应用后重新打开面板核对六个分类和沟通过职位开关，再核对最新排序。App 学历、薪资、规模、融资阶段设为不限，避免继承上次手动筛选。学历和薪资按 preferences 在本地判断：只勾某一学历可能漏掉更低最低要求，平台薪资单选档位也无法精确表达任意区间。

开关在当前 App 中没有可靠的 checked 属性，使用自身截图区域中白色滑块的位置判断；图像不明确即暂停。不会把 selected=false 当成关闭。真实设备上的打开状态已核验；关闭状态只有离线视觉测试覆盖。核验记录保存于批次摘要 app.verifiedConditions，未通过核验不会采集该词。

`--limit` 是原始列表线索指纹预算，1～500；`--target-matched` 只计算严格 matched。默认按词分配列表预算，并受 maxScrollsPerKeyword 限制。正文读取仍按 detailIntervalMs 间隔、并发为 1。目标未达到时，摘要和终端明确说明，不扩大预算凑数。

恢复同一批次使用原条件，不重复已完成的关键词：

```powershell
node src/cli/index.js collect-app --resume "批次ID" --python .venv/Scripts/python.exe --adb-path "ADB可执行文件路径"
```

## 正确性与证据

1. 在关键词、城市和最新优先状态全部一致时，读取卡片并保存必要列表字段。列表指纹不冒充平台岗位 ID。
2. 对薪资、学历、年限等已明确冲突的线索先排除，保留列表审计证据；未知记录继续核实。
3. 打开详情后等待标题、公司及正文就绪，核对标题和公司简称。有限去除已观察到的列表标题末尾装饰字符，原文另存。
4. 折叠 JD 需实际展开；无法展开、字段缺失或身份不符不能声称正文完整。
5. 复制链接前写入临时剪贴板标记，确认新复制的官方链接含岗位 ID；丢弃分享追踪参数。直接读取刚复制的链接，不向搜索框粘贴链接，不安装辅助输入法。
6. 返回后再次核对原关键词、城市与最新排序。状态改变、断连、锁屏、平台验证或未知界面会停止并导出已有结果，不猜按钮继续操作。

`jobs.csv` 仅含取得岗位 ID、完整正文并通过条件的记录。挑战、待核实和已排除另表导出。预排除、缺少岗位链接或详情失败的卡片保留在 `app-list-observations.jsonl`，不编造 ID 混入正式表。指纹去重不能证明两条线索一定是两个平台岗位；最终正式岗位按真实 ID 去重。

App 原文的“今日／昨日新发布”等可保存在 publicationLabelRaw，保留采集时间；本版本不提供“30 天内发布”的过滤或精确日期推断。用工类型仍依赖明确正文证据，未核实不算直招。

真实设备差异可能影响控件、剪贴板、正文展开或恢复行为；小批样本成功不代表所有设备、App 版本或长期批量访问均可用。出现平台验证即停止，由使用者处理，不绕过或持续重试。
