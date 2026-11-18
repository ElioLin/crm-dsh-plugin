#!/usr/bin/env bash
#
# 在公司测试服务器（crm-ex-test02 / 192.168.156.203）上装 DSH 插件源。
#
# 做五件事：
#   1. 装 Verdaccio（私有 npm 源），systemd 管理，只听 127.0.0.1:4873；
#   2. 建 /data/dsh-plugins/（registry 存包 + public 放索引 JSON）；
#   3. 起一个**独立的 nginx 站点**监听 9001，同时提供 registry 与索引
#      （独立 conf 文件，不碰 MCP 的 mcp-service.conf）；
#   4. 放行防火墙与 SELinux 端口；
#   5. 自检（本机 4873、经 nginx 的 9001、静态索引）。
#
# 为什么是独立端口而不是挂在 MCP 的 :9000 上：那个 server 块属于 MCP 服务，
# 我们的 location 一旦 include 进去，别人改 MCP 入口或重部署 nginx 时会顺手冲掉，
# 出问题也难判断是谁影响谁。
#
# 幂等：重复执行不会重复建用户、不会重复放行端口、不会覆盖已有 htpasswd；
# 会自动清理旧版（挂在 9000 那条 include）留下的痕迹。
#
# 用法：
#   scp -r deploy/registry root@192.168.156.203:/tmp/
#   ssh root@192.168.156.203 'bash /tmp/registry/install.sh'
#
#   可选参数：
#     --port <端口>     默认 9001
#     --skip-nginx      只装 registry，不起 nginx 站点

set -euo pipefail

BASE=/data/dsh-plugins
REGISTRY_DIR="$BASE/registry"
PUBLIC_DIR="$BASE/public"
SERVICE_USER=dsh-registry
PORT=9001
NGINX_CONF=/etc/nginx/conf.d/dsh-plugins.conf
LEGACY_CONF=/etc/nginx/conf.d/mcp-service.conf
LEGACY_SNIPPET=/etc/nginx/snippets/dsh-plugins.conf
SKIP_NGINX=0

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --skip-nginx) SKIP_NGINX=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '   \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 执行（要装 systemd 服务、改 nginx）"

for file in verdaccio.yaml dsh-registry.service nginx-dsh-plugins.conf; do
  [ -f "$SCRIPT_DIR/$file" ] || die "缺少 $SCRIPT_DIR/$file（请把整个 deploy/registry 目录传上来）"
done

command -v nginx >/dev/null || die "找不到 nginx，这台机器可能不是预期的部署目标"
command -v node  >/dev/null || die "找不到 node"
command -v npm   >/dev/null || die "找不到 npm"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || die "Verdaccio 需要 Node >= 18，当前 $(node -v)"

# ── 1. Verdaccio ────────────────────────────────────────────────────────────
say "1/6 安装 Verdaccio"
if command -v verdaccio >/dev/null; then
  ok "已安装：$(verdaccio --version 2>/dev/null || echo '版本未知')"
else
  # 走国内镜像：这台机器访问官方源常被掐。
  npm install -g verdaccio --registry=https://registry.npmmirror.com
  ok "已安装：$(verdaccio --version 2>/dev/null || echo '版本未知')"
fi
ok "可执行文件：$(command -v verdaccio)"

# ── 2. 用户与目录 ───────────────────────────────────────────────────────────
say "2/6 准备运行用户与目录"
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  ok "用户已存在：$SERVICE_USER"
else
  useradd --system --home-dir "$REGISTRY_DIR" --shell /sbin/nologin "$SERVICE_USER"
  ok "已创建系统用户：$SERVICE_USER"
fi

mkdir -p "$REGISTRY_DIR"/storage "$REGISTRY_DIR"/plugins "$PUBLIC_DIR"
[ -f "$REGISTRY_DIR/htpasswd" ] || : > "$REGISTRY_DIR/htpasswd"
chown -R "$SERVICE_USER:$SERVICE_USER" "$REGISTRY_DIR"
chmod 750 "$REGISTRY_DIR"
chmod 755 "$PUBLIC_DIR"
ok "$REGISTRY_DIR 归 $SERVICE_USER 所有；$PUBLIC_DIR 对 nginx 可读"

cp -f "$SCRIPT_DIR/verdaccio.yaml" "$REGISTRY_DIR/verdaccio.yaml"
chown "$SERVICE_USER:$SERVICE_USER" "$REGISTRY_DIR/verdaccio.yaml"
chmod 640 "$REGISTRY_DIR/verdaccio.yaml"
ok "配置已写到 $REGISTRY_DIR/verdaccio.yaml"

# ── 3. systemd ─────────────────────────────────────────────────────────────
say "3/6 安装并启动服务"
install -m 644 "$SCRIPT_DIR/dsh-registry.service" /etc/systemd/system/dsh-registry.service
systemctl daemon-reload
systemctl enable dsh-registry >/dev/null 2>&1 || true
systemctl restart dsh-registry

PING_OK=0
for _ in $(seq 1 20); do
  if curl -fsS --max-time 2 http://127.0.0.1:4873/-/ping >/dev/null 2>&1; then PING_OK=1; break; fi
  sleep 1
done
if [ "$PING_OK" -ne 1 ]; then
  systemctl status dsh-registry --no-pager -l | tail -30 || true
  die "Verdaccio 起不来，先看上面的 journal（常见：4873 被占用、目录权限）"
