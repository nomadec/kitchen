#!/usr/bin/env bash
# Install the space's server on one Linux host: Dolt and bd, the kitchen
# database, beads' custom types and events journal, Dolt as a systemd service
# bound to the Tailscale interface, and one SQL user per person.
#
# Run as root. Re-running creates nothing twice. Nothing secret is printed or
# put on a command line: the Dolt root password lives in /etc/kitchen/dolt.env
# and each person's credential in /etc/kitchen/credentials/<name>, both
# readable by root only, and reach Dolt and bd through the environment and
# standard input.
#
# usage: install-server.sh --interface IFACE --users FILE [--dry-run]
#                          [--database NAME] [--port PORT] [--bd-version VERSION]
#
# --dry-run prints every command the script would run on a fresh host and
# runs none of them. KITCHEN_SERVER_ROOT, when set, prefixes every path the
# script writes under /etc, /var/lib and /usr/local; tests use it.

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: install-server.sh --interface IFACE --users FILE [--dry-run]
                         [--database NAME] [--port PORT] [--bd-version VERSION]

  --interface IFACE     network interface the Dolt server binds to (tailscale0)
  --users FILE          one person per line; # starts a comment
  --dry-run             print the commands for a fresh host, run nothing
  --database NAME       the space's database (default: kitchen)
  --port PORT           the Dolt server port (default: 3307)
  --bd-version VERSION  the beads release to install (default: 1.3.1)
EOF
  exit 2
}

die() { printf 'install-server.sh: %s\n' "$*" >&2; exit 1; }

IFACE=
USERS=
DRY=0
DATABASE=kitchen
PORT=3307
BD_VERSION=1.3.1
DOLT_VERSION=2.6.2
# The sha256 of each dolt-linux-<arch>.tar.gz of that release, read from the archives themselves at the time of pinning.
dolt_sha256() {
  case $1 in
    amd64) echo e27a7957b8626946a5022fe0ad6ce4bfb3c8f51544c7f1372b0e6db14c1549cf ;;
    arm64) echo 0004e5927f6eeff40493c0800fe7aa7bb73750305968e58eb024de48116eaad6 ;;
  esac
}

