# 本地打包 codeg 安装器

> 一句话:`pwsh -File scripts/build-local-installer.ps1`,别的都不用记。
>
> 这份文档解释脚本替你处理了什么、以及为什么本地打包**天然**拿不到更新器签名。
> 正式发布走 CI(打 tag → `release.yml`),不是这条路。

## 快速开始

```powershell
# 完整流程:验证 → 编译 sidecar → 打 NSIS → 复制到 dist-installer/
pwsh -File scripts/build-local-installer.ps1

# 代码刚验证过,只想要安装包
pwsh -File scripts/build-local-installer.ps1 -SkipVerify

# 产物留在 cargo target 目录,不复制
pwsh -File scripts/build-local-installer.ps1 -KeepArtifactWhereItIs
```

产物:`dist-installer/codeg_<版本>_x64-setup.exe`

## 为什么要有这个脚本

本地打包有 4 个前提,它们分散在 `package.json`、`src-tauri/tauri.conf.json`、
`.github/workflows/release.yml` 三个文件里。不写下来,每次都要重新踩一遍 ——
这份 SOP 就是为了终结这件事。

### 1. `NODE_ENV` 必须是 `production`

各类工具的 shell(mcphub 等)会带 `NODE_ENV=development`。在那个环境下
`pnpm build` 会在 Next 16 静态预渲染阶段以 `useContext null` 失败 —— 报错
位置离真正原因很远,极易误判成前端代码问题。

脚本只为自己这个进程设置该变量,不污染你的 shell。

### 2. Windows 上必须跳过 MSI

**这是本仓最容易卡住的一步。** 直接跑 `pnpm tauri build`(默认 `targets: "all"`)
会走到 MSI 环节然后失败:

```
failed to run WixTools314\light.exe
```

Tauri 会吞掉 `light.exe` 的具体报错。手动跑才能看到真正的原因:

```
error LGHT0204 : ICE30: The target file 'codeg-mcp.exe' is installed in
'[ProgramFiles64Folder]\codeg\' by two different components:
'codeg_mcp.exe' and 'codeg_mcp'. This breaks component reference counting.
```

机理:本仓通过 `bundle.externalBin` 打包 `codeg-mcp` sidecar,同时 release
构建自己也会编出一个 `codeg-mcp.exe`,于是 WiX 里出现两个组件指向同一安装
路径,触发 ICE30 硬错误。这是上游已知 bug(tauri-apps/tauri#14681),
**不是本仓配置错误**。

项目 CI 早已规避 —— `release.yml` 用的是 `--bundles nsis,updater`。NSIS 安装器
覆盖同一分发渠道,MSI 没有额外价值。脚本沿用这个决定。

> 注意:本地 `pnpm tauri build --bundles` 只接受 `msi` / `nsis`;`updater` 产物
> 由 `tauri.conf.json` 的 `createUpdaterArtifacts: true` 控制,不是 `--bundles`
> 的取值。

### 3. sidecar 要先 staged,并**单独校验**落地

CI 分两步做(`Stage codeg-mcp sidecar` + `Verify codeg-mcp sidecar landed`),
脚本照做。原因是 `prepare-sidecars.mjs` 报成功不等于文件真的在位 —— 一旦缺失,
打出来的安装包会少掉委托功能,而这要到运行时才暴露。

校验通过后脚本会设 `CODEG_SKIP_SIDECAR=1`,避免 `beforeBuildCommand` 重复编译
一遍(白等几分钟)。

> `prepare-sidecars.mjs` 通过 `cargo metadata` 取 cargo 的**权威** target 目录,
> 所以 `CARGO_TARGET_DIR`、`build.target-dir`、workspace 根目录三种情况都兼容。
> 早先它硬编码 `src-tauri/target`,在设了 `CARGO_TARGET_DIR` 的机器上必然以
> 「expected ... but it does not exist」失败 —— 尽管 cargo 明明刚编译成功。

### 4. 本地拿不到更新器签名 —— 这不是故障

签名私钥是 CI secret(`TAURI_SIGNING_PRIVATE_KEY`),按设计不存在于开发机。
所以本地构建**只产安装器,不产 `.sig`**,并且:

```
A public key has been found, but no private key.
Error A public key has been found, but no private key.
[ELIFECYCLE] Command failed with exit code 1.
```

**签名步骤在打包之后**,所以这条错误出现时,安装器已经好好地躺在磁盘上了。
脚本因此**以产物是否存在判断成败,而不是看退出码**,并在这种情况下明确告诉你
「安装器已产出,退出码非零属预期」。

需要带签名的产物 → 走 CI,别在本地折腾密钥。

## 排障

| 现象 | 真正原因 | 处理 |
|---|---|---|
| `useContext null` / 预渲染失败 | `NODE_ENV=development` | 用本脚本;或先 `$env:NODE_ENV='production'` |
| `failed to run light.exe` | MSI + externalBin(tauri#14681) | 加 `--bundles nsis`;本脚本已默认 |
| `expected <path>\codeg-mcp.exe ... does not exist` | 旧版脚本硬编码 target 路径 | 已修(改用 `cargo metadata`);确认代码是最新的 |
| `no private key` + 退出码 1 | 本地无签名密钥(预期) | 检查 `dist-installer/` —— 安装器其实已产出 |
| 版本号不一致 | 三处 manifest 未同步 | 脚本会在开工前拦下并指出哪一处不同 |
| `cargo test --lib` 崩在 `0xc0000139` | Tauri 在 Windows 的已知 bug(tauri#13419) | 用 server target 跑测试;本脚本已如此 |

## 与 CI 的分工

| | 本地脚本 | CI(`release.yml`) |
|---|---|---|
| 用途 | 自测、试装、给人发一个包 | 正式发布 |
| 平台 | 仅当前宿主 | Windows / macOS / Linux 矩阵 |
| MSI | 跳过 | 跳过(同一原因) |
| 更新器签名 | 无(无密钥) | 有 |
| 触发 | 手动 | 推 tag |

本地脚本刻意**不碰** `latest.json`、不上传、不改 tag —— 那些是发布动作,归 CI。
