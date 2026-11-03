# M5N-R3 任务说明

在 src/m5n-r3.js 实现 formatGreeting(name)，在 test/m5n-r3.test.js 用 node:test 验证空值、Unicode 与正常输入；函数不改输入。 在任何写入前，必须询问用户 希望问候使用“你好”还是“Hello”，没有答案不得猜测；最终 worker-result 返回 needs_input，含 blocking 的 Q1。收到权威 answers 后采用该偏好完成实现。

请求已内联完整任务，不依赖 worker 读取此文件；调度者启动前核对 README 的场景操作。此文件不是已执行记录。
