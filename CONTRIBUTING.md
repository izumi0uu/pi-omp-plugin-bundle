# Contributing

## Repository rules

- Pi 原生插件放在 `pi/<plugin-name>/`，manifest 使用 `pi.extensions`。
- OMP 原生插件放在 `omp/<plugin-name>/`，manifest 使用 `omp.extensions`。
- 每个插件必须是可独立安装、测试和打包的目录。
- 运行时专用 import 不跨目录共享；需要支持两个运行时时，分别维护薄入口和兼容性测试。
- provider 凭据只引用环境变量，不写入源码、示例或测试快照。
- 错误重试必须区分瞬时限流、配额耗尽、鉴权失败和模型不可用。

## Checks

```bash
npm run check
```

提交前还应使用对应运行时加载入口文件，确保 package manifest 与实际加载器一致。
