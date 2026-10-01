# Prompt: comprehensive host security audit (universal), v2

> Reusable: change HOST/SSH_USER and run it against any host (bare server, docker host,
> k8s node, DB, balancer, storage, backup server). Incident IOCs live in the local file
> `IR_IOC_FILE` (IR mode only, see Appendix B).
> v2 (30.09.2026): incorporates the review of the first run (GLM) by Claude + Codex. Main lessons:
> trust chains and outbound keys, the backup route, real reachability instead of bind address,
> cron semantics, masking before writing to disk, log coverage, `[C]` self-check.
> v2.1 (30.09.2026, second run, telemetry host): the masker catches `curl -u user:pass` and leaves
> `NOPASSWD:`/`PWD=` alone; a unique `AUDIT_DIR` per run; two firewall backends; non-interactive
> SSH sessions are not visible in `last`; VMs cloned from templates; new Block O for telemetry hosts.
> v2.2 (01.10.2026, run against a three-node k8s control plane): all audit artifacts go to
> `AUDIT_BASE/` (not the repository root); Block F extended with control-plane specifics (octant/dashboards,
> etcd encryption and snapshots, apiserver audit, NodePort exposure, cluster-admin on SAs).
> v2.3 (01.10.2026): new Block V: version inventory, EOL status, cross-check against vendor bulletins
> and version-dependent configuration misses for each component; version table in the report.

---

## PARAMETERS

```
HOST=<host>
SSH_USER=$USER
AUDIT_BASE=./audits                       # ONE folder for all hosts/runs; do NOT litter the repository root
AUDIT_AGENT=claude                        # name of the AI agent running the audit: claude | codex | zcode | glm | ...
AUDIT_DIR=${AUDIT_BASE}/$(date -u +%Y%m%d)/${HOST}_${AUDIT_AGENT}_$(date -u +%H%M)   # MANDATORY: folder name = <host>_<agent>_<HHMM>; the agent name is required to tell runs of different models apart and avoid collisions
IR_MODE=0              # 1 = enable Appendix B (incident IOCs)
IR_IOC_FILE=~/.verus-skills/host-audit/ioc.md   # incident IOCs, outside the repository (Appendix B)
IR_WINDOW_START=<YYYY-MM-DD>   # start of the compromise window (for IR and backup assessment)
ALLOW_LOCAL_PROBES=0   # 1 = read-only probes against the host's 127.0.0.1 are allowed (see rule 2)
REPORT_LANG=<language>   # language of the report and of findings.json string values (keys, IDs, commands, evidence stay as they are)
```

## ROLE AND TASK

You are a security engineer performing an authorized audit of a production host. Goal:
(1) map the attack surface and **actual** reachability; (2) find
misconfigurations and weaknesses; (3) build the trust graph: who can get onto the host and where
one can get from it; (4) check for traces of compromise and persistence; (5) deliver a report
with priorities, where every finding is described as an attack path, not as an isolated fact.
You do not know in advance what is on the host; Phase 0 decides which blocks to dig into deeper.

## IRON RULES

