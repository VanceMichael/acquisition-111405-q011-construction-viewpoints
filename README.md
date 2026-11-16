# 工程协作问题的视点与构件选择资料采集

这是资料接收服务的独立工作副本。当前版本支持人工摘要的领取、原文归档、重复导入和归档检查；`source` 模式已接入协作平台新来源，按问题单、视点与附件的真实语义采集。

## 环境

Node.js 22，运行与测试只用标准库，无外部服务、数据库、浏览器或联网下载。依赖清单和 npm 锁文件均已提供。

```sh
npm test
npm run demo
```

`npm test` 是初始产品的基线回归，验证现有摘要通路、原文摘要检查、本地来源响应，以及 CLI 在独立进程中的真实领取、重复导入和持久归档检查。该产品是一次执行后退出的采集程序，不提供常驻 HTTP 应用；`npm run collect` 执行领取，`npm run provider` 仅单独启动测试来源。

`npm run acceptance:source` 执行 `test/feature.test.mjs` 中完整的新来源验收，覆盖选中与显隐分离、旧版模型缺失、空选中与未知构件等情景。交付时需执行 `npm run verify:complete`，让基线、新来源验收与来源边界测试同时通过；不能只用基线成功说明新功能已完成。

```sh
npm run verify:complete
npm run demo:feature
```

正式演示使用完成后的 `npm run demo:feature`，从空临时归档启动本地来源、实际采集并打印结果后退出；无需重放旧日志。`SCENARIO` 可选择 `fixtures/scenarios.json` 中的情景，默认 `selection-not-visibility`。单次命令应在90秒内结束，不使用真实客户数据。

## 新来源语义（mode: source）

- 每个视点落一条记录，业务标识 `id = topicId/viewpointId`；同一身份、同一内容重复领取不产生新修订。
- `selected`、`visibility`（`default` 加对默认值取反的 `exceptions`）、`coloring` 是三套互不包含的集合：默认可见不进入选中，被隐藏的构件仍可被选中，snapshot 只作为附件证据，永远不是构件清单。
- 构件身份固定为来源视点声明的 `project/revision/componentId`。模型索引按该版本请求；404 或畸形索引不会回退 `latest` 或任何同名当前模型，无法确认的引用完整列入记录的 `unresolvedComponents`，并在 `issues` 中留下带来源位置的可复核缺口。
- 视点 snapshot 与问题单 documents 经真实 HTTP 领取，原文在 `raw/` 以 SHA-256 寻址，记录只保存哈希引用；附件缺失不丢弃已确认的构件解释。
- 问题单更新产生新视点修订时，旧视点记录原样保留在归档中，经记录的 `evidence` 可回查当时原文。`complete=false` 表示本次解释存在未决缺口，已收到的安全独立部分仍会落库；空的有效结果（无问题单）与错误状态、缺数据分别处理。

## 容器

```sh
docker build -t acquisition-construction-viewpoints:local .
docker run --rm --network none acquisition-construction-viewpoints:local
docker run --rm --network none acquisition-construction-viewpoints:local npm run demo:feature
```

镜像固定 Node.js 版本及基础镜像摘要；首次构建可提前拉取基础镜像，正式运行不安装或下载。容器中来源与采集器同进程启动，不需要第二个容器。默认容器命令跑现有测试与实际摘要导入，不将未开发功能伪装成成功。

## 工作入口

- `src/collector.mjs` 的 `collect` 是业务入口；`legacy` 模式保留原摘要通路，`source` 模式由 `src/source.mjs` 解释问题单、视点与附件。
- `src/transport.mjs` 提供原文字节与请求证据，错误状态由业务层判断。
- `src/archive.mjs` 支持内容寻址原文与记录修订，存储位置由调用方传入。
- `provider/server.mjs` 提供允许访问的本地合成来源，路径和例子见 `docs/source-contract.md`。
- `test/feature.test.mjs` 对输出使用局部结构断言，不限制内部模块划分。

`ARCHIVE_DIR` 指定持久目录，`SOURCE_URL` 可连接另行启动的本地来源；两者均未设置时演示自动清理临时目录。`node src/cli.mjs inspect` 配合 `ARCHIVE_DIR` 查看当前索引。不要用来源服务的 fixture 对象直接生成业务结果，真实接收需经 HTTP。
