# 上游参考与复用记录

阅读日期：2026-10-14。已改编部分 npe 列表字段映射及城市解析；get_jobs 仅用于研究字段与调用链，未复制其代码。

| 上游 | 研究快照 | 拟参考范围 | 快照许可文件 |
| --- | --- | --- | --- |
| https://github.com/exception-coder/npe_get_jobs | `21f506907a3af28ef96ba700b621c10af4263270` | 独立 Node 模块的 BOSS 城市解析、列表响应、搜索和滚动；拟保留其浏览器技术路线 | 标题 MIT，附署名等条款；实际复用时保留原文件声明 |
| https://github.com/loks666/get_jobs | `30ba81d79343a1980758a11102024394e8f7ff77` | `Boss.java` 中详情响应的字段及采集／投递分界 | PolyForm Noncommercial 1.0.0；不把其代码改标 MIT |

项目可从独立 clone 安装和运行，不依赖维护者机器上的其他仓库、私人文档或目录。本次尚不为整个新项目指定发行许可；实际公开发布前需确认原创部分的发行许可。

## 实际复用清单

`src/platforms/boss/mapping.js` 中的私用区薪资字符解码、列表字段映射及平台城市字典解析，改编自 npe 快照的 `node-services/recruitment-browser/src/platforms/boss/index.js` 和 `regions.js`。改动包括只保存允许的研究字段、剔除招聘者及安全令牌、独立详情校验，以及不依赖联系动作。

上游原许可文件完整保留于 `licenses/npe_get_jobs.LICENSE.txt`，其中还包含上游附带组件的说明；本工具没有因此引入 H2。浏览器会话、采集编排、SQLite、筛选与导出另行实现，没有接入上游的任何联系或投递模块。

上游 npe 的 18 项模拟测试已在上述研究快照通过，不计为本仓库已完成采集能力。来源与限制在本文件中维护，不引用私人调研或对话文档作为安装、开发的必要材料。
## 可选安卓界面依赖

0.3.1 通过可选 requirements-android.txt 使用 openatx/uiautomator2 3.7.0（MIT），调用其公开控件、XML、剪贴板及 USB 功能；未复制其源码。ADB 使用者可从 Android 官方 Platform-Tools 获取。本仓库不提交第三方运行时、设备标识、调试密钥或真实界面证据。
