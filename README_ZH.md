# @lixiangzhong/dsh-active-chat

把**有进行中会话的工作区**置顶到 DSH 侧栏最前，让你一眼看到哪些会话正在工作。

DSH 侧栏的工作区顺序只有一份 Host 侧顺序，默认只能手动拖动。这个插件会在工作区变为
活跃时自动写入那份顺序：该工作区提到最前，其余工作区保持原有相对顺序；工作结束后该工作区
下沉到仍在活跃的工作区之后，不会恢复它原来的手工位置。

「进行中」与侧栏活跃点同源：会话正在运行，或会话正在等你回复（审批 / 计划审阅 / 提问）。

## 行为

- **页面加载 / 首次安装** —— 立即对齐一次：最近活跃过的工作区排最前，其余工作区保持当前
  相对顺序；已经对齐则零写入。
- **新的活跃** —— 该工作区跳到最前；多个工作区同时活跃时，最近活跃的那个排最上面。
- **工作结束** —— 该工作区下沉到仍在活跃的工作区之后。
- **全部空闲** —— 插件停止写入；你手动拖动的顺序会保留，直到下一次出现新的活跃。
- 没有设置项、没有界面：装上即生效；不想用时在插件面板禁用或卸载即可。

插件写入的是真实的 Host 工作区顺序（与手动拖动同一份），因此刷新页面、换会话都会保持。

## 安装

需要 DSH >= 0.2.1-rc.2 的 Web profile。本插件是标准 DSH bundle，不声明任何 npm 依赖。

在 DSH 插件面板中安装本包，或使用 CLI：

```sh
dsh plugin --profile web add @lixiangzhong/dsh-active-chat
```

如果想从本地 checkout 调试，改为链接本地目录：

```sh
dsh plugin --profile web add /path/to/dsh-active-chat
```

然后刷新页面。移除时禁用或卸载插件并刷新即可。

## 实现

`client.js` 是浏览器端插件：注入 `workspaces`、`sessions`、`uiSession` 三个客户端服务，
订阅它们的快照，并通过官方 `ctx.workspaces.insertBefore(workspaceId, beforeWorkspaceId?)`
把工作区移动到 Host 顺序中。变更会合并处理，只有活跃工作区集合真正变化时才写入。
Host 侧 `index.js` 只是一个空的插件入口。

## 开发

```sh
npm test    # 语法检查 + 行为测试（node:test，无需浏览器）
```

测试用假的快照驱动插件，覆盖上面列出的全部行为。

## 发布

发布走 CI，仓库里不保存任何 npm token。

1. 升版本号并让 npm 写好发布提交与 tag：`npm version 0.1.1`（想自己手动提交和打 tag 就加 `--no-git-tag-version`）。
2. 一起推上去：`git push origin master` 与 `git push origin v0.1.1`（或 `git push --follow-tags`）。`v*` tag 会触发发布流程。
3. [`.github/workflows/publish.yml`](.github/workflows/publish.yml) 会校验 tag 与 `package.json` 版本一致、跑 `npm test`，然后通过 [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers)（OIDC）发布，并自动附上 provenance 证明。

前提：npm 包设置里必须把 `.github/workflows/publish.yml` 注册为 trusted publisher（user `lixiangzhong`、repo `dsh-active-chat`），并勾选 **Allow npm publish**——新建配置默认只允许 staged publish。该配置若创建后两天内没有首次成功发布就会过期。

## License

MIT
