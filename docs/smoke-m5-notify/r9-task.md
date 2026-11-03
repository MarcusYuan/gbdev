# M5N-R9 任务说明

在 src/m5n-r9.js 实现 formatGreeting(name)，在 test/m5n-r9.test.js 用 node:test 验证空值、Unicode 与正常输入；函数不改输入。 详细覆盖类型异常、空白字符串与不可变性；调度者将在运行中模拟 supervisor/投递进程停止，按恢复流程续作，不通过睡眠拖延。

请求已内联完整任务，不依赖 worker 读取此文件；调度者启动前核对 README 的场景操作。此文件不是已执行记录。
