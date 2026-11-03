# Onboarding: a person, then a host

Kitchen has one team space: a `kitchen` database on a Dolt SQL server on rbn3, reached over Tailscale. Every person has one SQL credential, used by that person and by every station they own. Every host runs one expeditor and the stations registered on it. This doc walks both through to a first `kitchen status`.

The space starts empty. Nothing is imported from Umka.

## The server

`scripts/install-server.sh` sets up the server on rbn3, or on any Linux host that stands in for it. It installs Dolt and bd 1.3.1, creates the database, enables the custom bead types `phase`, `station` and `source` and the events journal through beads' config, runs Dolt as the `kitchen-dolt` systemd service bound to the Tailscale interface, and creates one SQL user per person listed in a file.

```sh
# people: one name per line, # starts a comment
sudo scripts/install-server.sh --interface tailscale0 --users people --dry-run
sudo scripts/install-server.sh --interface tailscale0 --users people
```

The dry run prints every command a fresh host would run and runs none. Without `--dry-run` the script probes the host first and prints only the commands it runs, with every secret shown as a placeholder: secrets reach Dolt and bd through the environment and standard input, never a command line. Re-running creates nothing twice: a person already in `/etc/kitchen/credentials/` keeps their credential, the service is only restarted when its config changed, and the beads config is set again to the same values. The last line printed names the address and port the space listens on; that is what every host points `kitchen init` at.

What ends up on the server:

| Path | What |
| --- | --- |
| `/etc/kitchen/dolt.yaml` | the server config: listener on the interface address, port 3307 |
| `/etc/kitchen/dolt.env` | `DOLT_ROOT_PASSWORD`, generated once, root-only |
| `/etc/kitchen/credentials/<name>` | one credential per person, generated once, root-only |
| `/etc/systemd/system/kitchen-dolt.service` | the service, as the `kitchen` system user |
| `/var/lib/kitchen/dolt` | the Dolt data directory, with the privileges database that holds the SQL users |
| `/var/lib/kitchen/space` | the bd workspace the script configures the space through |

The Dolt root user is created on the service's first start as `root@<interface address>`, so it answers connections from the server itself and nothing else on the tailnet. Dolt creates root only once, when its privileges database does not exist yet; a server moved to another address later keeps the old root and needs it re-created by hand.

To check the server: `systemctl status kitchen-dolt` and `journalctl -u kitchen-dolt`.

## Onboarding a person

A person needs one credential. The admin issues it; the person installs the tools and points `kitchen init` at the server.

### What the admin does, on rbn3

1. Add the person's name to the people file. Names are lowercase letters, digits, `-` and `_`. The name is the SQL user, the bead actor and the owner part of every station title, so pick the name they will sign writes with.
2. Re-run the script. Only the new person is created.
3. Read the credential and hand it over on a channel you trust. Do not paste it into the space, an issue or a commit.

```sh
sudo scripts/install-server.sh --interface tailscale0 --users people
sudo cat /etc/kitchen/credentials/<name>
```

### What the person does, on each of their hosts

1. Join the tailnet (`tailscale up`) and confirm rbn3 answers (`tailscale ping rbn3`).
2. Install bd 1.3.1, the release Kitchen targets, and `@nomadec/kitchen`. On Linux (`arm64` in place of `amd64` on an ARM host; on macOS the archive is `beads_1.3.1_darwin_arm64.tar.gz`):

   ```sh
   curl -fsSL -o /tmp/beads.tar.gz https://github.com/gastownhall/beads/releases/download/v1.3.1/beads_1.3.1_linux_amd64.tar.gz
   tar -xzf /tmp/beads.tar.gz -C /tmp bd && install -m 755 /tmp/bd ~/.local/bin/bd
   npm install -g @nomadec/kitchen
   ```

3. Put the credential where bd reads it. bd resolves the password for a server from `~/.config/beads/credentials`, an INI file keyed by the server's `host:port`, where the host is the address the install script printed (rbn3's Tailscale address, `tailscale ip -4 rbn3` from any host on the tailnet):

   ```ini
   [<rbn3 address>:3307]
   password = <the credential>
   ```

   Make the file readable by you only (`chmod 600`). The host config `kitchen init` writes refers to this file; it never holds the credential itself.

4. Run `kitchen init`. It takes the server address and port, the database name (`kitchen`), your name as the owner, this host's name and the credential reference, writes the host config under your config directory, and verifies the connection by running bd against the server. `kitchen init --help` has the flag names.

   ```sh
   kitchen init --server <rbn3 address>:3307 --database kitchen --owner <name>
   ```

   A failing connection prints the failing `bd` command's stderr. The usual causes are the credentials section not matching the exact `host:port`, Tailscale not up, or the service not running on rbn3.

5. `kitchen status`. On a host with no station yet it shows no expeditor, no running turns and whatever passes and stations the space already holds. That is the first status: the person is in.

To rotate a person's credential, remove `/etc/kitchen/credentials/<name>` and re-run the script: the SQL user is re-created with a new one and the old one stops working. A person who leaves is dropped by the admin on rbn3 with `DROP USER '<name>'@'%'`, sent as root the way the script sends its SQL (the `dolt --host <address> --port 3307 --user root --no-tls sql` line it prints, with the password from `/etc/kitchen/dolt.env` in `DOLT_CLI_PASSWORD`), and by removing the credential file; the script does not remove people.

## Onboarding a host

A host is a machine with one expeditor and the stations registered on it. Each host only runs stations owned by the person signed in there (ADR 0003).

1. Do the person steps above on the host, through `kitchen init`.
2. Check out, on this host, every repository the stations here will offer, and install the plugins and tooling those stations advertise. A station is a prepared place (ADR 0005): the checkouts, tooling and models are what the laying turn reads when it chooses where a phase goes.
3. Register a station from a template, adding the values only this host knows:

   ```sh
   kitchen station add <template> --repo <slug>=<local path> --cap 1 --timeout 45m
   ```

   The template is a `station.json` file, from a plugin or on disk, and gives the shape. You supply the owner (defaulted from `kitchen init`), the host (defaulted from the host config), the local path of each repository the template offers, the cap, the wall-clock timeout, the names of any secrets (`--secret`) and whether a human sits at this station (`--attended`). The result is a `station` bead titled `<owner>/<name>`. Registration is a human act: it runs under your bare actor and is refused under a station actor. `docs/registration.md` shows an example template and the bead it becomes, and how to register a polled source with `kitchen source add`.

4. Start the expeditor as a user service:

   ```sh
   kitchen up
   ```

   On Linux this installs a systemd user service, on macOS a launchd agent; `kitchen down` removes it. The expeditor polls the space for phases assigned to this host's stations, starts unattended ones up to each station's cap, and lists attended ones as waiting for you to run with `kitchen turn <phase>`.

5. `kitchen status` now shows the expeditor running with its last tick, this host's stations with their caps, running turns, waiting attended phases and open passes. The host is in.

## What is shared and what is not

- The space is shared: every person and every station reads and writes the same graph, each write under its actor.
- A credential is per person and shared with that person's stations only. The trust model is cooperative: Kitchen's `bd` wrapper, CLI and UI refuse station writes to `phase`, `station` and `source` beads and the closing of a pass, and nothing stops a station that reaches bd, the HTTP API or the database directly. Hand a credential to a person, never to a bead.
- The Dolt root user is the server's own and is never handed out.
