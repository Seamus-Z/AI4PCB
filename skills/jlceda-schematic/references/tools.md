# MCP工具契约

MCP服务名 `jlceda-schematic`，stdio传输。以下是封闭操作集，没有eval、shell或任意SDK转发。

| 工具 | 输入要点 | 作用 |
|---|---|---|
| `jlc_status` | 空对象 | 认证连接、写入门、不确定状态、原生当前工程/页和能力 |
| `jlc_search_devices` | `query`, 可选`limit` | 官方SDK库DEVICE检索；必须核对型号，不依赖上次项目UUID |
| `jlc_snapshot` | `projectUuid,pageUuid` | 当前明确目标页的真实元件、采购属性、pin、NC、端口、分段导线、文字 |
| `jlc_create_project` | `name`, 可选`teamUuid` | 备份当前工程后新建工程/板/原理图/首页，不覆盖原工程；切换前须保存GUI编辑 |
| `jlc_plan` | `projectUuid,pageUuid,operations` | 检查并暂存计划，返回错误/警告、快照指纹、单次planId；不是写入完成 |
| `jlc_apply` | `planId` | 重新核验状态，保存原生备份和意图日志，再串行执行一次并回读 |
| `jlc_export_project` | `projectUuid` | 原生epro2落盘到配置输出目录 |
| `jlc_export_pdf` | `projectUuid,pageUuid` | 当前原理图全部图页的原生合并PDF落盘 |
| `jlc_netlist` | `projectUuid,pageUuid` | 实际PADS网表及落盘文件 |
| `jlc_drc` | `projectUuid,pageUuid` | 实际原生DRC摘要；不把零错误等同于硬件可用 |

创建工程、规划、应用均要求启动时 `JLCEDA_ENABLE_WRITES=1`。默认配置为0，修改后须重启服务。导出不改电路拓扑，允许只读模式使用。所有页级工具均要求该页已在EDA激活且属于指定工程；不会偷偷跳到别的工程。快照为修正某些SDK版本导出网表时改变焦点的行为，会重新激活已明确指定的原页。

## operations

全部坐标是屏幕坐标，+Y向下，允许原始小数。旋转值使用0/90/180/270。

- `component.create`: `device:{uuid,libraryUuid},ref,x,y,rotation?,mirror?,value?`。正式库DEVICE。第一批放置后读真实引脚，再布线。
- `component.move`: `ref,x,y,rotation,mirror`。保留采购/自定义属性。旋转镜像变更与布线分批。
- `marker.create`: `marker,net,x,y,rotation?`；marker为 `Ground/Power/AnalogGround/ProtectGround/IN/OUT/BI`。
- `wire.create`: `net,points:[[x,y],...],label?`。非零正交路径。默认可命名；与同名原生标识直接相连时避免重复命名。`label:false`只有已存在物理连接提供正确网名时使用，读回必须仍匹配net。
- `pin.nc`: `ref,pin,enabled`。真实pin属性，不是新增符号。
- `wire.delete` / `marker.delete`: `ids`。精确原生ID列表；不提供任意器件删除/整页清空。
- `text.create`: `x,y,text,size?`。
- `module.create`: `left,top,right,bottom,title`。仅非电气框和标题。

## 稳定性与安全

- 默认15分钟计划有效期；快照/连接会话变化、超期、已尝试应用均使旧计划不可用。
- 原生编辑不是事务。服务在部分错误、断线或超时时保守锁住写入；超时不能取消正在编辑器内运行的脚本。
- 不确定时：停发写入，等编辑器静止，检查 `outputs/` 中备份、意图、失败日志与实际图面；需要时用备份恢复到新工程；确认现场后重启服务重新读取快照。不要直接重发。
- 回读原生分段覆盖和网名，不以“返回了一个ID”代替持久性证明。引脚网名来自实际PADS，空的独立线网不伪造名称。
- 导出/备份仅写入固定输出目录，文件名由服务生成；客户端不能指定任意写入路径。目录包含电路设计资料，按工程密级保管。
- localhost不是对同机恶意程序的沙箱。桥接只绑定127.0.0.1并要求随机secret；只接受显式信任的Origin和单一编辑器。不要公开CDP、LAN桥接或把配对secret放进共享包。
- 官方API中部分方法仍为beta，版本升级必须重跑真实示例。自动几何检查不提供可靠的官方符号本体/文字边框；零穿器件、无标签遮挡必须看实际原生图面。
- 不提供文字删除/修改：已观察到SDK画布删除与原生导出缓存不一致。本工具不会自动修补原始epru电气记录，也不静默执行缓存修复。

## Skill使用方式

将整个 `jlceda-schematic` 目录放入所用代理的skills目录，保留 `references/`。MCP服务单独按工具包README安装并导入其生成的客户端配置。Skill不内嵌secret、用户路径或项目UUID；MCP不可用时只能分析，不能声称已修改原生工程。
