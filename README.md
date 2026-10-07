# 地面标定库 · 快照裁决服务（Calibration Snapshot Store）

多名工程师可同时修订校正常数。服务以**快照隔离 + 不可变版本历史**裁决每笔事务：
基于过期快照的读—写组合不会被悄悄发布为“可复现实验版本”，每笔事务都与其
**首次规范载荷**绑定，并冻结可回放的终局证据。

零第三方运行时依赖，仅需 Node.js ≥ 20（或 Docker Compose）。

## 运行

### Docker Compose

```bash
APP_PORT=8080 docker compose up --build app        # 宿主端口可配置
# 网页控制台  http://localhost:8080/
# 健康响应    http://localhost:8080/healthz
```

一次性验收服务（规则测试 + 构建检查 + 跨容器 API/HTTP 冒烟 + 杀进程重开，
以退出码报告结论）：

```bash
docker compose up --build verify
# 退出码 0 = 验收通过；非 0 = 失败（docker inspect / $? 可查）
```

### 直接用 Node

```bash
PORT=8080 DATA_DIR=./data node src/server.js
node verify/verify.js        # 本地完整验收，退出码即结论
```

## 裁决规则（稳定拒绝原因代码）

| 代码 | 触发条件 |
|---|---|
| `READ_SNAPSHOT_MISMATCH` | 点读声称的值与该快照代次本身不符（快照证据不自洽） |
| `POINT_READ_CONFLICT` | 任一点读键在快照代次之后被新增 / 删除 / 改写 |
| `SCAN_SNAPSHOT_MISMATCH` | 前缀扫描声称的键集与该快照代次不符 |
| `PHANTOM_READ` | 扫描前缀内在快照代次之后有键新增 / 删除 / 改写（幻读） |
| `UNKNOWN_GENERATION` | 提交基于晚于当前的代次 |
| `PAYLOAD_REUSE_CONFLICT` | 同一 `txnId` 携带与首次不同的规范载荷重提（HTTP 409） |

- **互不相交**（读取键、扫描前缀覆盖范围、写入键互不影响）的提交仍可成功。
- **写偏斜**：双方读过同一键却各写一边，后一提交必被 `POINT_READ_CONFLICT` 拦下。
- 拒绝也是**终局**：同样冻结在裁决日志中，重传同一 `txnId` 只回显原拒绝。

## 持久化与幂等

每个演练一个目录，`wal.log` 为仅追加裁决日志，每条记录 `write + fsync`：

1. `bound` —— 事务与**首次规范载荷**（键排序后的稳定 JSON）先绑定落盘；
2. `decision` —— 接受/拒绝在同一条记录中冻结：新代次、写入内容、
   点读摘要与前缀扫描摘要（含快照中看到的键值）。

- 重传同一 `txnId` + 同规范载荷（字段顺序、对象键序无关）→ `echoed:true` 回显原裁决，代次不重复推进。
- 结果落盘前中断：重开后重传同一标识只能回显原结果；未完整落盘的撕裂尾行在回放时被截断丢弃。
- 删除以墓碑（`value:null`）形式保留在不可变版本历史中，任意旧代次均可复查。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET`  | `/healthz` | 健康响应 |
| `POST` | `/api/drills` | 建立演练 `{id?, entries:{键:字符串值}}`，初始键值即 gen 0 |
| `GET`  | `/api/drills` | 演练列表 |
| `GET`  | `/api/drills/:id/state` | 当前代次、存活键值与全部事务终局证据 |
| `GET`  | `/api/drills/:id/snapshot` | 当前快照 |
| `POST` | `/api/drills/:id/commit` | 提交事务（见下） |
| `GET`  | `/api/drills/:id/transactions` | 全部终局 |

提交体：

```json
{
  "txnId": "fix-gyro-x-20261007",
  "gen": 2,
  "reads":  [{ "key": "gyro.x.bias", "value": "0.0120" }],
  "scans":  [{ "prefix": "gyro.", "keys": ["gyro.x.bias", "gyro.y.bias"] }],
  "writes": [{ "key": "gyro.x.bias", "value": "0.0118" }]
}
```

`reads[].value` 为 `null` 表示该键在快照中不存在；`writes[].value` 为 `null` 表示删除。

## 网页控制台

- 建立含初始键值的演练；
- 按“稳定事务标识 + 快照代次 + 点读 + 前缀扫描 + 拟写入值”提交；
- 每笔事务显示快照证据、终局与当前代次；
- 扫描摘要可**展开查看该快照中看到的键值**；
- 明确区分：✔ 已接受 / ● 点读冲突 / ◆ 幻读拒绝（前缀新增·删除·改写）/ ▲ 其他拒绝；
- “同标识重传”按钮用于验证幂等回显。

## 目录结构

```
src/store.js     不可变版本历史 + WAL 裁决引擎（绑定/校验/冻结/回放）
src/server.js    HTTP API、静态页面与健康检查
public/          网页控制台
verify/verify.js 一次性验收：规则测试、构建检查、API/HTTP 冒烟、杀进程重开
Dockerfile, docker-compose.yml
```
