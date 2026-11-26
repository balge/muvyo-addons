# Muvyo Addons

在 Muvyo「第三方插件 → 插件仓库」中添加 [Muvyo Addons](https://github.com/balge/muvyo-addons)，然后安装并启用所需插件。三个插件均要求 Muvyo 3.14.0 或更新版本。

| 插件 | ID | 搜索资源 |
| --- | --- | --- |
| 迷你影视 | `balge.miniyingshi` | 115 分享、磁力链接 |
| 蜗牛 4K | `balge.woniu` | 115 分享、磁力链接 |
| 聚影 | `balge.jying` | 115 分享、磁力链接 |

在各插件的设置中填写该来源的登录账号和密码。迷你影视使用登录邮箱。资源类型默认为同时搜索 115 分享和磁力链接，也可选择其中一种。结果取决于站点当前提供的资源和账号可访问范围。

「每次获取数量」默认 5 条，可设为 1 到 20 条。两类资源共用这个上限，Muvyo 搜索请求设置更小的上限时以较小值为准。选择资源时，插件按需解析该项，并保留来源提供的 115 分享提取码。

蜗牛 4K 对同一账号的搜索和翻页保持至少 3 秒间隔，并按站点的间隔提示最多重试该请求一次。聚影收到 HTTP 429 后按 `Retry-After` 暂停该账号的请求，缺少有效时间时使用插件设定的 60 秒冷却。

## 验证已发布的插件

需要 Git 和 Node.js 20 或更新版本。在公开仓库的克隆目录运行：

```sh
npm run check -- --release
```

此命令检查 Git 中的文件、加密产物布局、签名的文件摘要、作者包签名和仓库索引的 Ed25519 签名。要用 Muvyo 官方工具进一步验证作者证书，传入从 Muvyo 开发者页下载的签名工具及安装了 `cryptography` 的 Python：

```sh
npm run check -- --release --signer "/path/to/mv_addon.py" --python "/path/to/python"
```

## 本地开发

源码保存在本地的 `src/`。本地开发者准备好 `src/shared/runtime.js` 以及三个插件各自的 `main.js`、`manifest.json` 和 `README.md` 后，可以构建、运行离线开发测试并检查产物：

```sh
git config core.hooksPath .githooks
npm test
npm run build
npm run check
```

`npm test` 和 `npm run build` 需要本地源码。构建为每个插件在 `dist/<ID>/` 下生成独立入口、清单和说明文件。

### 可选的真实站点探测

本地 Python 需安装 `quickjs`，探测工具在 macOS 和 Linux 上运行。账户 JSON 文件使用插件 ID 作为键，值为包含 `username` 和 `password` 的对象。将文件放在仓库之外，并仅给本地账号读取权限。

```sh
"/path/to/python" scripts/live-probe.py \
  --accounts "/path/to/private/accounts.json" \
  --plugin balge.jying --keyword "搜索关键词" --limit 5 --link-type 115
```

探测运行构建后的原生 QuickJS 代码。它执行一次搜索，最多解析首个匹配项，输出请求状态、结果数量、资源类型和提取码是否存在。每次调用最多 30 次请求、60 秒，仅访问相应站点允许的接口。宿主等待计入本次调用时限，单次最多 10 秒，合计最多 30 秒。每次调用使用新 QuickJS 上下文，同一次探测中共享内存存储。请求声明使用代理时采用操作系统或环境变量提供的 HTTPS 代理配置。

离线验证探测工具：

```sh
"/path/to/python" -m unittest discover -s tests -p test_live_probe.py
```

### 加密签名和发布

使用 Muvyo 开发者页签发的原始作者凭据。将原文件路径传给官方工具：

```sh
MUVYO_PYTHON="/path/to/python"
MUVYO_SIGNER="/path/to/mv_addon.py"
MUVYO_AUTHOR_FILE="/path/to/muvyo-signing.json"

npm run build
for id in balge.miniyingshi balge.woniu balge.jying; do
  "$MUVYO_PYTHON" "$MUVYO_SIGNER" sign "dist/$id" -o . -c "$MUVYO_AUTHOR_FILE"
  "$MUVYO_PYTHON" "$MUVYO_SIGNER" verify "plugins/$id"
  "$MUVYO_PYTHON" "$MUVYO_SIGNER" sign "dist/$id" --zip -o artifacts -c "$MUVYO_AUTHOR_FILE"
done
```

`plugins/` 是仓库发行目录，`artifacts/` 下的单插件 ZIP 用于领证的 Muvyo 实例本地调试。每次发布先完成插件签名与索引编辑，再用独立的仓库私钥签名索引。首次初始化使用官方模板的 `init-key`，后续发布继续使用原仓库私钥。

```sh
MUVYO_INDEX_TOOL=".claude/skills/muvyo-addon-publish/scripts/sign_index.py"
"$MUVYO_PYTHON" "$MUVYO_INDEX_TOOL" sign --key .private/repo-signing.pem
"$MUVYO_PYTHON" "$MUVYO_INDEX_TOOL" verify
```

保留本地源码、原始作者凭据和仓库私钥。逐项暂存索引、索引签名和已加密的插件文件，然后运行 `npm run check -- --staged --signer "$MUVYO_SIGNER" --python "$MUVYO_PYTHON"`。
