# 刷 B 站设置保存兼容修复

为 npm `dsh-bili-scroll@0.1.7` 适配 DSH 的 volatile 配置引用，修复点击保存、重新打开设置后内容恢复默认的问题。
只包装宿主配置读取；界面、账号、报告和原插件均沿用 npm 版本，运行数据仍在 `~/.dsh/bili-duty/`。

先完全退出 DSH，再安装（安装原版后安装修复，保持 bundle 顺序）：

```powershell
dsh plugin --profile desktop add dsh-bili-scroll@0.1.7
dsh plugin --profile desktop add "file:D:/Project/DeepSeek Harness/dsh-bili-scroll-settings-fix"
```

如果 `~/.dsh/profiles/desktop/cordis.patch.yml` 已有 `id: bili-scroll` 且显式写了
`name: dsh-bili-scroll`，把该行的 name 改成 `'@zhiqiangme/dsh-bili-scroll-settings-fix'`，其余配置保留。
然后重新打开 DSH。以后升级原插件时，需先确认新版本是否仍需要此修复；卸载修复前，先把上述 name 改回 `dsh-bili-scroll`。

验证：`node --test test/*.test.mjs`。
设置环境变量 `DSH_BILI_SCROLL_ENTRY` 为已安装原版的 `index.js` 绝对路径，还会运行实际 HTTP 保存、再次编辑、宿主重载的回归验证。
