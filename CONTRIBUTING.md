# Contributing / 参与贡献

Thanks for your interest. Block Detective's core is open source under the
[AGPL-3.0](LICENSE); some features (the copy-trading simulator, backtesting and
the research database) are a separately licensed extension that lives in a
private repository and plugs into `ext/`. Pull requests here are for the core.

## Developer Certificate of Origin

Because the author also distributes the core under other terms together with
the commercial extension, every contribution must be certified under the
[Developer Certificate of Origin 1.1](https://developercertificate.org/) and
you agree that your contribution may be relicensed by the project maintainer
as part of such distributions. Certify by adding a sign-off line to each commit:

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it for you. Use a real name or a consistent pseudonym.

## Ground rules

- Standard library only on the server, vanilla JavaScript in the browser: no
  new dependencies and no build step.
- Everything stays local: no telemetry, no calls to services other than the
  public data APIs already listed in the README.
- Run the tests before pushing: `python3 -m unittest discover tests`. They
  don't need network access or API keys.
- Keep user-facing text in Chinese in the source and add the Japanese and
  English translations to `static/i18n.js`.

## Writing an extension

Any directory under `ext/<name>/` with an `__init__.py` that defines
`register(core, ext)` is loaded on startup. See the "扩展" section in
`server.py` for the small API (`ext.route`, `ext.on`, `ext.page`) and the list
of hooks, and `tests/test_core.py::ExtensionTests` for a minimal example.
Extensions can be under any license you like; they are not part of this
repository.

---

感谢你的关注。区块侦探的核心按 [AGPL-3.0](LICENSE) 开源；跟单机器人、回测和研究数据库属于单独授权的扩展，放在私有仓库里，通过 `ext/` 目录接入。这里的 PR 针对核心。

- **签署 DCO**：每个提交加一行 `Signed-off-by: 名字 <邮箱>`（`git commit -s`），表示你有权提交这段代码，并同意维护者在与商业扩展一起分发时按其他条款再授权。
- 服务端只用标准库，前端只用原生 JS，不加依赖、不加构建步骤；不加遥测，不连 README 之外的服务。
- 推送前跑 `python3 -m unittest discover tests`（不联网、不需要 Key）。
- 界面文案以中文写在代码里，日文和英文译文加到 `static/i18n.js`。
- 写扩展：`ext/<名字>/__init__.py` 里定义 `register(core, ext)`，接口见 `server.py` 的"扩展"一节和 `tests/test_core.py` 里的 `ExtensionTests`。
