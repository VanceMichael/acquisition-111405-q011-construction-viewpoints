# 工程协作问题的视点与构件选择资料采集

这是资料接收服务的独立工作副本。当前版本既支持人工摘要的领取，也支持新来源按问题单领取视点：协调员在模型里明确选中的构件、显隐与着色分别保存，视点始终指向其声明的模型版本。无法确认的模型或构件引用会单列出来供补资料。

## 环境

Node.js 22，运行与测试只用标准库，无外部服务、数据库、浏览器或联网下载。依赖清单和 npm 锁文件均已提供。

```sh
npm test
npm run demo
```

`npm test` 是初始产品的基线回归，验证现有摘要通路、原文摘要检查、本地来源响应，以及 CLI 在独立进程中的真实领取、重复导入和持久归档检查。该产品是一次执行后退出的采集程序，不提供常驻 HTTP 应用；`npm run collect` 执行领取，`npm run provider` 仅单独启动测试来源。

`npm run acceptance:source` 执行 `test/feature.test.mjs` 中完整的新来源验收。`npm run test:boundary` 补充契约未穷举的边界：选择/显隐/着色互不推导、问题单文档与视点截图均按原文归档、业务标识状态更新后旧修订仍可回查、模型版本缺失时不回退同名当前构件、重复导入不重复记账。验收与边界文件均原样保留断言，没有跳过或把失败转为成功。交付时执行 `npm run verify:complete`，让基线、新来源验收和边界验证同时通过；不能只用基线成功说明新功能已完成。

```sh
npm run verify:complete
npm run demo:feature
```

正式演示使用完成后的 `npm run demo:feature`，从空临时归档启动本地来源、实际采集并打印结果后退出；无需重放旧日志。`SCENARIO` 可选择 `fixtures/scenarios.json` 中的情景，默认 `selection-not-visibility`。单次命令应在90秒内结束，不使用真实客户数据。

## 容器

```sh
docker build -t acquisition-construction-viewpoints:local .
docker run --rm --network none acquisition-construction-viewpoints:local
docker run --rm --network none acquisition-construction-viewpoints:local npm run demo:feature
```

镜像固定 Node.js 版本及基础镜像摘要；首次构建可提前拉取基础镜像，正式运行不安装或下载。容器中来源与采集器同进程启动，不需要第二个容器。默认容器命令跑现有测试与实际摘要导入，不将未开发功能伪装成成功。

## 工作入口

- `src/collector.mjs` 的 `collect` 是业务入口；`legacy` 模式保留，`source` 模式领取问题单、视点与附件。
- `src/source.mjs` 解释新来源：构件身份由模型版本限定，`selected`、`visibility`、`coloring` 分别保留；模型索引缺失时只登记待补引用，不回退其他版本。
- `src/transport.mjs` 提供原文字节与请求证据，错误状态由业务层判断。
- `src/archive.mjs` 支持内容寻址原文、记录修订回查（`history`/`latest`）与缺口去重；存储位置由调用方传入。
- `provider/server.mjs` 提供允许访问的本地合成来源，路径和例子见 `docs/source-contract.md`。
- `test/feature.test.mjs` 对输出使用局部结构断言，不限制内部模块划分。

`ARCHIVE_DIR` 指定持久目录，`SOURCE_URL` 可连接另行启动的本地来源；两者均未设置时演示自动清理临时目录。`node src/cli.mjs inspect` 配合 `ARCHIVE_DIR` 查看当前索引。不要用来源服务的 fixture 对象直接生成业务结果，真实接收需经 HTTP。