while [ $# -gt 0 ]; do
  case $1 in
    --interface) [ $# -ge 2 ] || usage; IFACE=$2; shift 2 ;;
    --users) [ $# -ge 2 ] || usage; USERS=$2; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --database) [ $# -ge 2 ] || usage; DATABASE=$2; shift 2 ;;
    --port) [ $# -ge 2 ] || usage; PORT=$2; shift 2 ;;
    --bd-version) [ $# -ge 2 ] || usage; BD_VERSION=$2; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$IFACE" ] && [ -n "$USERS" ] || usage
[ -f "$USERS" ] || die "users file not found: $USERS"

PEOPLE=()
while IFS= read -r line || [ -n "$line" ]; do
  line=${line%%#*}
  line=$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  [ -n "$line" ] || continue
  printf '%s' "$line" | grep -Eq '^[a-z][a-z0-9_-]{0,31}$' \
    || die "not a person's name: '$line' (lowercase letters, digits, - and _, up to 32)"
  PEOPLE+=("$line")
done < "$USERS"
[ ${#PEOPLE[@]} -gt 0 ] || die "no people listed in $USERS"

ROOT=${KITCHEN_SERVER_ROOT:-}
ETC=$ROOT/etc/kitchen
LIB=$ROOT/var/lib/kitchen
DOLT_DIR=$LIB/dolt
SPACE_DIR=$LIB/space
BIN=$ROOT/usr/local/bin
UNIT=$ROOT/etc/systemd/system/kitchen-dolt.service
DOLT_RELEASES=https://github.com/dolthub/dolt/releases/download
BD_RELEASES=https://github.com/gastownhall/beads/releases/download

# A fresh host is what --dry-run describes; real runs probe the host.
fresh() { [ "$DRY" = 1 ]; }

# Every command is printed with a leading "+ ", then run unless --dry-run.
run() { printf '+ %s\n' "$*"; fresh || "$@"; }
run_sh() { printf '+ %s\n' "$1"; fresh || bash -c "$1"; }
# run_shown TEXT CMD...: printed as TEXT, which stands in for anything secret.
run_shown() { local shown=$1; shift; printf '+ %s\n' "$shown"; fresh || "$@"; }
# sha256_check SUM FILE: refuses a download whose checksum is not the pinned one.
sha256_check() { printf '%s  %s\n' "$1" "$2" | sha256sum --check --status || die "checksum mismatch on $2: not the pinned release"; }

# write_file PATH MODE OWNER < content: writes only when the content differs.
# Returns 0 when it wrote (or would write), 1 when the file already matched.
write_file() {
  local path=$1 mode=$2 owner=$3 content
  content=$(cat)
  if ! fresh && [ -f "$path" ] && [ "$(cat "$path")" = "$content" ]; then
    return 1
  fi
  printf '+ write %s (mode %s, owner %s)\n' "$path" "$mode" "$owner"
  printf '%s\n' "$content" | sed 's/^/    /'
  fresh && return 0
  mkdir -p "$(dirname "$path")"
  printf '%s\n' "$content" > "$path.tmp"
  chmod "$mode" "$path.tmp"
  chown "$owner" "$path.tmp"
  mv "$path.tmp" "$path"
}

# secret FILE: a 48-hex secret written once, root-only; fails rather than writes empty.
new_secret() {
  local value
  value=$(openssl rand -hex 24)
  [ ${#value} = 48 ] || die "openssl rand produced no secret"
  printf '%s' "$value"
}
root_password() { sed -n 's/^DOLT_ROOT_PASSWORD=//p' "$ETC/dolt.env"; }

# The server is administered as root over its own interface address: the
# root user is created as root@<address> on the service's first start, so it
# answers only connections from this host. The password travels in the
# environment, the SQL on standard input.
dolt_sql() { printf '%s;\n' "$1" | DOLT_CLI_PASSWORD=$(root_password) dolt --host "$ADDR" --port "$PORT" --user root --no-tls sql; }
dolt_sql_shown() { printf 'DOLT_CLI_PASSWORD=<from %s/dolt.env> dolt --host %s --port %s --user root --no-tls sql <<< "%s;"' "$ETC" "$ADDR" "$PORT" "$1"; }
bd_space() { HOME=$LIB BEADS_DOLT_PASSWORD=$(root_password) runuser -u kitchen -- bd -C "$SPACE_DIR" "$@"; }
bd_space_shown() { printf 'HOME=%s BEADS_DOLT_PASSWORD=<from %s/dolt.env> runuser -u kitchen -- bd -C %s %s' "$LIB" "$ETC" "$SPACE_DIR" "$*"; }

# 1. The interface address the server binds to.
run ip -4 -o addr show dev "$IFACE"
if fresh; then
  ADDR="<address of $IFACE>"
else
  ADDR=$(ip -4 -o addr show dev "$IFACE" | awk 'NR == 1 { split($4, a, "/"); print a[1] }')
  [ -n "$ADDR" ] || die "no IPv4 address on $IFACE"
fi

# 2. Dolt, the pinned release, verified against its checksum, into /usr/local/bin.
case $(uname -m) in
  x86_64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) die "no dolt or beads release for $(uname -m)" ;;
esac
if fresh || ! { command -v dolt >/dev/null 2>&1 && dolt version 2>/dev/null | grep -q "^dolt version $DOLT_VERSION$"; }; then
  DOLT_ARCHIVE=dolt-linux-$ARCH.tar.gz
  DOLT_SUM=$(dolt_sha256 "$ARCH")
  run_shown "mktemp -d" true
  if fresh; then TMP='<temp dir>'; else TMP=$(mktemp -d); fi
  run curl -fsSL -o "$TMP/$DOLT_ARCHIVE" "$DOLT_RELEASES/v$DOLT_VERSION/$DOLT_ARCHIVE"
  run_shown "sha256sum --check <<< \"<pinned sha256 for $ARCH>  $TMP/$DOLT_ARCHIVE\"" sha256_check "$DOLT_SUM" "$TMP/$DOLT_ARCHIVE"
  run tar -xzf "$TMP/$DOLT_ARCHIVE" -C "$TMP" "dolt-linux-$ARCH/bin/dolt"
  run install -o 0 -g 0 -m 755 "$TMP/dolt-linux-$ARCH/bin/dolt" "$BIN/dolt"
  run rm -rf "$TMP"
fi

# 3. bd, the pinned beads release, into /usr/local/bin.
BD_ARCH=$ARCH
if fresh || ! { command -v bd >/dev/null 2>&1 && bd version 2>/dev/null | grep -q "^bd version $BD_VERSION "; }; then
  BD_ARCHIVE=beads_${BD_VERSION}_linux_${BD_ARCH}.tar.gz
  run_shown "mktemp -d" true
  if fresh; then TMP='<temp dir>'; else TMP=$(mktemp -d); fi
  run curl -fsSL -o "$TMP/$BD_ARCHIVE" "$BD_RELEASES/v$BD_VERSION/$BD_ARCHIVE"
  run tar -xzf "$TMP/$BD_ARCHIVE" -C "$TMP" bd
  run install -o 0 -g 0 -m 755 "$TMP/bd" "$BIN/bd"
  run rm -rf "$TMP"
fi

# 4. The kitchen system user and the directories it works in.
if fresh || ! getent passwd kitchen >/dev/null 2>&1; then
  run useradd --system --home-dir "$LIB" --create-home --shell /usr/sbin/nologin kitchen
fi
for dir in "$DOLT_DIR" "$SPACE_DIR"; do
  if fresh || [ ! -d "$dir" ]; then run install -d -o kitchen -g kitchen -m 750 "$dir"; fi
done
if fresh || [ ! -d "$ETC" ]; then run install -d -o root -g root -m 755 "$ETC"; fi
if fresh || [ ! -d "$ETC/credentials" ]; then run install -d -o root -g root -m 700 "$ETC/credentials"; fi

# 5. The Dolt root password: generated once, read by systemd and by this script only.
write_root_env() {
  local password
  password=$(new_secret)
  (umask 077; printf 'DOLT_ROOT_PASSWORD=%s\n' "$password" > "$ETC/dolt.env")
  chown root:root "$ETC/dolt.env"
}
if fresh || [ ! -f "$ETC/dolt.env" ]; then
  run_shown "write $ETC/dolt.env (mode 600, owner root:root; DOLT_ROOT_PASSWORD from openssl rand -hex 24)" write_root_env
fi

# 6. The server config and its systemd unit.
CHANGED=0
if write_file "$ETC/dolt.yaml" 640 root:kitchen <<EOF
log_level: info
data_dir: $DOLT_DIR
listener:
  host: $ADDR
  port: $PORT
  max_connections: 100
EOF
then CHANGED=1; fi

if write_file "$UNIT" 644 root:root <<EOF
[Unit]
Description=Kitchen space: Dolt SQL server on $IFACE
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
User=kitchen
Group=kitchen
WorkingDirectory=$DOLT_DIR
Environment=HOME=$LIB
Environment=DOLT_ROOT_HOST=$ADDR
EnvironmentFile=$ETC/dolt.env
ExecStart=$BIN/dolt sql-server --config $ETC/dolt.yaml
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
then CHANGED=1; fi

if [ "$CHANGED" = 1 ]; then run systemctl daemon-reload; fi
if fresh || ! systemctl is-enabled --quiet kitchen-dolt 2>/dev/null; then
  run systemctl enable --now kitchen-dolt
elif [ "$CHANGED" = 1 ]; then
  run systemctl restart kitchen-dolt
fi

wait_for_server() {
  local i
  for i in $(seq 1 30); do
    dolt_sql "SELECT 1" >/dev/null 2>&1 && return 0
    sleep 1
  done
  die "the Dolt server did not answer on $ADDR:$PORT within 30s; see: journalctl -u kitchen-dolt"
}
run_shown "wait for $ADDR:$PORT to answer root" wait_for_server

# 7. The database.
run_shown "$(dolt_sql_shown "CREATE DATABASE IF NOT EXISTS $DATABASE")" \
  dolt_sql "CREATE DATABASE IF NOT EXISTS $DATABASE"

# 8. One SQL user per person. A credential is generated once and kept for
#    root; a person whose credential file is missing gets a new one, so
#    removing the file and re-running rotates it.
create_person() {
  local name=$1 file=$ETC/credentials/$1 password
  password=$(new_secret)
  (umask 077; printf '%s\n' "$password" > "$file")
  chown root:root "$file"
  if ! dolt_sql "DROP USER IF EXISTS '$name'@'%'; CREATE USER '$name'@'%' IDENTIFIED BY '$password'"; then
    rm -f "$file"
    return 1
  fi
}
for name in "${PEOPLE[@]}"; do
  if fresh || [ ! -f "$ETC/credentials/$name" ]; then
    run_shown "$(dolt_sql_shown "DROP USER IF EXISTS '$name'@'%'; CREATE USER '$name'@'%' IDENTIFIED BY '<credential kept in $ETC/credentials/$name>'")" \
      create_person "$name"
    run_shown "$(dolt_sql_shown "GRANT ALL ON $DATABASE.* TO '$name'@'%'")" \
      dolt_sql "GRANT ALL ON $DATABASE.* TO '$name'@'%'"
  fi
done

# 9. beads: the space's workspace on this host, the custom types and the events journal.
BD_INIT=(init --server --external --server-host "$ADDR" --server-port "$PORT" --server-user root
  --database "$DATABASE" --prefix "$DATABASE" --non-interactive --init-if-missing)
if fresh || [ ! -d "$SPACE_DIR/.beads" ]; then
  run_shown "$(bd_space_shown "${BD_INIT[@]}")" bd_space "${BD_INIT[@]}"
fi
run_shown "$(bd_space_shown config set types.custom phase,station,source)" \
  bd_space config set types.custom phase,station,source
run_shown "$(bd_space_shown config set events-journal true)" \
  bd_space config set events-journal true

printf 'The space %s listens on %s:%s for %d %s. Credentials are under %s/credentials.\n' \
  "$DATABASE" "$ADDR" "$PORT" "${#PEOPLE[@]}" "$([ ${#PEOPLE[@]} = 1 ] && echo person || echo people)" "$ETC"
