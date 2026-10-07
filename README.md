# 地面标定库 · 并发提交裁决系统

面向多名工程师同时修订校正常数的场景：基于**过期快照**的「读取 + 写入」组合
绝不会被悄悄发布为可复现实验版本。系统提供网页建立演练、提交带稳定事务标识的
事务，并为每笔事务冻结快照证据、终局和当前代次。

仅依赖 Python 3.11 标准库（HTTP 服务、持久化、测试均无第三方包）。

## 并发控制模型（first-committer-wins，对照不可变版本历史校验）

- **代次（generation）**：每笔接受的提交冻结一个严格递增的新代次；第 0 代为
  演练初始键值。版本历史只追加、不可变。
- **事务首次规范载荷绑定**：`transaction_id` 永久绑定首次提交的规范载荷
  （JSON 以排序键、紧凑分隔序列化；键顺序与空白差异视为同一载荷）。
- **点读取校验**：键的当前值必须仍等于快照读取值，且该键在快照代次之后没有
  新版本。删除后恢复、改写成相同值也算冲突 → `point_read_conflict`。
- **前缀扫描校验**：前缀内键集合必须与快照所见完全一致。快照后前缀内**新增**
  （幻读）、**删除**或**改写**任何键 → `phantom_read`，稳定原因。
- **写偏斜**：基于同一快照的写偏斜事务，先到者冻结新代次，后到者在读取校验
  处被拦下，其拟写入值不会生效。
- **不相交提交**：读取/写入互不相交的两笔事务即使同源快照可先后成功。
- **同一持久化裁决**：接受结果在同一把锁、同一次原子落盘（临时文件 +
  `fsync` + `os.replace` + 目录 fsync）中冻结新代次、写入内容及读取/扫描摘要。
- **重传 / 重开**：落盘前中断则该裁决根本不存在；落盘后（含服务重开）同一
  `transaction_id` + 同一规范载荷只回显原结果（`replay: true`，不再推进代次）；
  同一标识搭配不同载荷一律 `transaction_id_conflict` 拒绝。

## 文件布局

```text
app/
  engine.py          # 核心裁决引擎 + JSON 原子持久化
  server.py          # 标准库 HTTP API + 静态页托管
  static/            # 网页：建立演练 / 提交 / 快照证据展开
tests/test_rules.py  # 27 项并发规则单元测试（unittest，零依赖）
verify.py            # 一次执行、以退出码报告结论的验收脚本
Dockerfile           # python:3.11-slim，含容器健康检查
docker-compose.yml   # calibration + verify（profiles 启用）， APP_PORT 可配
```

## 快速开始（Docker Compose）

```bash
# 可选：改宿主端口
cp .env.example .env          # 默认 8080；编辑 APP_PORT=9090 即可
docker compose up -d --build
open http://localhost:8080    # 或 http://localhost:${APP_PORT}
curl -s http://localhost:8080/healthz
```

## 验收（规则测试 + 构建检查 + API/HTTP 冒烟，一次执行 + 退出码）

```bash
# 对已启动的 calibration 服务运行全部验收场景
docker compose --profile verify run --rm verify

# 等价地：先建后验，一条命令
docker compose --profile verify up --build --abort-on-container-exit verify

# 重新干净验收（清空持久卷）
docker compose down -v
docker compose --profile verify up --build --abort-on-container-exit verify
```

`verify` 服务等待 calibration 健康后执行 `verify.py`，依次完成：

1. **BUILD** — 全部 Python 文件字节码编译、模块导入、Dockerfile/compose 存在性；
2. **RULES** — 27 项裁决规则测试（含同值改写冲突、同值同快照并发等）；
3. **ENGINE** — 重开落盘文件后的恢复、同标识同载荷回声、异载荷拒绝；
4. **HTTP** — 健康响应、页面/静态资源、建演练、不相交提交、前缀新增幻读、
   点读改写冲突、写偏斜拦截、重传回显、异载荷标识冲突、事务证据查询、
   快照扫描视图。

全部通过打印 `ACCEPTED` 并以 **0** 退出；任何失败打印 `REJECTED` 并以 **1** 退出。
```bash
# 本地（无 Docker）也可直接跑：
python3 -m unittest discover -s tests          # 规则测试
CALIB_DB=/tmp/demo.json PORT=8080 python3 -m app.server &
python3 verify.py http://127.0.0.1:8080        # 退出码即验收结论
```

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET  | `/healthz` | 健康响应，含当前代次 |
| POST | `/api/exercise` | `{"initial":{...}}` 建立演练（第 0 代，仅一次） |
| POST | `/api/commit` | 提交事务（见下）；裁决成功恒返 200，冲突看 `status`/`reason` |
| GET  | `/api/state` | 当前物化键值 + 当前代次 |
| GET  | `/api/transactions` | 全部事务终局与证据 |
| GET  | `/api/transactions/{id}` | 单笔事务裁决（重开后仍在） |
| GET  | `/api/snapshot/point?generation=g&key=k` | 某代次快照点读 |
| GET  | `/api/snapshot/scan?generation=g&prefix=p` | 某代次快照前缀键集合 |

提交体示例：

```json
{
  "transaction_id": "eng-42",
  "snapshot_generation": 1,
  "point_reads": {"calib.sensorA.offset": "0.012"},
  "prefix_scans": [
    {"prefix": "calib.sensorA.", "seen_keys": ["calib.sensorA.gain",
                                               "calib.sensorA.offset"]}
  ],
  "writes": {"calib.sensorA.offset": "0.015"}
}
```

拒绝原因（稳定字符串）：`point_read_conflict` / `phantom_read` /
`transaction_id_conflict`；请求结构错误返 HTTP 400 `invalid` 类错误；
快照代次超前也返 400。网页上绿色=已接受，黄色=点读冲突，红色=幻读，
橙色=标识冲突；扫描可展开查看其在快照中看到的键与当前键集合的差异。

## 持久化

数据落在容器内 `/data/calibration.json`（compose 命名卷 `calib-data`）。
该文件就是审计日志：代次序列（每代写入 + 读取/扫描证据）与事务标识→裁决绑定。
重开即从不可变历史重建实时索引；删除卷即复位演练。

## 设计说明 / 边界

- 值统一为 JSON 类型；`writes` 中显式 `null` 表示删除该键。
- 点读 `null` 表示快照时该键不存在；快照后新增即点读冲突。
- 校验与应用在单个进程锁内原子完成，同一裁决内冻结「新代次 + 内容 + 摘要」。
- 单节点文件存储，吞吐与多副本协调不在本演练范围内；裁决语义不依赖时钟。
