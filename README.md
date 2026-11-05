# Codex 用量监控

Token Dashboard 与额度 LED 合并后的 Windows 桌面程序。仪表盘是主窗口，LED 是同一程序的悬浮窗；保留两种布局及各自的折叠/悬停展开态，共四种形态：

- HUD 折叠态
- HUD 悬停展开态
- 顶部吸附条折叠态
- 顶部吸附条悬停展开态

LED 外壳改造自 [xicunwus2025-sys/codex-led-widget](https://github.com/xicunwus2025-sys/codex-led-widget)。数据、长期额度曲线和产品身份统一由 Token Dashboard 提供。

## 显示规则

- 彩色进度条：实际剩余额度。
- 白色刻度：按窗口重置时间计算的线性理想剩余。
- 差值：`实际剩余 - 线性理想剩余`。
- 信号灯：只根据 5h / 7d 的剩余、理想差值、数据缺失和过期状态判断。
- 美元：只在两个悬停展开态显示所选范围的总用量，不显示速度，也不会改变灯色。

已移除学习型近期速度、青色速度线及其相关建议。额度不足或明显低于理想线时使用黄色呼吸灯，接近耗尽时使用红色闪烁灯，服务不可用时明确显示灰色不可用/过期状态。

## Token Dashboard 接入

小组件从本机 Token Dashboard 获取统一数据：

```txt
GET  /api/widget?usage_range=cycle_5h
GET  /api/quota-history?start=...&end=...
```

服务发现顺序：

1. `%USERPROFILE%\.codex\logs\token_speed_dashboard-agent.json`
2. `127.0.0.1:8768` 到 `8772`
3. 自动启动 Token Dashboard 后端

自动启动的可执行文件顺序：

1. 环境变量 `CODEX_TOKEN_DASHBOARD_EXE`
2. 安装包 `resources/backend/CodexTokenDashboard-Slim.exe`
3. 本仓库内的 `backend/CodexTokenDashboard-Slim.exe`
4. 开发态相邻 `TOKEN/output/CodexTokenDashboard-Slim.exe`

后端源码在 `backend/source/`，长期额度记录由后端的本地 SQLite 存储负责。

## 设置

托盘菜单中的“灯效与用量设置”支持：

- 额度告警呼吸周期
- 接近耗尽闪烁周期
- 额度刷新间隔
- 展开态美元总用量范围：当前 5h 周期、当前 7d 周期、最近 3 小时、今天、本周

HUD 上的展开按钮会打开或聚焦同一 Electron 程序内的 Token Dashboard 首页，不会再启动第二个可见程序。仪表盘“更多 → 快捷键”可设置全局“打开/关闭仪表盘”和“打开/关闭悬浮窗”，两项默认均为无。

## 本地开发

需要 Windows x64、Node.js 和 64 位 Python 3.11–3.13。首次运行先安装依赖并构建后端。

```powershell
python -m pip install -r backend/source/requirements-desktop.txt
npm install
npm test
npm run build:backend
npm run dev
```

打包 Windows 便携版：

```powershell
npm run build
```

构建先用 PyInstaller 生成后端，再用 Electron Builder 打包为 `dist/CodexTokenDashboard.exe`。

## 目录

```txt
backend/source/          # Python 后端、仪表盘前端、测试和打包配置
scripts/                 # 额度状态与接口映射验证
src/main/                # Electron 主进程、服务发现和额度纯函数
src/renderer/            # 四态紧凑 LED
src/settings/            # 灯效与美元范围设置
src/shared/              # 紧凑布局常量
```

## License

MIT
