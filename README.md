# AI4PCB — 嘉立创原理图复用工具包

本仓库是 [AI_lab](https://github.com/Seamus-Z/AI_lab) 下的 PCB 领域项目，以 Git submodule 挂载于 `AI_lab/AI4PCB`；也可独立克隆 `git@github.com:Seamus-Z/AI4PCB.git` 使用。主仓库只记录本仓库的提交，不复制工具源码。

面向**不同新项目**的 Skill、stdio MCP、基于官方 `eda.*` API 的本地扩展与验收工具。不是把某个历史工程的脚本换个文件名：服务、Skill、示例都不依赖其路径、工程UUID、器件编号或页数。

**MCP与桥接扩展是本工具包实现，不是嘉立创官方发布的MCP。底层原生电气对象与接口来自嘉立创EDA专业版官方扩展API。** 不依赖CDP、私有网页模块入口、供应商账号密钥或第三方MCP的任意eval接口。

> **验证边界：** 46项回归测试、全新目录安装/配对、真实编辑器连接、七页原生读回、网表一致性及只读保护已通过。新工程写入验收在嘉立创在线创建阶段被“网络错误！”阻断，两个示例的原生放件/连线、PDF图面和重新导入尚未完成实机验收；本包不把这些项目标成已通过。详见[核验记录](verification/result.json)。

## 文件入口

| 路径 | 用途 |
|---|---|
| `skills/jlceda-schematic/SKILL.md` | 给代理使用的完整工程流程 |
| `skills/jlceda-schematic/references/` | 可一起复制的工具契约与布局规则 |
| `src/server.mjs`、`src/tools.mjs`、`src/bridge.mjs` | 标准stdio MCP、闭合工具集、认证桥接、计划与备份 |
| `extension/` | 本地扩展源码及清单，直接调用官方SDK |
| `src/geometry.mjs` | 正交线/异网接触/NC/变换阶段检查，PADS成员比较 |
| `src/archive.mjs`、`scripts/inspect-project.mjs` | epro2/epru只读结构检查；不改写原始电气记录 |
| `examples/*.json`、`src/examples.mjs` | 不绑定工程UUID的RC与分压器配置及实际引脚布线 |
| `scripts/smoke.mjs` | 真实MCP客户端冒烟；可明确选择新建示例工程 |
| `package-lock.json` | 固定完整依赖树，使用npm ci复现 |
| `local/` | 本机生成的secret、MCP配置、配对扩展；禁止共享 |
| `outputs/` | 原生备份、计划/执行日志、工程、PDF、网表；按工程资料保密 |

## 安装与配对

要求：Node.js **20.20或更高版本**、npm、已登录的嘉立创EDA专业版。官方库检索/在线工程创建需要正常网络及账号权限。已验证的平台和场景以 `verification/` 记录为准，不能把测试过一个版本等同于所有未来版本都兼容。

在本目录执行：

```sh
npm ci --ignore-scripts
npm run setup
```

setup生成64位随机十六进制配对密钥，并保存在权限受限的 `local/`。再次运行保留既有配对，不悄悄更换密钥。扩展由同一源码构建，不下载其他作者的MCP二进制。

1. 在嘉立创 **V3：高级 → 扩展管理器 → 导入**，选择 `local/JLCEDA-Schematic-Bridge.eext`。V2旧文档的“设置 → 扩展”不是本次实测V3入口。
2. 切到“已安装”，等待列表加载，选择 **Schematic Toolkit → 配置**，仅为本工具启用“允许外部交互”。建议勾选“显示在顶部菜单”；不勾时入口在“高级”下。不要为不相关扩展开权限。
3. 将 **`local/mcp.json`** 中的完整 `mcpServers.jlceda-schematic` 配置导入所用MCP客户端。它由本机实际Node路径和工具包绝对路径生成，不需要手工猜路径。没有擅自修改其他客户端的全局配置。
4. 客户端启动MCP后，在EDA选择 **Schematic Toolkit → Connect MCP**，再调用 `jlc_status` 确认 `bridge.connected=true`。点击菜单只登记连接意图，必须等认证实际完成，不能把点击成功当作已连接。
5. 默认只读。确定在新工程/副本操作时，在客户端该服务环境中将 `JLCEDA_ENABLE_WRITES` 改为 `1`，重启该服务并手动Connect。原生编辑不是事务，不可在执行过程中点击重新连接。

**同一端口只启动一个服务。** MCP客户端本身会启动stdio进程，不要同时再执行 `npm start` 抢占端口。`npm start`只是直接启动入口，不是另一个需要常驻的配套服务。

更新扩展后，编辑器可能保留旧函数缓存、并重新禁用外部交互权限：重新确认本工具权限，刷新编辑器后再Connect。若提示登录过期，先恢复EDA登录/刷新会话；不要反复重发写入。

## Skill安装

把整个 `skills/jlceda-schematic` 目录复制到目标代理支持的skills目录，保留其 `references/`。文件是自包含的，没有对本机绝对路径的引用。不同代理的发现目录不同，本包不擅自覆盖全局Skill或MCP配置。

之后向代理说明电路目标/输入文件，并要求使用 `jlceda-schematic` Skill与 `jlceda-schematic` MCP。只读时先完成器件、引脚、网络和模块规划；写入按Skill中的两阶段流程执行。

## 新项目的固定流程

1. 保存正在编辑的所有文档；新设计创建新工程，旧设计先复制工程。官方 `openProject` 警告会丢失未保存数据，导出备份不等于对未提交GUI状态的事务保证。
2. status / snapshot / netlist / DRC建立基线。每次明确工程与页，不自动跨工程定位。
3. 检索正式库DEVICE并核对型号；先计划并放置器件，读取实际引脚坐标，再计划导线/GND/端口/NC。旋转镜像也单独阶段完成。
4. `jlc_plan` 审查后 `jlc_apply` 一次。状态变化、计划过期、执行尝试后都重新读取快照；不能重用planId。
5. 比较实际PADS每个网络的 `REF.pin` 成员，运行原生DRC，查看每页原生PDF，再在新工程导入最终epro2回读。

十个工具及operations完整字段见 [工具契约](skills/jlceda-schematic/references/tools.md)。目标坐标统一为屏幕 **+Y向下**；适配器只在SDK边界反转一次，保留半格引脚，不能自己取整。

## 可重复验证

不连接编辑器的安全/几何回归：

```sh
npm test
```

真实编辑器只读冒烟（独占桥接端口，启动后在EDA手动Connect，最多等待120秒）：

```sh
npm run smoke
```

网络和编辑器在线新建恢复后，可运行完整写入验收：**明确新建两个独立测试工程**，使用正式库的10k电阻与100nF电容，分别画RC低通和电阻分压器；执行真实NC开/关、读取引脚、布线、网表成员断言、DRC、原生工程/PDF导出：

```sh
npm run smoke -- --create
```

该命令保留测试工程与备份，不自动删除工程、不覆盖现有工程。原生PDF仍须逐页目视审查；随后把epro2导入另一个新工程做持久性回读，脚本会明确保留这两项要求，不能用自动测试代替视觉/导入证明。

器件检索条件、初始布局、元件角色、目标方向、网名和模块框从 `examples/` 中两个JSON读取，不在冒烟脚本里再维护一份。引脚坐标始终由SDK放置后回读，不写死在示例配置里。

只读检查任意本地epro2归档：

```sh
node scripts/inspect-project.mjs path/to/design.epro2
```

检查器处理epru重复文档头、记录覆盖、空/null删除标记和已删除文档。只在内存解包所需成员，不创建归档内路径；输出文档类型/页/NC属性数量，不宣称证明电气正确性。普通解压不是修改原生电路的替代路径。

## 迁移与打包

```sh
node scripts/package-toolkit.mjs
```

在父目录生成 `JLCEDA-Schematic-Toolkit.zip`，包含源码、Skill、示例、依赖锁、测试、核验记录和逐文件 `SHA256SUMS`；排除本机 `local/` 密钥、配对扩展、`node_modules/` 与 `outputs/` 中的设计资料。迁移机器后重新运行setup，不共享本机配对文件。


## 安全与恢复

- 所有编辑器调用串行。apply前快照/连接会话必须不变，原生备份和意图日志须先落盘；新建工程切换前也先备份当前工程。
- 超时、断线或原生变更错误可能发生在部分编辑之后。服务锁住后续写入，不自动重试、不伪装成回滚成功。等待编辑器静止，核对日志/现场，必要时用备份恢复到**新工程**；确认状态后再重启MCP、读取快照并重新规划。
- 写入期间禁止人或另一自动化同时操作编辑器。快照校验不能提供与GUI并发操作之间的数据库级事务。
- WebSocket仅监听127.0.0.1，随机secret认证，拒绝后接入编辑器替换当前连接。显式Origin名单默认由setup设为官方两站点；不开放LAN或任意来源。
- `local/` 含secret，`outputs/` 含设计资料；迁移到另一机器时复制公开源码和lockfile，重新setup、导入新配对扩展，不复制本机secret。不要运行来路不明的配对eext。

环境变量：`JLCEDA_BRIDGE_TOKEN`（必需，至少32字符）、`JLCEDA_BRIDGE_PORT`（默认49831）、`JLCEDA_ENABLE_WRITES`（默认0）、`JLCEDA_OUTPUT_DIR`、`JLCEDA_REQUEST_TIMEOUT_MS`（setup设60000ms）、`JLCEDA_TRUSTED_ORIGINS`（逗号分隔精确Origin）。端口/token变更后要同步重建并重新导入配对扩展。

## 明确不做的事

不提供任意JS eval、shell、通用私有API调用；不自动选择近似器件替代精确型号；不手画GND/NC/导线冒充原生对象；不写PCB；不提供所有电路的通用自动布局或电气正确性证明。

SDK没有可靠的完整官方符号/文字边界，自动检查不能宣称零穿器件或零文字遮挡。部分官方API仍标beta，升级后必须重新实机验证。已观察到文字删除与导出缓存不同步，所以本工具没有文字删除/改写工具，也不自动修补原始epru电气记录。

官方资料：[扩展安装](https://prodocs.lceda.cn/cn/api/user-guide/using-extension.html)、[扩展清单](https://prodocs.lceda.cn/en/api/guide/extension-json.html)、[器件创建与真实引脚坐标](https://prodocs.easyeda.com/en/api/reference/pro-api.sch_primitivecomponent.create.html)、[WebSocket注册](https://prodocs.lceda.cn/en/api/reference/pro-api.sys_websocket.register.html)。
