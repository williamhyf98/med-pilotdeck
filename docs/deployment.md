# PilotDeck 部署

## Linux 生产部署

多用户（登录）模式的生产验收以 Linux 上实际运行的 bubblewrap 沙箱为准；
macOS `sandbox-exec` 仅用于开发自测。Task 8 的依赖预检只确认命令存在，
Gateway 启动时还会执行沙箱探测。真实用户 Gateway 的挂载、文档技能与越界
访问仍须在目标 Linux 机器上完成 Task 9 验收。

### 依赖

安装 Node.js 22（`>=22.13.0 <23`）与项目依赖并构建，详见
[源码安装说明](../README_SOURCE_INSTALL.zh.md)。多用户模式还需要
bubblewrap：

```bash
# Debian / Ubuntu
sudo apt install bubblewrap
# CentOS / RHEL（按目标发行版选用 yum 或 dnf）
sudo yum install bubblewrap
# Arch
sudo pacman -S bubblewrap

command -v bwrap
bwrap --version
```

`command -v bwrap` 应返回可执行文件路径；具体路径因发行版而异。
命令存在不等于沙箱可用，目标机仍需验证 Gateway 日志里的
`[sandbox] bwrap (ok)` 并执行真实多用户隔离验收。

### 环境变量

| 变量 | 作用 | 默认值 |
|---|---|---|
| `PILOT_HOME` | 系统数据根目录（`users/`、`system/` 和 `pilotdeck.yaml`） | `start-local.sh` 使用仓库内的 `.pilotdeck-home`；直接运行 UI 时默认为 `~/.pilotdeck`，生产环境应显式设置 |
| `PILOTDECK_DISABLE_LOCAL_AUTH` | 设为 `0` 或 `false` 启用登录/多用户模式 | 未设置时免登录 |
| `PILOTDECK_ADMIN_PASSWORD` | 首次创建管理员账号时的密码；以后不会自动重置 | 未设置时 `passok`，**生产环境必须显式设置强密码** |
| `SERVER_PORT` | UI/API 端口 | 直接运行 UI：`3001`；`start-local.sh` 从 `scripts/config.env` 读取 |
| `PILOTDECK_GATEWAY_PORT_BASE` | 每用户 Gateway 池起始端口 | 直接运行 UI：`18800`；`start-local.sh` 从 `PILOTDECK_GATEWAY_PORT` 设置 |

环境变量可从 shell 导出，也可写在未提交的 `config/deploy.env`（或通过
`PILOTDECK_DEPLOY_ENV` 指向的文件）中；已设置的 shell 变量优先。不要把密码、
模型密钥或用户数据提交到仓库。`start-local.sh` 是**开发入口**；独立运行
`npm --prefix ui run dev:server`/`server` 或 `start-offline.sh` 也会执行预检。

### 配置与启动

使用绝对路径指定数据根，并确保部署用户对其有写权限。首次创建数据根与配置
模板（已有配置不会覆盖）：

```bash
export PILOT_HOME=/srv/pilotdeck/data
export PILOTDECK_DISABLE_LOCAL_AUTH=0
export PILOTDECK_ADMIN_PASSWORD='请替换为强密码'
export SERVER_PORT=3020
export PILOTDECK_GATEWAY_PORT_BASE=19200
node scripts/bootstrap-pilotdeck-config.mjs
```

直接运行 UI 时还需把仓库中的医学插件关联到数据根（`start-local.sh` 会自动
处理仓库内的默认数据根；自定义数据根按下例操作）：

```bash
ln -s "$(pwd)/plugins/med-tools" "$PILOT_HOME/plugins/med-tools"
```

编辑 `$PILOT_HOME/pilotdeck.yaml` 中的模型配置，并添加沙箱配置：

```yaml
multiUser:
  sandbox:
    kind: bwrap
    network: true
    # 仅在目标程序不在默认系统/运行时只读挂载中时，添加经审核的绝对路径。
    extraReadOnlyBinds: []
```

默认已只读挂载现存的系统程序路径（如 `/usr`、`/bin`）和项目运行时；
`/usr/bin/python3`、`/usr/bin/libreoffice` 等如果位于 `/usr`，无需重复添加。
**不要**把数据根、`users/`、`system/` 或其他用户目录加入
`extraReadOnlyBinds`。`network: true` 是默认值，医学技能需要访问服务时
不要开启网络隔离；`kind: none`/`allowUnsandboxed: true` 不适用于生产部署。
文档技能需要的运行时/缓存应预置在项目的共享只读运行时下，输出留在用户目录。

已有数据根请先备份，再在仓库根目录完成项目构建与 UI 构建并启动：

```bash
npm run build
npm --prefix ui run build
bash scripts/pre-flight-check.sh
npm --prefix ui run start:built
```

预检在 Linux 多用户模式且找不到 `bwrap` 时会打印安装命令并退出（状态码 1），
不会继续启动 UI；免登录模式不强制安装。首次登录用 `admin` 和设置的初始密码。
生产机上的 bwrap 隔离、用户文件路径和 DOCX/PPTX/XLSX/医学 Runner 等正反
向验证，按 Task 9 执行；不要将本机 macOS 预检成功当作生产验收通过。
