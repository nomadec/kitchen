// The server install script, exercised through the commands it prints and
// runs and the files it writes. Real runs go through stub commands on PATH
// that record every call, under a temporary root (KITCHEN_SERVER_ROOT).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const script = path.join(here, "install-server.sh");
const bdArch = process.arch === "arm64" ? "arm64" : "amd64";

type Outcome = { status: number | null; stdout: string; stderr: string };

function scratch(t: { after(fn: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-install-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function people(dir: string, names: string[]): string {
  const file = path.join(dir, "people");
  fs.writeFileSync(file, `# the team\n${names.map((n) => `${n}\n`).join("")}\n`);
  return file;
}

function install(args: string[], env: Record<string, string> = {}): Outcome {
  const r = spawnSync("bash", [script, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const commands = (out: string) =>
  out.split("\n").filter((l) => l.startsWith("+ ")).map((l) => l.slice(2));

test("a dry run prints the command sequence for a fresh host and runs nothing", (t) => {
  const dir = scratch(t);
  const root = path.join(dir, "root");
  const r = install(["--interface", "tailscale0", "--users", people(dir, ["sona", "raffy"]), "--dry-run"], {
    KITCHEN_SERVER_ROOT: root,
  });
  assert.equal(r.status, 0, r.stderr);
  const dolt = `DOLT_CLI_PASSWORD=<from ${root}/etc/kitchen/dolt.env> dolt --host <address of tailscale0> --port 3307 --user root --no-tls sql <<<`;
  const bd = `HOME=${root}/var/lib/kitchen BEADS_DOLT_PASSWORD=<from ${root}/etc/kitchen/dolt.env> runuser -u kitchen -- bd -C ${root}/var/lib/kitchen/space`;
  assert.deepEqual(commands(r.stdout), [
    "ip -4 -o addr show dev tailscale0",
    "curl -fsSL https://github.com/dolthub/dolt/releases/latest/download/install.sh | bash",
    "mktemp -d",
    `curl -fsSL -o <temp dir>/beads_1.3.1_linux_${bdArch}.tar.gz https://github.com/gastownhall/beads/releases/download/v1.3.1/beads_1.3.1_linux_${bdArch}.tar.gz`,
    `tar -xzf <temp dir>/beads_1.3.1_linux_${bdArch}.tar.gz -C <temp dir> bd`,
    `install -o 0 -g 0 -m 755 <temp dir>/bd ${root}/usr/local/bin/bd`,
    "rm -rf <temp dir>",
    `useradd --system --home-dir ${root}/var/lib/kitchen --create-home --shell /usr/sbin/nologin kitchen`,
    `install -d -o kitchen -g kitchen -m 750 ${root}/var/lib/kitchen/dolt`,
    `install -d -o kitchen -g kitchen -m 750 ${root}/var/lib/kitchen/space`,
    `install -d -o root -g root -m 755 ${root}/etc/kitchen`,
    `install -d -o root -g root -m 700 ${root}/etc/kitchen/credentials`,
    `write ${root}/etc/kitchen/dolt.env (mode 600, owner root:root; DOLT_ROOT_PASSWORD from openssl rand -hex 24)`,
    `write ${root}/etc/kitchen/dolt.yaml (mode 640, owner root:kitchen)`,
    `write ${root}/etc/systemd/system/kitchen-dolt.service (mode 644, owner root:root)`,
    "systemctl daemon-reload",
    "systemctl enable --now kitchen-dolt",
    "wait for <address of tailscale0>:3307 to answer root",
    `${dolt} "CREATE DATABASE IF NOT EXISTS kitchen;"`,
    `${dolt} "DROP USER IF EXISTS 'sona'@'%'; CREATE USER 'sona'@'%' IDENTIFIED BY '<credential kept in ${root}/etc/kitchen/credentials/sona>';"`,
    `${dolt} "GRANT ALL ON kitchen.* TO 'sona'@'%';"`,
    `${dolt} "DROP USER IF EXISTS 'raffy'@'%'; CREATE USER 'raffy'@'%' IDENTIFIED BY '<credential kept in ${root}/etc/kitchen/credentials/raffy>';"`,
    `${dolt} "GRANT ALL ON kitchen.* TO 'raffy'@'%';"`,
    `${bd} init --server --external --server-host <address of tailscale0> --server-port 3307 --server-user root --database kitchen --prefix kitchen --non-interactive --init-if-missing`,
    `${bd} config set types.custom phase,station,source`,
    `${bd} config set events-journal true`,
  ]);
  assert.match(r.stdout, /^\s+host: <address of tailscale0>$/m, "the server config binds to the interface address");
  assert.match(r.stdout, /^\s+Environment=DOLT_ROOT_HOST=<address of tailscale0>$/m, "root answers this host only");
  assert.match(r.stdout, /^\s+ExecStart=.*dolt sql-server --config .*\/etc\/kitchen\/dolt\.yaml$/m);
  assert.doesNotMatch(r.stdout, /[0-9a-f]{48}/, "no generated secret is printed");
  assert.equal(fs.existsSync(root), false, "a dry run writes nothing");
});

test("the interface, the port and the database are taken from the arguments", (t) => {
  const dir = scratch(t);
  const r = install(["--interface", "wg0", "--port", "3310", "--database", "pantry", "--users", people(dir, ["sona"]), "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\s+host: <address of wg0>$/m);
  assert.match(r.stdout, /^\s+port: 3310$/m);
  const dolt = "DOLT_CLI_PASSWORD=<from /etc/kitchen/dolt.env> dolt --host <address of wg0> --port 3310 --user root --no-tls sql <<<";
  assert.ok(commands(r.stdout).includes(`${dolt} "CREATE DATABASE IF NOT EXISTS pantry;"`));
  assert.ok(commands(r.stdout).includes(`${dolt} "GRANT ALL ON pantry.* TO 'sona'@'%';"`));
});

test("the interface and the users file are required, and a name must be a person's", (t) => {
  const dir = scratch(t);
  assert.equal(install(["--interface", "tailscale0", "--dry-run"]).status, 2);
  assert.match(install(["--users", people(dir, ["sona"]), "--dry-run"]).stderr, /^usage:/);
  const bad = install(["--interface", "tailscale0", "--users", people(dir, ["Sona Q"]), "--dry-run"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not a person's name: 'Sona Q'/);
  assert.match(install(["--interface", "tailscale0", "--users", people(dir, []), "--dry-run"]).stderr, /no people listed/);
});

// Stub commands on PATH: each records its argv (dolt also its standard input,
// bd also the environment it was given), and the few with state answer from
// marker files so the second run sees what the first one created.
function stubs(dir: string): { bin: string; log: string; calls(): string[] } {
  const bin = path.join(dir, "bin");
  const state = path.join(dir, "state");
  const log = path.join(dir, "calls.log");
  fs.mkdirSync(bin);
  fs.mkdirSync(state);
  const stub = (name: string, body: string) => {
    const file = path.join(bin, name);
    fs.writeFileSync(file, `#!/bin/bash\nprintf '%s\\n' "${name} $*" >> "${log}"\n${body}\n`);
    fs.chmodSync(file, 0o755);
  };
  stub("runuser", 'shift 3; exec "$@"');
  stub("ip", 'echo "5: tailscale0    inet 100.64.0.7/32 scope global tailscale0"');
  stub("dolt", `[ -t 0 ] || printf 'dolt-stdin %s\\n' "$(cat)" >> "${log}"; exit 0`);
  stub("bd", `printf 'bd-env HOME=%s BEADS_DOLT_PASSWORD=%s\\n' "$HOME" "\${BEADS_DOLT_PASSWORD:-}" >> "${log}"; [ "$1" = version ] && echo "bd version 1.3.1 (stub)"; [ "$3" = init ] && mkdir -p "$2/.beads"; exit 0`);
  stub("getent", `[ -e "${state}/user" ]`);
  stub("useradd", `touch "${state}/user"; while [ $# -gt 0 ]; do [ "$1" = --home-dir ] && mkdir -p "$2"; shift; done`);
  stub("chown", "exit 0");
  stub("install", 'if [ "$1" = -d ]; then while [ "${1:0:1}" = - ]; do case $1 in -o|-g|-m) shift 2;; *) shift;; esac; done; mkdir -p "$@"; else cp "${@: -2:1}" "${@: -1}"; fi');
  stub("systemctl", `case $1 in is-enabled) [ -e "${state}/enabled" ];; enable) touch "${state}/enabled";; esac`);
  stub("curl", "exit 1");
  stub("tar", "exit 1");
  return { bin, log, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []) };
}

test("re-running creates nothing twice, and secrets travel by environment and stdin only", (t) => {
  const dir = scratch(t);
  const root = path.join(dir, "root");
  const s = stubs(dir);
  const env = { PATH: `${s.bin}:${process.env.PATH}`, KITCHEN_SERVER_ROOT: root };
  const args = ["--interface", "tailscale0", "--users", people(dir, ["sona", "raffy"])];

  const first = install(args, env);
  assert.equal(first.status, 0, first.stderr);
  const firstCalls = s.calls();
  assert.ok(firstCalls.includes(`useradd --system --home-dir ${root}/var/lib/kitchen --create-home --shell /usr/sbin/nologin kitchen`));
  assert.ok(firstCalls.includes("systemctl enable --now kitchen-dolt"));
  assert.equal(firstCalls.filter((c) => c.startsWith("dolt-stdin ") && c.includes("CREATE USER")).length, 2);
  assert.ok(firstCalls.some((c) => c.startsWith("bd -C ") && c.includes(" init --server --external --server-host 100.64.0.7 --server-port 3307 --server-user root ")));
  assert.match(fs.readFileSync(path.join(root, "etc/kitchen/dolt.yaml"), "utf8"), /^  host: 100\.64\.0\.7$/m, "bound to the interface address");
  assert.match(fs.readFileSync(path.join(root, "etc/systemd/system/kitchen-dolt.service"), "utf8"), /^Environment=DOLT_ROOT_HOST=100\.64\.0\.7$/m);
  const rootEnv = fs.readFileSync(path.join(root, "etc/kitchen/dolt.env"), "utf8");
  assert.match(rootEnv, /^DOLT_ROOT_PASSWORD=[0-9a-f]{48}\n$/);
  const rootPassword = (rootEnv.split("=")[1] ?? "").trim();
  const sona = fs.readFileSync(path.join(root, "etc/kitchen/credentials/sona"), "utf8").trim();
  assert.match(sona, /^[0-9a-f]{48}$/);
  assert.ok(firstCalls.includes(`dolt-stdin DROP USER IF EXISTS 'sona'@'%'; CREATE USER 'sona'@'%' IDENTIFIED BY '${sona}';`), "the SQL user gets the kept credential");
  assert.ok(firstCalls.includes(`bd-env HOME=${root}/var/lib/kitchen BEADS_DOLT_PASSWORD=${rootPassword}`), "bd gets the root password by environment");
  for (const secret of [sona, rootPassword]) {
    assert.ok(!firstCalls.some((c) => !c.startsWith("dolt-stdin ") && !c.startsWith("bd-env ") && c.includes(secret)), "no secret on a command line");
    assert.doesNotMatch(first.stdout + first.stderr, new RegExp(secret), "no secret printed");
  }

  fs.writeFileSync(s.log, "");
  const second = install(args, env);
  assert.equal(second.status, 0, second.stderr);
  const again = s.calls();
  for (const created of ["useradd", "install ", "CREATE USER", "GRANT", "systemctl daemon-reload", "systemctl enable", "systemctl restart", " init ", "curl", "tar"]) {
    assert.ok(!again.some((c) => c.includes(created)), `second run repeats: ${again.filter((c) => c.includes(created)).join("; ")}`);
  }
  assert.doesNotMatch(second.stdout, /^\+ write /m, "no file is rewritten");
  assert.equal(fs.readFileSync(path.join(root, "etc/kitchen/credentials/sona"), "utf8").trim(), sona, "a credential is never regenerated");
  assert.equal(fs.readFileSync(path.join(root, "etc/kitchen/dolt.env"), "utf8"), rootEnv);
  assert.ok(again.includes(`bd -C ${root}/var/lib/kitchen/space config set types.custom phase,station,source`));
  assert.ok(again.includes(`bd -C ${root}/var/lib/kitchen/space config set events-journal true`));
});

test("a person added to the list later is created on the next run, and a removed credential file rotates one", (t) => {
  const dir = scratch(t);
  const root = path.join(dir, "root");
  const s = stubs(dir);
  const env = { PATH: `${s.bin}:${process.env.PATH}`, KITCHEN_SERVER_ROOT: root };
  assert.equal(install(["--interface", "tailscale0", "--users", people(dir, ["sona"])], env).status, 0);
  const sona = fs.readFileSync(path.join(root, "etc/kitchen/credentials/sona"), "utf8");
  fs.rmSync(path.join(root, "etc/kitchen/credentials/sona"));
  fs.writeFileSync(s.log, "");
  const r = install(["--interface", "tailscale0", "--users", people(dir, ["sona", "steffen"])], env);
  assert.equal(r.status, 0, r.stderr);
  const users = s.calls().filter((c) => c.startsWith("dolt-stdin ") && c.includes("CREATE USER")).map((c) => c.match(/CREATE USER '([a-z]+)'/)![1]);
  assert.deepEqual(users, ["sona", "steffen"]);
  assert.notEqual(fs.readFileSync(path.join(root, "etc/kitchen/credentials/sona"), "utf8"), sona, "a new credential replaces the removed one");
  assert.ok(fs.existsSync(path.join(root, "etc/kitchen/credentials/steffen")));
  assert.ok(!s.calls().some((c) => c.startsWith("useradd")));
});

test("a changed port rewrites the server config and restarts the service", (t) => {
  const dir = scratch(t);
  const root = path.join(dir, "root");
  const s = stubs(dir);
  const env = { PATH: `${s.bin}:${process.env.PATH}`, KITCHEN_SERVER_ROOT: root };
  const list = people(dir, ["sona"]);
  assert.equal(install(["--interface", "tailscale0", "--users", list], env).status, 0);
  fs.writeFileSync(s.log, "");
  const r = install(["--interface", "tailscale0", "--port", "3308", "--users", list], env);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(commands(r.stdout).includes(`write ${root}/etc/kitchen/dolt.yaml (mode 640, owner root:kitchen)`));
  assert.ok(s.calls().includes("systemctl daemon-reload"));
  assert.ok(s.calls().includes("systemctl restart kitchen-dolt"));
  assert.ok(!s.calls().some((c) => c.startsWith("useradd")));
});