1. **Read only.** Change nothing, restart nothing, install nothing, delete nothing, rotate nothing,
   create no files on the host. Forbidden: `kill`, `systemctl restart/reload/start/stop`,
   `apt/pip install`, `docker exec` with mutations, `redis-cli SET/FLUSH/CONFIG SET`, SQL with
   WRITE/DDL, `gluster volume set/start/stop`, `barman backup/delete/keep/cron`, `chmod/chown`.
   Allowed `docker exec`: only `cat`, `ls`, `stat`, `ss`, `ps`, `grep`, `head`, `find` without `-delete/-exec`.
   Allowed: `nsenter -t <PID> -n ss -ltnp` (viewing sockets in a container's netns).
2. **Do not generate traffic on the host's behalf**: no curl/wget/nc/ncat/psql/redis-cli to other
   hosts, no "port checks" by connecting, no client commands that reach out to the
   network themselves (`barman check`, `barman show-server`, `barman status`, `mount -t glusterfs`: forbidden;
   local queries to the host's own daemon, `gluster volume get/status/info`, `barman list-backup`: allowed).
   Passive analysis only (`ss`, configs, logs, conntrack).
   Exception with `ALLOW_LOCAL_PROBES=1`: `curl -sS -o /dev/null -w '%{http_code}' -I http://127.0.0.1:<port>/`
   (HEAD to localhost, no creds) to check whether the service requires authentication.
3. `sudo -n` only, passwordless; if it asks for a password, skip and mark "insufficient privileges".
   `lsmod/modinfo/sshd/iptables` live in `/sbin`, `/usr/sbin`; add them to PATH or call by full path.
4. **Secrets are masked BEFORE writing to disk**, not only in the report. All output goes through
   the runner from Appendix A (the `$MASK` filter) into files with `umask 077`. Do not save raw:
   `ps aux`/`ps -ef` with arguments, crontab, `docker inspect ... Env`, bash histories, full
   configs with passwords, `.pgpass`, private keys. For secrets record **the fact of presence, path,
   owner, permissions, mtime/ctime, length**, not the value. Never `cat` private keys,
   only `stat` and `ssh-keygen -lf` for `.pub`. After the run: `gitleaks detect --no-git -s $AUDIT_DIR`
   (or `trufflehog filesystem`); any hit: re-mask and record it in the report as an incident.
5. **Command log.** For every command: UTC start and end time, exit code, stderr (into `.err`),
   line count. Do not use `2>/dev/null` to suppress errors; the runner collects stderr;
   "Permission denied" must reach the report as a coverage limitation. Write the **full**
   output to raw files; `head` is for viewing only. If limiting the sample is unavoidable
   (`head -N`, `-maxdepth`, `timeout`), note it in `_commands.tsv` (`truncated`/`timeout`).
6. **Confidence labels** (mandatory on every claim):
   - `[C-cfg]`: configuration/state confirmed by output (file:line);
   - `[C-reach]`: reachability confirmed (firewall rule, log entry of a connection
     from that network, conntrack, NAT rule on the perimeter);
   - `[C-act]`: activity confirmed by logs (who, when, from where);
   - `[U]`: inference or assumption; must state what is needed to confirm it.
   Times in UTC. Every `[C-*]` must reference a raw file and line.
7. Heavy operations: `timeout 300 nice -n19 ionice -c3 ...`, with `-maxdepth/-mtime/-xdev`;
   avoid peak hours. Commands that can bring a service down (dumping a large DB, `find /`
   over a multi-terabyte volume): do not run, note them under "Not checked".
8. **Everything goes in `AUDIT_BASE/`, nothing in the root.** Raw output, `findings.json` and the report itself
   `AUDIT_<host|cluster>_<date>.md` go into `$AUDIT_DIR` (or into `$AUDIT_BASE/<date>/` for
   a consolidated report across several nodes). **The run directory name format is strictly
   `<host>_<AUDIT_AGENT>_<HHMM>`**, where `AUDIT_AGENT` is the name of the AI agent running the audit
   (`claude` | `codex` | `zcode` | `glm` | …). The agent name is mandatory: it tells runs of
   different models apart and rules out collisions when several agents audit the same host. Do not write to the
   repository root or to git-tracked paths. **One run, one directory**: if
   `$AUDIT_DIR` already exists and is not empty, create a new one (add a time suffix). Do not touch another
   agent's files, but note them in the report (especially if they contain plaintext secrets).
9. **Audit noise.** Record `AUDIT_START`/`AUDIT_END` (UTC). Exclude your own `sudo`/`sshd`
   lines in auth.log/journal from the IOC search by that window and the `$SSH_USER` name, but
   mention this in the report.

## SEVERITY CRITERIA

Severity is assigned to an **attack path**, not to an isolated fact. For every finding describe:
*who the attacker is → which boundary they cross → what they get*. A fact on its own
(no host firewall, `NOPASSWD`, `.pgpass` 0600, a service on 0.0.0.0) is not P0/P1 until
a path across an access boundary is described.

- **P0**: a path from an untrusted zone (internet, user/prod segments where an attacker
  has already been) to privileges or data, where **every link** is `[C-*]`; default/empty creds;
  anonymous exec/API (docker 2375, kubelet 10250, etcd 2379 without auth, redis without ACL);
  traces of active attacker access (`[C-act]`).
- **P1**: the same, but at least one link is `[U]` (e.g. reachability not proven); then
  write "P0 provided X" and what to check; weak hardening that enables escalation or a pivot
  (docker group, NOPASSWD sudo for accounts with a password, hostPath rw, plaintext secrets
  readable by a non-owner, EOL software with known CVEs); missing logs/audit on a key host.
- **P2**: hygiene: old packages, weak TLS, headers, monitoring, documentation mismatch.

Modifiers:
- **Chains.** Two P1/P2 findings that together form a P0-level path are written up as a separate
  chain finding (referencing its links) and get P0/P1 by the rule above.
- **Crown-jewel host** (backups, secret stores, CI, IdP/LDAP, k8s control plane, DBs with
  personal/payment data): raise by one level everything that gives access to data or keys.
- **Blast radius** must always be stated: how many hosts, systems and data are affected.

---

# PHASE 0. Host identification (mandatory, determines the routes)

```
hostnamectl; uname -a; cat /etc/os-release; systemd-detect-virt
uptime; timedatectl | grep -E 'synchronized|Time zone'; df -hT; lsblk; findmnt -t nfs,nfs4,cifs,fuse.glusterfs,ceph,fuse.sshfs
ip -br a; ip route show table all | grep -v '^local\|^broadcast'; ip rule; cat /etc/resolv.conf
command -v docker kubectl crictl ctr podman nerdctl etcdctl gluster barman borg restic 2>&1
systemctl list-units --type=service --state=running --no-pager
ps -eo user,pid,ppid,lstart,rss,comm --sort=-rss | head -40     # WITHOUT args (secrets in arguments)
ls /etc/kubernetes/ /var/lib/kubelet /etc/docker /etc/containerd
getent passwd | awk -F: '{print $1,$3,$6,$7}'                    # home directories, not only /home/*
```

Classify the host; routes add up:
- nginx/apache/openresty/caddy/web containers → **Block G**
- docker/podman/containerd → **Block E**
- /etc/kubernetes or kubelet → **Block F** (if `/etc/kubernetes/manifests/kube-apiserver.yaml` or etcd is present → section **F.2 Control plane**)
- PG/MySQL/Redis/RabbitMQ/Mongo/CH/ES/etcd/memcached → **Block H**
- Gluster/NFS/SMB/Ceph/MinIO/seafile, **as well as barman/BackupPC/borg/restic/bacula/rsync backups** → **Block I**
- Jaeger/OTel/Tempo/Zipkin/Prometheus/Grafana/Loki/ELK agents/Sentry → **Block O**
- always → **Phase 1, Blocks C, D, T, J, K, V**.

Note network and data volumes (findmnt): `-xdev` skips them, so below they are checked
**in a targeted way** (home directories of service users, config directories of backup tools),
not with a blanket `find`.

# PHASE 1. Attack surface and actual reachability (always)

Remember: `0.0.0.0` in `ss` is a **bind address**, not access from the internet. Reachability
is made up of the bind address, host firewall (INPUT **and** FORWARD/DOCKER-USER), docker publish,
perimeter NAT, external ACLs/security groups and IPv6.

```
ss -ltnup; ss -lxp | head -50                    # TCP/UDP + unix sockets (docker.sock etc.)
ss -tnp state established                        # who is talking to whom right now
sudo -n iptables-save; sudo -n ip6tables-save; sudo -n nft list ruleset   # in full, not -L INPUT
sudo -n iptables -V; sudo -n update-alternatives --display iptables | head -3; sudo -n iptables-legacy-save | head -3; sudo -n nft list tables
# ↑ two backends (legacy + nft) run SIMULTANEOUSLY; the effective policy is the intersection; take counters twice with a 30 s pause to see what actually matches
sudo -n ufw status verbose; sudo -n firewall-cmd --list-all
sudo -n sysctl net.ipv4.ip_forward net.ipv4.conf.all.rp_filter net.ipv4.conf.all.accept_redirects net.ipv6.conf.all.forwarding
ip -6 addr show scope global                     # are there global IPv6 addresses (otherwise [::] = link-local only)
sudo -n conntrack -L 2>&1 | head -50             # if installed: real external sources, NAT
# traces of external access: public IPs in login logs (not 10/8, 172.16/12, 192.168/16)
sudo -n zgrep -hE 'Failed|Invalid user|Accepted' /var/log/auth.log* /var/log/secure* | grep -vE ' (10|127)\.| 172\.(1[6-9]|2[0-9]|3[01])\.| 192\.168\.' | awk '{print $1,$2,$(NF-3)}' | sort | uniq -c | sort -rn | head -30
# outbound access (egress)
ip route get 1.1.1.1; ss -tnp state established | awk 'NR>1{print $4}' | grep -vE '^(10\.|127\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|\[)' | sort | uniq -c
```

For every non-localhost listener fill in a map row: port → process → bind address →
authentication → **reachable from where** (`[C-reach]`/`[U]`) → should it be reachable.
Analysis rules:
- **Docker publish** (`docker-proxy`, DNAT in `nat/DOCKER`) bypasses INPUT: traffic goes through
  FORWARD → `DOCKER-USER` → `DOCKER`. INPUT rules do not close it. Check `DOCKER-USER`.
  In `DOCKER-USER` the port is already **post-DNAT** (the container port): a rule on the host port (`--dport 16687`
  with a `16687→16686` mapping) is a no-op; the correct form is `-m conntrack --ctorigdstport <host port>`.
  Check the counters of `iptables -L DOCKER -nvx`: an ACCEPT without a source with millions of packets = the port
  is open to everyone, whatever INPUT looks like.
- Assess `ip_forward=1` together with the FORWARD policy: on docker hosts it is usually DROP, but
  `-i br-* ! -o br-* -j ACCEPT` lets containers out into all of the host's segments.
- Multihoming (several VLANs) + a weak firewall = the host bridges segments; describe which
  segments it connects.
- Public IPs in auth logs = `[C-reach]` for SSH from the internet (through some NAT); find
  which perimeter port forward provides it, and move it to "Adjacent checks".
- An external DNS resolver (8.8.8.8 etc.) and a direct default route = no egress control.

# BLOCK C. Base OS hardening and accounts (always)

```
# SSH: global and effective per specific users/sources (Match!)
sudo -n sshd -T | grep -Ei '^(port|listenaddress|permitrootlogin|passwordauthentication|kbdinteractive|pubkeyauthentication|authenticationmethods|allowusers|allowgroups|denyusers|maxauthtries|logingracetime|allowtcpforwarding|allowagentforwarding|x11forwarding|permittunnel|gatewayports|permituserenvironment|loglevel|authorizedkeysfile|authorizedkeyscommand)'
ls -la /etc/ssh/sshd_config.d/; sudo -n grep -nE '^\s*Match' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*
for u in <service and staff accounts>; do echo "== $u"; sudo -n sshd -T -C user=$u,host=x,addr=198.51.100.1 | grep -Ei 'passwordauth|allowtcpforwarding|permittty|forcecommand'; done
ssh -V
# Users: who has a password hash and when it was changed (do NOT print the hash)
sudo -n awk -F: '{s=($2 ~ /^\$/)?"HASH":($2 ~ /^!/)?"LOCKED":"NOPW("$2")"; print $1,s,"lastchg_days="$3}' /etc/shadow
awk -F: '($3==0 && $1!="root")' /etc/passwd                      # extra uid 0
getent passwd | awk -F: '$7 !~ /(false|nologin)$/ {print $1,$3,$6,$7}'   # who has a shell (empty = /bin/sh!)
grep -E '^(passwd|group|shadow|sudoers)' /etc/nsswitch.conf; ls /etc/sssd 2>&1   # LDAP/SSSD users
# sudo
sudo -n cat /etc/sudoers; sudo -n ls -la /etc/sudoers.d/; sudo -n grep -vhE '^#|^$' /etc/sudoers.d/*
getent group sudo wheel admin docker lxd libvirt disk adm
# Filesystem
sudo -n find / -xdev -perm -4000 -type f | sort
sudo -n getcap -r / 2>&1 | grep -v '^/snap' | head -40
sudo -n find / -xdev -type f -perm -0002 ! -path '/proc/*' ! -path '/sys/*' | head -30
sudo -n cat /etc/ld.so.preload; ls -la /etc/ld.so.conf.d/; lsattr /etc/passwd /etc/shadow /usr/bin/ssh
# Kernel and MAC
sudo -n sysctl kernel.kptr_restrict kernel.dmesg_restrict fs.suid_dumpable kernel.unprivileged_bpf_disabled kernel.yama.ptrace_scope
sudo -n aa-status 2>&1 | head -20; getenforce 2>&1
# Updates and EOL
apt list --upgradable 2>/dev/null | tail -n +2 | wc -l; apt list --upgradable 2>/dev/null | grep -c -- '-security'
cat /etc/apt/apt.conf.d/20auto-upgrades; grep PRETTY_NAME /etc/os-release; uname -r
systemctl is-active fail2ban crowdsec
```

Analysis:
- For each account with `HASH` + `PasswordAuthentication yes` (effective, taking `Match` into account)
  + SSH `[C-reach]` from an untrusted zone → a "password brute-force" path. If such an account has sudo
  `NOPASSWD` → chain to root. Password age (`lastchg_days` → date) goes into the report.
- sudoers: entries for **nonexistent** users/groups (whoever creates them gets the rights);
  allowed commands that yield a shell (GTFOBins: `service`, `find`, `vim`, `less`, `tar`, `rsync`,
  `systemctl`, `journalctl`, `awk`, `python`…) → effectively root.
- Service accounts (backup, CI) do not need `AllowTcpForwarding`, `AllowAgentForwarding`,
  `X11Forwarding`, PTY, an interactive shell — otherwise it is a pivot through the host into its segments.
- `/etc/passwd` with an empty shell = `/bin/sh`.
- The rest as before: SUID outside the standard set, `cap_sys_admin`/`cap_net_raw` on
  user binaries, world-writable in /etc, EOL distribution, no anti-brute-force.

# BLOCK T. Trust graph and blast radius (always)

The goal is to answer two questions: **who can get in here** and **where can one get to from here**.

```
# INBOUND: keys, their options, dates, who actually logged in
for h in $(getent passwd | awk -F: '{print $6}' | sort -u); do for f in $h/.ssh/authorized_keys $h/.ssh/authorized_keys2; do sudo -n test -f $f && { sudo -n stat -c '%n owner=%U mode=%a mtime=%y ctime=%z' $f; sudo -n awk '{o=($1 ~ /^(ssh-|ecdsa-|sk-)/)?"NO-OPTS":"OPTS="$1; print "   ",o,$NF}' $f; sudo -n ssh-keygen -lf $f; }; done; done
sudo -n zgrep -hE 'Accepted (publickey|password)' /var/log/auth.log* | awk '{print $9,$11,$(NF)}' | sort | uniq -c | sort -rn   # user, source, fingerprint
# IMPORTANT: non-interactive sessions (ssh host cmd, scp, agents/scripts) are NOT written to wtmp — `last` will not show them.
# Source of truth — auth.log `Accepted` + `sudo: … COMMAND=` in the same minutes. A series of short sessions
# with back-to-back sudo commands = a script/agent; correlate with files created at that time (find -newermt).
sudo -n zgrep -h 'sudo:' /var/log/auth.log* | grep COMMAND | grep -v "$SSH_USER :" | sed -E 's/.*sudo: +//' | cut -c1-220
# OUTBOUND: private keys and creds that grant access to other systems
for h in $(getent passwd | awk -F: '{print $6}' | sort -u); do sudo -n find $h -maxdepth 3 -type f \( -name 'id_*' ! -name '*.pub' -o -name '*.pem' -o -name '*.key' -o -name '.pgpass' -o -name '.netrc' -o -name '.my.cnf' -o -name '.git-credentials' -o -name 'config.json' -path '*.docker*' -o -name 'kubeconfig*' -o -name 'credentials' -path '*.aws*' \) -exec stat -c '%n owner=%U mode=%a mtime=%y' {} \; ; done
for h in $(getent passwd | awk -F: '{print $6}' | sort -u); do f=$h/.ssh/known_hosts; sudo -n test -f $f && echo "$f: $(sudo -n wc -l < $f) hosts, hashed=$(sudo -n grep -c '^|1|' $f)"; sudo -n test -f $h/.ssh/config && sudo -n grep -iE '^\s*(host|hostname|user|identityfile|proxyjump)\b' $h/.ssh/config; done
# backup/deploy agents: which user and which key they use to go TO clients
sudo -n grep -rnE 'RsyncSshArgs|-l root|SshPath|ssh_command|StrictHostKeyChecking' /etc/backuppc /etc/barman* <BackupPC config directory on the volume> 2>&1 | head
```

Present the result as tables:
- **Inbound:** account → key (comment, fingerprint) → where it actually logged in from (IP, frequency)
  → whether there is `from=`/`command=`/`restrict` → what the account can do here (shell, sudo, forwarding,
  data access). A key from a prod host without restrictions = "compromise of that host = entry here".
- **Outbound:** secret/key → path, owner, permissions (readable by a non-owner? does it sit on a
  network volume accessible to other clients?) → what it grants access to and with what rights
  (root on N hosts, replication of all DBs, cloud admin console) → `StrictHostKeyChecking=no`?
- **Blast radius** in one line: "root on this host = …".

# BLOCK D. Persistence, integrity and traces of compromise (always)

```
last -F -30; sudo -n lastb -F | head -30; lastlog | grep -v 'Never'
# Autostart: system and user
systemctl list-unit-files --state=enabled --no-pager; systemctl list-timers --all --no-pager
for u in /etc/systemd/system/*.service /etc/systemd/system/*/*.service; do dpkg -S "$u" >/dev/null 2>&1 || echo "NON-PACKAGE: $u $(stat -c '%y' "$u")"; done
sudo -n find /root /home -maxdepth 5 -path '*/.config/systemd/user/*' -type f
sudo -n find /etc/systemd /usr/lib/systemd /etc/init.d /etc/rc.local /etc/profile.d /etc/cron* /etc/sudoers.d /etc/ssh /etc/pam.d /etc/ld.so.conf.d /etc/udev/rules.d -newerct "$(date -d '-90 days' +%F)" -type f   # by ctime
sudo -n atq; sudo -n ls -la /var/spool/cron/atjobs
# cron: contents (through the masker!), spool mtime, schedule SEMANTICS
sudo -n ls -la --time-style=full-iso /var/spool/cron/crontabs/ /etc/cron.d/
for u in $(getent passwd | cut -d: -f1); do c=$(sudo -n crontab -u $u -l 2>/dev/null) && { echo "== $u"; echo "$c" | grep -vE '^\s*(#|$)'; }; done
cat /etc/crontab /etc/cron.d/* | grep -vE '^\s*(#|$)'
# PAM, package integrity, kernel
sudo -n grep -rnE 'pam_exec|pam_python|pam_script|pam_permit\.so' /etc/pam.d/
sudo -n timeout 300 dpkg --verify 2>&1 | grep -vE ' c /' | head -50      # RPM: rpm -Va
cat /proc/sys/kernel/tainted; for m in /sys/module/*/taint; do t=$(cat $m); [ -n "$t" ] && echo "$m=$t"; done
sudo -n journalctl -k --no-pager | grep -iE 'taint|module verification|out-of-tree' | head
# Process anomalies (arguments — only through the masker)
ps -eo user,pid,ppid,lstart,args --forest | head -80
sudo -n ls -l /proc/*/exe 2>&1 | grep deleted | head
sudo -n find /tmp /var/tmp /dev/shm -xdev -type f -mtime -14
pgrep -af 'ngrok|frpc|chisel|gost|socat|ncat|code-tunnel|cloudflared|tailscale' ; sudo -n ls -d /root/.vscode* /home/*/.vscode-server
# Histories (through the masker), known_hosts, network tampering
for h in $(getent passwd | awk -F: '{print $6}' | sort -u); do sudo -n test -f $h/.bash_history && { echo "== $h ($(sudo -n stat -c %y $h/.bash_history))"; sudo -n tail -50 $h/.bash_history; }; done
sudo -n iptables -t nat -S; grep -vE '^\s*(#|$)' /etc/hosts
# VM from a template/clone: first journal entries under a foreign hostname, /etc/hosts 127.0.1.1 <template>,
# authorized_keys/password dates = template date → identical keys/passwords/sudo on all clones
sudo -n journalctl --no-pager -q -o short-iso | awk '{print $2}' | uniq -c | head; stat -c '%n %y' /etc/ssh/ssh_host_*_key.pub
sudo -n awk -F: '$2 ~ /^\$/ {print $1,$2}' /etc/shadow | while read u h; do echo "$u $(printf '%s' "$h" | sha256sum | cut -c1-12)"; done   # hash fingerprints for cross-host comparison
```

**cron analysis (mandatory).** For each schedule line, write out all five fields in words and
compute the expected number of runs per day. Typical mistakes: `* */2 * * *` is **every
minute of every even hour** (720 runs/day), not "once every 2 hours"; `* */48 * * *` is
60 consecutive runs at 00:xx. Cross-check with the journal (count only, arguments — through the masker):
`sudo -n journalctl -u cron --since today | grep -c '<command fragment without the secret>'`.
Secrets in cron/process arguments are a separate finding (visible in `ps` to any user,
end up in the journal and cron mail).

Triggers: non-package or fresh-by-ctime units, sudoers, pam, ssh; cron with
`curl|wget|base64|/dev/tcp`; `ld.so.preload`; deleted binaries; `dpkg --verify` with modified
`/bin`, `/sbin`, `/lib`; tainted kernel with a module not explained by a known driver;
tunnels and remote IDE servers; tampering in `/etc/hosts`; mtime of the crontab spool or
authorized_keys within the window of interest — correlate with logins (who was in session at that time).

# BLOCK E. Docker/containers (if present)

```
sudo -n docker version --format '{{.Server.Version}}'
sudo -n docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}\t{{.CreatedAt}}'
sudo -n docker images --digests --format '{{.Repository}}:{{.Tag}} {{.Digest}} {{.CreatedSince}}'
sudo -n cat /etc/docker/daemon.json; getent group docker; stat -c '%n %U:%G %a' /var/run/docker.sock
ss -ltnp | grep -E ':2375|:2376'                       # docker API exposed = P0
for c in $(sudo -n docker ps -q); do sudo -n docker inspect $c --format '{{.Name}} privileged={{.HostConfig.Privileged}} net={{.HostConfig.NetworkMode}} pid={{.HostConfig.PidMode}} caps={{.HostConfig.CapAdd}} user={{.Config.User}} ports={{.HostConfig.PortBindings}} mounts={{range .Mounts}}{{.Source}}:{{.Destination}}:{{.RW}} {{end}}'; done
# Env — ONLY variable names, do not print values
for c in $(sudo -n docker ps -q); do echo "== $c"; sudo -n docker inspect $c --format '{{range .Config.Env}}{{println .}}{{end}}' | cut -d= -f1; done
# what ACTUALLY listens inside the container (docker-proxy on the host ≠ a live service)
for c in $(sudo -n docker ps -q); do p=$(sudo -n docker inspect -f '{{.State.Pid}}' $c); echo "== $c"; sudo -n nsenter -t $p -n ss -ltnp; done
sudo -n find / -xdev -maxdepth 4 \( -name 'docker-compose*.y*ml' -o -name 'compose.y*ml' \)
```

Where to dig: `privileged=true`, `cap_add: SYS_ADMIN`, a `docker.sock` mount, hostPath `/` or
`/etc` rw — that is host root. Publish on 0.0.0.0 for admin panels (and remember DOCKER-USER).
Images not from your own registry, `latest`, without digest, older than a year. Env with `*PASS*`/`*TOKEN*`/`*SECRET*`
— a plaintext secret for everyone in the docker group. A published port with no live
listener inside is an availability problem; real authorization is then unconfirmed (`[U]`).

# BLOCK F. Kubernetes (if kubelet/node)

```
sudo -n kubelet --version; kubectl version
sudo -n cat /var/lib/kubelet/config.yaml | grep -nA4 -E 'authentication|authorization|readOnlyPort'
ss -ltnp | grep -E '10250|10255|10248|6443|2379|2380'
sudo -n ls /etc/kubernetes/manifests/; sudo -n cat /etc/kubernetes/manifests/*.yaml | head -80
sudo -n find / -xdev -maxdepth 5 \( -name 'kubeconfig*' -o -name 'admin.conf' \)
sudo -n ls -la /etc/kubernetes/pki/
kubectl get nodes -o wide; kubectl get pods -A -o wide --no-headers | wc -l
kubectl get pods -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name} hostNetwork={.spec.hostNetwork} hostPID={.spec.hostPID} privileged={.spec.containers[*].securityContext.privileged}{"\n"}{end}' | grep true | head
kubectl get netpol -A | wc -l; kubectl get svc -A | grep -E 'NodePort|LoadBalancer'
kubectl get clusterrolebinding -o jsonpath='{range .items[*]}{.metadata.name} {.roleRef.name} {.subjects[*].name}{"\n"}{end}' | grep -iE 'anonymous|system:authenticated'
kubectl auth can-i --list | head -20
```

Where to dig:
- kubelet `anonymous.enabled: true` + `authorization.mode: AlwaysAllow` gives anonymous exec
  into pods via :10250 → P0. That is exactly how it happened in the incident.
- `readOnlyPort: 10255` → metadata leak → P0 if reachable.
- kubeconfig of service users is creds; check its lifetime (`openssl x509 -enddate`).
- 0 NetworkPolicy → any RCE in a pod sees the whole cluster.
- NodePort/LB on internal services.
- hostNetwork/hostPID/privileged outside kube-system.
- static pods with unexpected images.

**F.2 Control plane (master nodes: apiserver/etcd/scheduler/controller-manager).** Such a host is
always a "crown-jewel" one: owning it = owning the whole cluster.
```
# k8s dashboards with admin-kubeconfig (a frequent P0): octant/headlamp/k8s-dashboard/rancher/lens/kubed/skooner
ss -ltnp | grep -iE 'octant|headlamp|dashboard|rancher|7777|9090'; systemctl cat octant headlamp 2>/dev/null | grep -iE 'ExecStart|kubeconfig|accepted-hosts|User='
# encryption of secrets in etcd (no flag = secrets in plaintext):
sudo -n grep -l 'encryption-provider-config' /etc/kubernetes/manifests/kube-apiserver.yaml || echo 'NO etcd encryption'
# apiserver audit (none = no cluster forensics):
sudo -n grep -c 'audit-log-path' /etc/kubernetes/manifests/kube-apiserver.yaml
# etcd snapshots/backups: permissions and where they go (644 = all secrets to any local user):
sudo -n find / -xdev \( -name 'etcdBackup*' -o -name 'snapshot*.db' -o -path '*backup*etcd*' \) -printf '%m %u %p\n' 2>/dev/null; sudo -n grep -rl 'etcdctl.*snapshot\|kube-backup' /scripts /etc/cron* /root 2>/dev/null
# NodePort/LoadBalancer of internal systems on 0.0.0.0 (rabbitmq-mgmt/redis/postgres/dashboards):
sudo -n iptables-save -t nat 2>/dev/null | grep -oE 'comment "[^"]+".*--dport [0-9]+' | sort -u
# cluster-admin for personal/service subjects and anonymous:
sudo -n kubectl --kubeconfig /etc/kubernetes/admin.conf get clusterrolebinding -o jsonpath='{range .items[?(@.roleRef.name=="cluster-admin")]}{.metadata.name}{" <- "}{range .subjects[*]}{.kind}/{.name}{" "}{end}{"\n"}{end}'
sudo -n kubectl --kubeconfig /etc/kubernetes/admin.conf get clusterrolebindings -o wide | grep -iE 'anonymous|unauthenticated|system:authenticated'
sudo -n kubectl --kubeconfig /etc/kubernetes/admin.conf get netpol -A --no-headers | wc -l   # 0-2 for the whole cluster = flat network
sudo -n kubeadm certs check-expiration 2>/dev/null | head -20   # EOL version? expired certs/kubeconfig?
kubelet --version   # EOL (<=1.23 ~ unsupported); docker-shim runtime?
```
Where to dig:
- **k8s dashboard without authentication** (octant `--accepted-hosts 0.0.0.0`, headlamp, k8s-dashboard
  with skip-login) on the node IP + no firewall → **cluster-admin without creds from the network** = P0.
- **No `encryption-provider-config`** → Secrets in etcd in plaintext; combined with an
  **etcd snapshot with 644 permissions** = any local user reads all cluster secrets (chain).
- **No `audit-log-path`** → actions in the cluster via stolen SA tokens/through kubelet are not
  logged; incident forensics of the cluster is impossible — must be stated in IR.
- **etcd listening on the node IP** — check `--client-cert-auth=true`/`--peer-client-cert-auth=true`
  (without them 2379 = cluster root); firewall the port itself down to peers.
- NodePorts (30000–32767) of internal systems on 0.0.0.0 — these are exactly the targets of internal SSRF/scanning.
- cluster-admin for personal or `kubernetes-dashboard` SAs, bindings to `system:authenticated`/
  `anonymous`, 0–2 NetworkPolicies per cluster (flat network → any RCE in a pod sees everything).
- admin.conf/`/root/.kube/config` is a cluster-admin cred; permissions, expiry, copies in backups.
- **Drift between master nodes** (k8s/OS/runtime/firewall-backend versions, presence of a dashboard) —
  not all nodes get patched and hardened; compare node by node.

# BLOCK G. Web layer: nginx/openresty/apache/caddy (on the host and in containers)

```
sudo -n nginx -T | head -400          # openresty: /usr/local/openresty/nginx/sbin/nginx -T; in a container: docker exec <c> nginx -T
sudo -n apachectl -S; ls /etc/nginx/sites-enabled/ /etc/nginx/conf.d/
```
Checklist:
1. `default_server` returns 444 or a stub for an unknown Host.
2. Host validation: the Host header is user input; if it reaches SQL or lua, that is SQLi.
3. `auth_basic`/`auth_request` on service locations. **Basic Auth without TLS** = creds over the
   network in cleartext. Where does the `htpasswd`/password live: in the container env? world-readable?
4. `proxy_pass` with variables → SSRF; `proxy_set_header Host $http_host`.
5. limit_req/limit_conn.
6. TLS: `ssl_protocols` no lower than TLSv1.2, ciphers, HSTS, domains in certificates.
7. `autoindex`, dotfiles, `/.git`, `/.env`, dev servers in prod (Vite `@fs` = LFI).
8. Security headers (P2).
9. `stub_status` exposed externally.
10. `client_max_body_size`.
11. Upstream map.
12. Access log: enabled? does it record `$host`, source, `$remote_user`? Where is it written (will it
    survive container re-creation)? No access log for an admin panel → access to it can be neither
    proven nor disproven — that is a separate finding.
If `ALLOW_LOCAL_PROBES=1`: HEAD to `127.0.0.1:<port>` → code 401/200/502.

# BLOCK H. Data/caches/queues

For each service: version (EOL?), bind address and reachability, authentication, TLS, known CVEs.
- **PostgreSQL**: `listen_addresses`, `pg_hba.conf` (trust, `0.0.0.0/0`, `hostssl` vs `host`),
  `ssl`, certificate (snakeoil?), passwords in the pgbouncer userlist.
  **Client side** (barman, applications): missing `sslmode` ≠ "no TLS". In libpq the default
  is `prefer`: TLS is attempted, but fallback to a cleartext connection is possible, and
  server authenticity is not verified. Finding wording: "encryption and server authenticity
  are not guaranteed by the configuration". Actual TLS is checked on the server
  (`pg_stat_ssl`), and that goes to "Adjacent checks".
- **MySQL/MariaDB**: `SELECT user,host,plugin FROM mysql.user;` (locally), `bind-address`.
- **Redis**: `CONFIG GET bind protected-mode requirepass`, `ACL LIST`, `CONFIG GET dir dbfilename`,
  `SCAN` (not KEYS).
- **RabbitMQ**: version, `list_users`, guest, mgmt 15672, erlang-cookie permissions.
- **MongoDB**: `bindIp`, `authorization`.
- **ClickHouse**: `system.users`, `listen_host`, plaintext passwords, `url()/file()/remote()`.
- **Elasticsearch/OpenSearch**: security plugin, default creds, `path.repo`, scripts.
- **etcd**: 2379 without client-cert → P0.
- **memcached**: 11211 exposed externally, UDP.

# BLOCK I. Storage and backups (NFS/SMB/Gluster/Ceph/MinIO + barman/BackupPC/borg/restic/…)

A backup host is always a "crown-jewel" host: it holds copies of all data and, as a rule, creds and
keys to all sources.

**I.1 Storage access**
```
cat /etc/exports; sudo -n exportfs -v
grep -vE '^;|^#|^$' /etc/samba/smb.conf
sudo -n gluster peer status; sudo -n gluster volume list
for v in $(sudo -n gluster volume list); do echo "== $v"; sudo -n gluster volume info $v; sudo -n gluster volume get $v all | grep -E '^(auth\.(allow|reject|ssl-allow)|server\.(ssl|root-squash|allow-insecure|anonuid)|client\.ssl|nfs\.disable|features\.read-only|transport\.address-family)'; sudo -n gluster volume status $v clients; done
ls -la /var/lib/glusterd/secure-access /etc/ssl/glusterfs.* 2>&1       # management TLS
# actual clients over the whole log period (timeout — logs can be huge)
sudo -n timeout 300 nice -n19 zgrep -hoE 'received addr = "[^"]+"' /var/log/glusterfs/bricks/*.log* | sort | uniq -c | sort -rn
```
Analysis:
- Gluster: `auth.allow=*` (the default), `server.ssl/client.ssl=off`, `root-squash=off`,
  `allow-insecure=on` mean that any client reaching `glusterd` and the brick ports
  mounts the volume as root. **Volume access and cluster management are different things**:
  management (`peer probe`, `volume set`) is done from pool nodes, `secure-access` is separate.
- Who is actually a client right now (per `volume status clients` and brick logs) — exactly these IPs
  must go into `auth.allow`.
- Port reachability (24007, bricks, 2049, 445) — per the Phase 1 rules, not per the bind address.
- NFS: `rw,no_root_squash`, `*`; SMB: `guest ok`; MinIO: default keys.
- **Which secrets live on the volume** (home directories of service users, `.ssh`, `.pgpass`,
  BackupPC configs, etc.) and their permissions. A secret on a widely accessible volume = a secret held by all its clients.
- Peer nodes have the same exposure: add them to "Adjacent checks".

**I.2 Backup health, retention and immutability**
```
# barman (no network subcommands: list-backup only reads the directory)
sudo -n grep -hE '^\s*(retention_policy|minimum_redundancy|wal_retention_policy|conninfo|streaming_conninfo|ssh_command|backup_method)' /etc/barman.conf /etc/barman.d/*.conf
for s in $(sudo -n -u barman barman list-server --minimal); do echo "== $s"; sudo -n -u barman barman list-backup $s; done
# BackupPC: last backup per client, daemon state
for d in $(sudo -n ls <TopDir>/pc/); do f=<TopDir>/pc/$d/backups; sudo -n test -f $f && echo "$d last_end=$(sudo -n tail -1 $f | awk -F'\t' '{print strftime("%F",$4)}') count=$(sudo -n cat $f | wc -l)" || echo "$d NO backups"; done   # the glob will not expand without sudo
sudo -n tail -5 <LogDir>/LOG
sudo -n grep -nE '^\$Conf\{(XferMethod|RsyncSshArgs|TarClientCmd|FullKeepCnt|IncrKeepCnt|FullPeriod)\}' <ConfDir>/config.pl
# borg/restic/rsync/rclone: timers, cron, recent logs; offsite copy?
systemctl list-timers --all --no-pager | grep -iE 'backup|borg|restic|rclone|rsync'
```
Analysis and triggers:
- **Freshness**: the last successful backup of each client. Daemon is down or clients have not been
  backed up for N days → P1 (availability), and data from there cannot be considered current for investigations.
- **Retention vs IR**: how many days are actually retained (retention, `OBSOLETE`) and whether there are copies
  **older than `IR_WINDOW_START`**. If the retention window is shorter than the time since compromise began,
  there are no "clean" copies. If they exist but are marked for deletion (`OBSOLETE`, rotation) →
  **immediate escalation to the owner** (`barman keep`/copying is a change, do not do it yourself).
- **Immutability and independence**: is there a copy that cannot be deleted from this host
  or from the sources (offsite, WORM, object lock, separate creds)? Who can delete backups
  (all sudoers? all volume clients?) — this is the "ransomware/wipe" path.
- **Agent privileges on clients**: do BackupPC/rsync/borg connect with `-l root`?
  `StrictHostKeyChecking=no`? Where does the agent key live and who can access it? → into Block T as outgoing
  trust, blast radius = number of clients.
- **Restore test**: is there evidence (log, runbook, date)? No → P2.
- Backup encryption at-rest and in transit.
- Access logs of backup web interfaces (file downloads via the UI).

# BLOCK O. Telemetry hosts: traces, logs, metrics (Jaeger/OTel/Tempo/Zipkin, ELK/Loki/Graylog, Prometheus/Grafana, Sentry)

Telemetry is a **secrets sink**: SDKs, by default or by configuration, write HTTP headers, cookies,
SQL and request bodies into spans and logs. The host itself is almost stateless, but whoever reads
the telemetry reads sessions and tokens of prod services. Treat such a host as "crown-jewel" if data
of payment/PII services flows through it.
```
# pipeline configs (through the masker!): receivers, processors (is there redaction/attributes delete), exporters, storage
sudo -n cat <compose> <otel/jaeger/promtail/filebeat/vector configs>
# storage creds in configs: role (superuser?), TLS verify (insecure_skip_verify?)
# WHAT is in the data — from local dumps/cache/collector logs, only key NAMES and counters:
#   http.request.header.(authorization|cookie|set_cookie|x_*token*), db.statement (literals?), url with query tokens, email/phone/card
sudo -n find /tmp /var/tmp /home /root -maxdepth 3 -type f -newermt "$(date -d '-60 days' +%F)" \( -name '*.json' -o -name '*.ndjson' \) -size +10k
# ingest: auth on OTLP/remote_write/beats (bearertokenauth/mTLS)? who actually sends (conntrack, receiver logs)?
# UI/API: does it have its own auth? (Jaeger UI has none) — behind which proxy, who uses it (proxy access logs)
# data loss: export errors, queue full, dropped (important for IR — is the data complete for the window)
sudo -n docker logs --since 168h <collector> 2>&1 | grep -oE '"error": "[^"]{0,120}|Dropping data' | sed -E 's/[0-9]+/N/g' | sort | uniq -c | sort -rn | head
# debug/logging exporter with verbosity: detailed writes full data to the docker log (and is it unrotated?)
```
Triggers: auth/cookie/CSRF headers in spans or logs → P1 (P0 if reading by outsiders is
proven), do redaction both in the SDK and in the collector; storage superuser in a
world-readable config; ingest without auth, open wider than the sources (data forgery and
pollution); UI without auth, reachable wider than admins; data drops during the incident window → note in IR.
Adjacent checks: storage (audit logs of index reads), UI proxy, service SDK settings.

# BLOCK V. Versions, support and known vulnerabilities per component (always)

The block's task is **vulnerability and patch management**: for each significant piece of software
on the host, capture the exact version, check its support status (EOL) and whether the vendor has
published security bulletins for that version, note version-specific configuration mistakes, and for
each item give an action (upgrade / configure / isolate). This is not about writing
exploits — only inventory, cross-checking against public sources, and remediation.

**V.1 Capture exact versions (inventory).** For everything found by Phase 0 and blocks E/F/G/H/I/O:
```
# OS/kernel and support lifetime
grep -E 'PRETTY_NAME|VERSION_ID' /etc/os-release; uname -r; hostnamectl | grep -i kernel
ubuntu-distro-info --supported 2>/dev/null; cat /etc/debian_version 2>/dev/null
# packages/binaries — EXACT version and build date
dpkg -l 2>/dev/null | awk '$1=="ii"{print $2,$3}' | grep -iE 'nginx|openssh|openssl|libssl|bind9|exim|postfix|sudo|polkit|glibc' 
rpm -qa 2>/dev/null | grep -iE 'nginx|openssh|openssl|bind|exim|sudo|polkit|glibc'
# services — self-reported
nginx -v 2>&1; openssl version; sshd -V 2>&1 | head -1; redis-server --version 2>/dev/null
psql --version 2>/dev/null; mysql --version 2>/dev/null; mongod --version 2>/dev/null | head -1
# containers/orchestration
sudo -n docker version --format '{{.Server.Version}}' 2>/dev/null; containerd --version 2>/dev/null
kubelet --version 2>/dev/null; kubeadm version -o short 2>/dev/null
sudo -n grep -h 'image:' /etc/kubernetes/manifests/*.yaml 2>/dev/null   # apiserver/etcd/scheduler versions
# container images — tag + digest (drift, stale images, third-party registries)
sudo -n docker images --digests --format '{{.Repository}}:{{.Tag}} {{.Digest}} {{.CreatedSince}}' 2>/dev/null
# applications in images/DBs often report their version via an API string/startup log (no outbound network requests):
#   Elasticsearch/OpenSearch — the number field in GET / (locally), or a line in the startup log; ES7 vs OpenSearch — different CVE branches
#   RabbitMQ — rabbitmqctl status | grep rabbit; Redis — INFO server; ClickHouse — SELECT version()
```
Consolidate into a table: **component → exact version → release date → EOL status → version source (file/log)**.

**V.2 Cross-check against known vulnerabilities and EOL (by version).** For each component:
- **EOL/support**: does the version still receive security patches (distribution, upstream, LTS/ESM).
  An EOL component = accumulated unfixable vulnerabilities → P1 on its own.
- **Vendor bulletins**: are there published advisories for this major.minor.patch
  (GHSA/vendor security releases/distribution DSA/USN). Take facts from public
  sources (NVD/vendor/distribution), not from memory; record the version and source.
  For online cross-checking — `WebSearch`/`WebFetch` for "<product> <version> security advisory" and
  the vendor's support page; offline — at least EOL and whether security updates are pending
  (`apt list --upgradable | grep -i security`, `unattended-upgrades` status).
- **Priority by reachability**: a vulnerability in a component that, per Phase 1, is actually reachable from
  an untrusted zone ranks higher than in a local one. Always tie the version to the `[C-reach]` tag.

**V.3 Version-specific configuration mistakes (not just "upgrade").** Check not only the
version number, but also settings that are dangerous specifically for this software:
- **Elasticsearch/OpenSearch**: branch (ES 7.x OSS vs OpenSearch), whether the security plugin is enabled,
  default/missing creds, `script.allowed_types`, `path.repo`/`repositories.url.allowed_urls`
  (snapshot repositories as a vector), reindex-from-remote and HTTP-input (SSRF), exposed 9200/9300.
- **Kubernetes**: EOL minor; docker-shim runtime (removed in 1.24); `--anonymous-auth`,
  `--authorization-mode`, `--encryption-provider-config` (encryption of secrets in etcd),
  `--audit-log-path`, kubelet `readOnlyPort`/`authorization.mode`, PodSecurity/PSP, number of
  NetworkPolicies, admission webhooks, cluster-admin on service accounts. (Details — Block F/F.2.)
- **Redis**: `protected-mode`, `requirepass`/ACL, `rename-command`, `dir`/`dbfilename` (write),
  modules; versions with known Lua/replication issues.
- **RabbitMQ**: EOL branch, mgmt plugin, guest account, Erlang version, cookie.
- **PostgreSQL/MySQL/Mongo**: EOL major, `trust`/`0.0.0.0` in hba, default roles, TLS.
- **nginx/openresty**: branch and known parsing/alias/merge_slashes issues, modules.
- **OpenSSH/OpenSSL/sudo/polkit/glibc**: these are components where the version matters most — record
  the exact distribution version and whether the latest security updates have been applied.
Each mistake is a finding with an attack path (as in the general criteria), severity by reachability.

**V.4 Block output.** Table "component → version → EOL? → are there pending/uninstalled
security updates → reachability → action (upgrade to X / change setting Y /
isolate)". If online cross-checking is unavailable — honestly mark "EOL status established, the exact
advisory list requires cross-checking with NVD/vendor" and move it to "Not checked".

# BLOCK J. Plaintext secrets

`-xdev` does not descend into data volumes, so search the home directories from `getent` and the
known config directories rather than running a blanket `find` over the volume.
```
sudo -n find /etc /opt /srv /root /usr/local $(getent passwd | awk -F: '$3>=1000||$3==0{print $6}' | sort -u) -maxdepth 5 -type f \( -name '*.env' -o -name '.env*' -o -name '*local.ini' -o -name 'deployment.ini' -o -name 'userlist.txt' -o -name '*.pem' -o -name '*.key' -o -name 'id_*' ! -name '*.pub' -o -name '*secret*' -o -name 'kubeconfig*' -o -name '.pgpass' -o -name '.netrc' -o -name '.my.cnf' -o -name '.git-credentials' -o -name 'htpasswd*' -o -name '*.kdbx' -o -name 'rclone.conf' \) -exec stat -c '%n owner=%U mode=%a' {} \;
sudo -n find /etc /opt /srv /home -xdev -maxdepth 5 -name '.git' -type d
# presence of secrets (file names and line numbers ONLY, no values)
sudo -n grep -rIlE '(password|passwd|secret|token|api[_-]?key)\s*[=:]' /etc/systemd/system /etc/default /root /usr/local/bin /opt 2>&1 | head -40
sudo -n grep -rncE -- '--(api-?token|password|token|secret)' /var/spool/cron/crontabs /etc/cron.d /etc/crontab
ps -eo args | grep -ciE 'token|passw|secret|api[_-]?key'          # count only
sudo -n find / -xdev -maxdepth 6 -name 'sitecustomize.py' -o -name 'usercustomize.py'
ls -la /root/.aws /root/.config/gcloud /home/*/.aws
```
Every plaintext secret is a finding with path, owner and mode, and must be linked to
Block T (what it grants access to). If the secret is readable by more than its owner (0644/0755, sits on
a shared volume, in a container env, in process arguments), severity is higher.

# BLOCK K. Logs, coverage, monitoring, time

```
# COVERAGE: first/last record of each source
for f in /var/log/auth.log* /var/log/secure* /var/log/syslog* /var/log/messages*; do [ -e "$f" ] && echo "$f: $(sudo -n zcat -f $f | head -1 | cut -c1-15) .. $(sudo -n zcat -f $f | tail -1 | cut -c1-15)"; done
sudo -n journalctl --list-boots --no-pager | tail -5; sudo -n journalctl --disk-usage
sudo -n journalctl --no-pager -q -o short-iso | head -1
grep -vE '^\s*(#|$)' /etc/logrotate.conf; grep -rhE '^\s*(rotate|daily|weekly)' /etc/logrotate.d/rsyslog
grep -rE '@@?|omfwd|RemoteSender' /etc/rsyslog.conf /etc/rsyslog.d/; systemctl is-active rsyslog vector fluentd fluent-bit filebeat promtail
sudo -n auditctl -s 2>&1; sudo -n auditctl -l 2>&1 | head
ss -ltnp | grep -E ':9100|:9256'; timedatectl show -p NTPSynchronized
```
Analysis:
- For every "no traces" conclusion, state **what period the logs cover** in that source.
  Logs do not cover the window of interest → no conclusion is possible (not "clean").
- Gaps in journal/auth.log, a log that starts abruptly, empty or truncated histories
  (`HISTFILE=/dev/null`, `history -c`) are signs of cleanup.
- Logs are local only, rotation is short, no auditd → on-host forensics is limited.
- Logs are shipped to a system that the host itself can compromise.

# PHASE Y. Self-check before the report (mandatory)

1. Re-read the raw files and match **every** `[C-*]` in the draft to a file and line. If it does
   not match, fix it or downgrade it to `[U]`. Take numbers (count of hosts, backups, packages) from
   the output, not from memory.
2. For every P0/P1 finding, check that the attack path is fully described and every link has a tag.
3. Run `gitleaks`/`trufflehog` over `$AUDIT_DIR` (rule 4).
4. Fill in the coverage table: Block → done / partial / skipped → reason (no permissions,
   dangerous, timeout, no tool) → what is needed to complete it.
5. Check the wording of conclusions in IR mode (see Appendix B): no "no traces" without
   naming the sources, the period and what is not ruled out.

# PHASE Z. Report

File `AUDIT_${HOST}_$(date -u +%Y%m%d).md` (+ `findings.json`: id, severity, title, path, evidence[], confidence, recommendation),
written in `REPORT_LANG`; section names below may be translated, their order and content may not:

1. **Summary**: host role, whether it is a crown-jewel host, blast radius in one line, top 3 attack paths.
2. **Attack surface and reachability map**: port → process → bind address → authentication →
   reachable from where (tag) → whether it should be.
3. **Trust graph**: the "Inbound" and "Outbound" tables from Block T.
4. **Findings**: `ID | Severity | Attack path (who → boundary → what they get) | Evidence (file:line) | Tags | Recommendation`.
   Chains go on separate rows referencing the IDs of their links.
5. **Backups** (if Block I): freshness per client, retention vs `IR_WINDOW_START`, immutability, restore test.
6. **IR sweep** (if IR_MODE=1) — per the Appendix B template.
7. **Versions and vulnerabilities** (Block V): table of component → version → EOL → pending
   security updates → reachability → action.
8. **Coverage**: the table from Phase Y, log coverage per source, `AUDIT_START/END`.
9. **Not checked** — with reasons and what is needed to check it.
10. **Adjacent checks** — which hosts/systems to check next and what exactly (cluster peers,
   DB servers for `pg_stat_ssl`, the perimeter for NAT/SSH, backup clients, sources of inbound keys).
11. **Recommendations** by priority. Changes only upon agreement; for
    firewall recommendations on docker hosts, explicitly specify `DOCKER-USER`/binding publish to an address.
12. Comparison with previous audits of the host, if any.

---

# Appendix A. Runner with masking and a command log

Runs locally. Masking is done with `perl` (it exists on both macOS and Linux; BSD `sed`
has no `I` flag). The filter is applied **before** writing to disk.

```bash
umask 077; mkdir -p "$AUDIT_DIR"
SSH_OPTS="-o BatchMode=yes -o LogLevel=ERROR"
MASK='s/(-u\s+[^:\s]+:)(\S{3,})/$1."<MASKED:".length($2).">"/ge; s/((?<!NO)(?:pass(?:word)?|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)[\w.-]*["\x27]?\s*[=:]\s*["\x27]?)([^\s"\x27,;<]{3,})/$1."<MASKED:".length($2).">"/gie; s/(--?(?:api-?token|token|password|passwd|pass|secret|key)[= ])([^\s<]{3,})/$1."<MASKED:".length($2).">"/gie; s{(://[^:\/@\s]+:)([^@\s]+)@}{$1."<MASKED:".length($2).">@"}ge; s/^([\w.*-]+:[\d*]+:[^:\s]+:[^:\s]+:)(.+)$/$1<MASKED>/; s/(-----BEGIN [A-Z ]*PRIVATE KEY-----).*/$1<MASKED>/'
AUDIT_START=$(date -u +%FT%TZ); echo "AUDIT_START=$AUDIT_START" > "$AUDIT_DIR/_meta.txt"

run() {   # run <name> <<'EOF' ... commands for the host ... EOF
  local n=$1 t0=$(date -u +%FT%TZ)
  ssh $SSH_OPTS "$SSH_USER@$HOST" 'export LC_ALL=C PATH=$PATH:/usr/sbin:/sbin; bash -s' \
      2> >(perl -pe "$MASK" > "$AUDIT_DIR/$n.err") | perl -pe "$MASK" > "$AUDIT_DIR/$n.txt"
  local rc=${PIPESTATUS[0]}
  printf '%s\t%s\t%s\trc=%s\tlines=%s\terr_lines=%s\n' "$t0" "$(date -u +%FT%TZ)" "$n" "$rc" \
    "$(wc -l < "$AUDIT_DIR/$n.txt")" "$(wc -l < "$AUDIT_DIR/$n.err" 2>/dev/null || echo 0)" >> "$AUDIT_DIR/_commands.tsv"
}

# example
run phase1_listeners <<'EOF'
ss -ltnup; sudo -n ss -ltnp; sudo -n iptables-save; sudo -n ip6tables-save
EOF

# at the end
echo "AUDIT_END=$(date -u +%FT%TZ)" >> "$AUDIT_DIR/_meta.txt"
gitleaks detect --no-git -s "$AUDIT_DIR" -r "$AUDIT_DIR/_gitleaks.json" || echo "!!! secrets in evidence — re-mask"
```

The filter catches `key=value`/`key: value`, flags `--token X`, `curl -u user:pass`, passwords in URLs,
`.pgpass` lines and private key headers; it leaves `NOPASSWD:` and `PWD=` from sudo logs alone.
Residual false positives: `passwd: files` in nsswitch, `ntpd -u uid:gid`.
Before printing "raw" lines from histories or commands (`grep -n` over `.bash_history`), still
mask them selectively: the filter does not know every format. If a secret value must be compared
("is this the same password the attacker has"), compare **hashes** (`sha256sum | cut -c1-12`), not values.
A `sudo` quirk: `sudo -n wc -l < file` will not work, because the redirect runs without
privileges. Write `sudo -n sh -c 'wc -l < file'`. It does **not** catch high-entropy strings without a keyword; those
are found by gitleaks. So sources with arbitrary secrets (env, histories, crontab) must still
be printed selectively (variable names and counts only).

# Appendix B. IR mode: incident IOCs (when IR_MODE=1)

Incident-specific IOCs are not stored in the skill: they live in a local file `IR_IOC_FILE`
(default `~/.verus-skills/host-audit/ioc.md`, outside the repository). Read it before Phase 0.
No file and `IR_MODE=1` → ask the user where the IOCs are; without them, do not run the IR sweep and record
this in the report as a coverage limitation. File format (markdown, sections optional):

- **attacker IPs** and **legitimate staff** (addresses and subnets NOT to touch);
- **internal points of compromise** (foothold, its NAT, hosts with RCE) — a host from this list
  is audited with `IR_MODE=1`;
- **markers in logs/files** (identifier regexes, file names, exfiltration domains);
- **cash-out addresses** (wallets, etc.);
- **window** (`IR_WINDOW_START` … end) and what to sweep: `journalctl --since`, auth*, nginx*,
  dpkg.log, `find -newerct`, incident-specific files.

Additionally in IR mode:
1. **Window coverage**: first make sure every source covers the window (Block K). A source
   without coverage is "not checked", not "clean".
2. **Logins**: all `Accepted` in the window, grouped by user, IP and fingerprint. Deviations from
   the usual (a new IP even inside a legitimate subnet, unusual time, interactive login by a
   service account) → question for the owner. Correlate with changes (ctime of the crontab spool,
   authorized_keys, sudoers) in the same sessions.
3. **Access to host data bypassing SSH**: Gluster/NFS/SMB clients (brick logs, `volume status
   clients`), web panel access logs, DB connections, backup agent logs.
   Search for the IPs of the points of compromise here too.
4. **Host's outbound keys and creds** (Block T): if the source of an inbound key is a host within
   the attacker's perimeter, treat the corresponding account as potentially used and
   check its activity separately.
5. **Backups as evidence**: are there copies older than `IR_WINDOW_START`? Will rotation delete them in
   the coming days? → escalate immediately (Block I.2).
6. **Conclusion template.** Do not write "no attacker traces"; write this instead:
   "In sources <list> for the period <from–to>, the specified IOCs <list of categories> were not found.
   Not checked / not ruled out: <data volumes, sources without coverage, adjacent hosts,
   permission and sampling limitations>."
