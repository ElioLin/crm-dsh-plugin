# 部署公司内部插件源（crm-ex-test02）

目标机器：`crm-ex-test02` / `192.168.156.203`，Rocky Linux 9.8，Node 22。

装完拿到两个地址（内网，用 IP 或域名都通）：

| 用途 | 地址 |
| --- | --- |
| npm 源（发布与安装） | `http://crmmcptest.runner-corp.com.cn:9001/` |
| 插件市场索引（DSH 发现页） | `http://crmmcptest.runner-corp.com.cn:9001/plugins/index.json` |

## 为什么是独立端口 9001

9000 是 MCP 服务与 Admin Web 的站点（`conf.d/mcp-service.conf`）。把插件的 location
include 进那个 server 块技术上可行，但**实际上很脆**：谁改 MCP 入口、重部署 nginx、
覆盖那个配置文件，都会顺手把我们的配置冲掉，而且出问题时很难判断是谁影响谁。

所以这里起一个完全独立的 server：独立文件 `conf.d/dsh-plugins.conf`、独立端口 9001。
9000 那边一个字节都不改。

## 架构

```
pnpm / npm ──▶ :9001/  ──nginx──▶ 127.0.0.1:4873 (Verdaccio)
                                     └─ /data/dsh-plugins/registry/storage
DSH 发现页 ──▶ :9001/plugins/index.json ──▶ /data/dsh-plugins/public/index.json
```

registry 挂在**根路径**上，不是子路径。原因是 Verdaccio 6 的 `url_prefix` 只影响它
返回的 tarball 地址、并不改变路由——把服务挂在根上，tarball 地址天然正确，不需要
rewrite，也不需要 `url_prefix`（配了反而会多出一段前缀导致 404）。

## 1. 部署

```bash
# 本机（仓库根目录）
scp -r deploy/registry root@192.168.156.203:/tmp/

# 服务器
ssh root@192.168.156.203
bash /tmp/registry/install.sh
```

脚本会：装 Verdaccio（走 npmmirror）→ 建 `dsh-registry` 系统用户与 `/data/dsh-plugins/`
→ 装 systemd 单元并启动 → 登记 SELinux 的 9001 端口与静态目录标签 → firewalld 放行 9001
→ 写独立站点配置并 reload nginx → 自检。

幂等：重复执行不会重复建用户或放行端口；还会清理旧版本留下的痕迹
（把 include 插进 `mcp-service.conf` 那套）。

预期最后：

```
✓ 127.0.0.1:4873 已响应
✓ registry：http://<本机内网IP>:9001/ 可用
```

## 2. 发布

```bash
# 本机仓库根目录
npm pack --ignore-scripts
node scripts/publish.mjs runner-corp-dsh-scenario-workspace-<版本>.tgz \
  http://crmmcptest.runner-corp.com.cn:9001/
```

**不要用 `npm publish`**：npm 客户端要求本地先有 token，没有就抛 `ENEEDAUTH`，
而这个源是匿名可发的。`scripts/publish.mjs` 直接走 registry 的 PUT 接口。

验证：

```bash
npm view @runner-corp/dsh-scenario-workspace version \
  --registry http://crmmcptest.runner-corp.com.cn:9001/
```

只想换个端口重装：`bash install.sh --port 9002`。

## 3. 上传索引

```bash
# 本机
npm run index
scp build/index.json root@192.168.156.203:/data/dsh-plugins/public/index.json

# 服务器（改完标签，让 nginx 能读）
ssh root@192.168.156.203 'restorecon -v /data/dsh-plugins/public/index.json'
```

**每次发版都要重做这一步**，否则发现页显示的版本号不会变。

## 4. 用户侧配置

```ini
# ~/.npmrc
@runner-corp:registry=http://crmmcptest.runner-corp.com.cn:9001/
```

然后：

```
插件页 → 安装 → 输入 @runner-corp/dsh-scenario-workspace
```

或用索引源：**插件 → 发现 → 索引源** → 加
`http://crmmcptest.runner-corp.com.cn:9001/plugins/index.json`。

> 本机（外网侧）要发布的话，9001 没有做网关 DNAT，只能走 SSH 通道或在服务器上发。
> 要对外发布，让运维照 9000 的方式给 9001 加一条映射即可。

## 5. 回滚

| 改动 | 回滚 |
| --- | --- |
| nginx | `rm /etc/nginx/conf.d/dsh-plugins.conf && nginx -t && systemctl reload nginx` |
| 服务 | `systemctl disable --now dsh-registry` |
| 端口放行 | `firewall-cmd --permanent --remove-port=9001/tcp && firewall-cmd --reload` |
| 数据 | 删 `/data/dsh-plugins`（**会丢所有已发布版本，先确认没人还在装老版本**） |

## 6. 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| nginx reload 失败、报 bind 9001 | SELinux 没给 9001 打 `http_port_t` | `semanage port -a -t http_port_t -p tcp 9001` |
| 9001 返回 502 | Verdaccio 没起，或 SELinux 不许 nginx 连 4873 | `journalctl -u dsh-registry -n 50`；`getsebool httpd_can_network_connect` |
| 发布时报 `ENEEDAUTH` | 用了 `npm publish` | 改用 `node scripts/publish.mjs` |
| 装包时 tarball 404 | 发布时 Host 不对，地址被写成了别人访问不到的 IP | 删掉该版本重发；tarball 地址按请求 Host 动态生成，正常不会固化 |
| 索引 403 | 文件标签不是 `httpd_sys_content_t` | `restorecon -Rv /data/dsh-plugins/public` |
| 发布 403 | 包名不在 `@runner-corp/*` 下 | Verdaccio 只允许这个 scope 发布 |
| 装包 404 | 用户 `.npmrc` 没配 scope 行 | 加上 `@runner-corp:registry=...` |

## 7. 备份

`/data/dsh-plugins/registry/storage` 是所有历史版本的唯一副本。机器重建后这里没了，
用户装老版本会 404、自更新也会失效。建议按周备份：

```bash
tar czf /data/backup/dsh-registry-$(date +%F).tar.gz -C /data/dsh-plugins registry/storage
```