fi
ok "127.0.0.1:4873 已响应"

# ── 4. SELinux 与防火墙 ─────────────────────────────────────────────────────
say "4/6 SELinux 与防火墙"
if command -v getenforce >/dev/null && [ "$(getenforce)" = "Enforcing" ]; then
  # nginx 要能 bind 9001，否则 reload 直接失败。
  if command -v semanage >/dev/null; then
    semanage port -a -t http_port_t -p tcp "$PORT" 2>/dev/null \
      || semanage port -m -t http_port_t -p tcp "$PORT" 2>/dev/null \
      || warn "端口标签写入失败，需手工确认"
    semanage port -l | grep -q "http_port_t.*$PORT" && ok "SELinux 已允许 nginx 监听 $PORT"
  else
    warn "没有 semanage：$PORT 可能无法被 nginx 绑定（装 policycoreutils-python-utils）"
  fi
  # 静态索引：nginx 要能读 /data 下的文件。
  if command -v semanage >/dev/null; then
    semanage fcontext -a -t httpd_sys_content_t "$PUBLIC_DIR(/.*)?" 2>/dev/null \
      || semanage fcontext -m -t httpd_sys_content_t "$PUBLIC_DIR(/.*)?" 2>/dev/null || true
    restorecon -Rv "$PUBLIC_DIR" >/dev/null 2>&1 || true
    ok "已登记 $PUBLIC_DIR 的持久化标签"
  else
    chcon -Rt httpd_sys_content_t "$PUBLIC_DIR"
  fi
  if [ "$(getsebool httpd_can_network_connect 2>/dev/null | awk '{print $3}')" != "on" ]; then
    warn "httpd_can_network_connect=off：若 $PORT 返回 502，执行 setsebool -P httpd_can_network_connect 1"
  fi
else
  ok "SELinux 非 Enforcing，跳过"
fi

if systemctl is-active firewalld >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="$PORT"/tcp >/dev/null
  firewall-cmd --reload >/dev/null
  ok "firewalld 已放行 $PORT/tcp"
else
  warn "firewalld 未运行，跳过放行"
fi

# ── 5. nginx 独立站点 ──────────────────────────────────────────────────────
say "5/6 配置 nginx 独立站点"
if [ "$SKIP_NGINX" -eq 1 ]; then
  warn "已跳过（--skip-nginx）：请把 $SCRIPT_DIR/nginx-dsh-plugins.conf 放到 $NGINX_CONF 并按需改端口"
else
  # 清理旧版痕迹：旧脚本曾把 include 插进 MCP 的 server 块。
  if [ -f "$LEGACY_CONF" ] && grep -q "include $LEGACY_SNIPPET;" "$LEGACY_CONF"; then
    cp -a "$LEGACY_CONF" "$LEGACY_CONF.bak-dsh-cleanup-$(date +%Y%m%d%H%M%S)"
    sed -i "\|include $LEGACY_SNIPPET;|d" "$LEGACY_CONF"
    ok "已从 $LEGACY_CONF 移除旧版 include（备份保留）"
  fi
  if [ -f "$LEGACY_SNIPPET" ]; then
    rm -f "$LEGACY_SNIPPET"
    ok "已删除旧版片段 $LEGACY_SNIPPET"
  fi

  install -m 644 "$SCRIPT_DIR/nginx-dsh-plugins.conf" "$NGINX_CONF"
  sed -i "s/^    listen 9001;/    listen $PORT;/" "$NGINX_CONF"
  ok "站点配置已写到 $NGINX_CONF（listen $PORT）"

  if ! nginx -t >/tmp/nginx-t.log 2>&1; then
    cat /tmp/nginx-t.log >&2 || true
    die "nginx -t 不通过：多半是 $PORT 没有 SELinux 端口标签（见上一步）"
  fi
  systemctl reload nginx
  ok "nginx 已 reload"
fi

# ── 6. 自检 ────────────────────────────────────────────────────────────────
say "6/6 自检"
if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/-/ping" >/dev/null 2>&1; then
  ok "registry：http://<本机内网IP>:$PORT/ 可用"
else
  warn "经 nginx 访问 $PORT 失败，看 /var/log/nginx/error.log"
fi

if [ -f "$PUBLIC_DIR/index.json" ]; then
  ok "索引已就位：/plugins/index.json"
else
  warn "还没有 index.json：把 npm run index 生成的 build/index.json 传到这里"
fi

cat <<EOF

────────────────────────────────────────────────────────────
发布（在本机仓库根目录）：

  npm pack --ignore-scripts
  node scripts/publish.mjs <生成的.tgz> http://<服务器内网IP>:$PORT/

  用 publish.mjs 而不是 npm publish：npm 客户端要求先登录，
  而这个源是匿名可发的（publish: \$all）。

用户侧 .npmrc：

  @runner-corp:registry=http://<服务器内网IP>:$PORT/

索引源（DSH「插件 → 发现 → 索引源」）：

  http://<服务器内网IP>:$PORT/plugins/index.json

服务管理：

  systemctl status dsh-registry
  journalctl -u dsh-registry -n 50 --no-pager

数据目录（务必纳入备份）：

  $REGISTRY_DIR/storage
────────────────────────────────────────────────────────────
EOF
