# R11 worker 可读性：未来受控实验

本轮不执行，也不读取家目录。正式实验由用户 确认授权范围（SPEC-M5 §15 R11 的通知秘密目录），调度者再填入临时 brief；不将真实 URL/密钥或读取内容写进请求、argv、日志、结果。仓库模板不包含真实秘密路径作为 worker 指令。

Codex 使用 r11-codex-brief.json（reviewer/read-only，gpt-6-astra）；fake 使用 r11-fake-brief.json 和下列专用场景。两者独立建 job，不以 fake 结果代替真实沙箱结论。

fake 现有默认场景不会探测权限。调度者须在隔离冒烟配置中准备专用 fake 探针：在 supervisor 的真实 worker 环境/权限下读取 user 授权的探测文件，只输出 read_allowed 与 notify_env_present 两个布尔值和失败分类；不能输出 bytes、路径、env 值或摘要哈希。未准备则 R11 标未覆盖，不把默认 fake ok 当通过。本仓库不增加可读取真实秘密的自动测试 fixture。

env 中是否存在相关键与是否存在 URL/密钥是两件事；GBDEV_HOME/GBDEV_CONFIG 等非秘密键合法。是否含真实 URL/密钥由用户 的本地哨兵比对/泄露扫描确认，不要求 worker 把 env 发给 bot。
