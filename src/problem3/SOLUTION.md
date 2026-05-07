# Problem 3 — Diagnose VM Disk Usage

## Scenario

Ubuntu 24.04 VM with a 64GB disk is running only one service: NGINX as a load balancer. Monitoring reports that the root disk is consistently at 99% usage.

The goal is to confirm the issue, find what is using the disk, recover safely, and prevent it from happening again.

## 1. Initial checks

I would first confirm whether the root filesystem is actually full, and whether this is a normal disk-space issue or an inode issue.

```bash
df -h /
df -i /
```

Then I would look for the largest directories.

```bash
sudo du -h --max-depth=1 / 2>/dev/null | sort -rh | head -20
sudo du -h --max-depth=1 /var 2>/dev/null | sort -rh | head -20
```

Since this VM only runs NGINX, I would focus on the common NGINX-related paths first.

```bash
sudo du -sh /var/log/* /var/cache/nginx 2>/dev/null
sudo lsof +L1 2>/dev/null | head -20
```

If `df` shows high usage but `du` does not show a large directory, I would check `lsof +L1` for deleted files still held open by NGINX or another process.

## 2. Possible causes and recovery

### Case 1: NGINX logs are too large

The first place I would check is `/var/log/nginx`. On a load balancer, `access.log` can grow quickly during traffic spikes, bot traffic, scraping, or missing log rotation.

Check:

```bash
ls -lh /var/log/nginx/
ls -la /etc/logrotate.d/nginx
```

Impact: the root disk fills up, NGINX may fail to write logs or temporary files, and requests may start failing.

Fix: do not remove active logs with `rm`. Truncate them and reopen NGINX logs.

```bash
sudo truncate -s 0 /var/log/nginx/access.log
sudo truncate -s 0 /var/log/nginx/error.log
sudo nginx -s reopen
```

Prevention: configure logrotate with compression, retention, and size-based rotation. Production logs should also be shipped to a centralized logging system such as CloudWatch Logs, Loki, or S3.

### Case 2: Deleted log file is still held open

This can happen when someone manually deletes a large NGINX log file. The file disappears from the directory, but the disk space is not released until the process closes the file descriptor.

Check:

```bash
sudo lsof +L1
```

Impact: incident response becomes confusing because the disk is still full, but the large file is no longer visible with `ls` or `du`.

Fix: if NGINX is holding the deleted file, reopen logs. Restart NGINX only if reopening does not release the space.

```bash
sudo nginx -s reopen
# if needed:
sudo systemctl restart nginx
```

Prevention: do not use `rm` on active log files. Use logrotate or `truncate`, and make sure NGINX receives a reopen signal after log rotation.

### Case 3: NGINX proxy cache is too large

If NGINX cache is enabled and there is no size limit, `/var/cache/nginx` can grow until it fills the disk.

Check:

```bash
grep -r "proxy_cache_path\|fastcgi_cache_path" /etc/nginx/
sudo du -sh /var/cache/nginx 2>/dev/null
```

Impact: cache files consume disk needed by NGINX and the OS. Request handling can become unstable once the filesystem is nearly full.

Fix: stop NGINX, remove cache files, and start it again.

```bash
sudo systemctl stop nginx
sudo find /var/cache/nginx/ -type f -delete
sudo systemctl start nginx
```

Prevention: set an explicit cache limit, for example:

```nginx
proxy_cache_path /var/cache/nginx levels=1:2 keys_zone=mycache:10m max_size=10g inactive=60m;
```

### Case 4: systemd journal logs are too large

System logs can also fill `/var`, especially if a service is repeatedly failing or producing noisy logs.

Check:

```bash
journalctl --disk-usage
```

Impact: journald consumes space needed by NGINX and the OS. This can make the VM unstable and harder to troubleshoot.

Fix:

```bash
sudo journalctl --vacuum-size=500M
sudo systemctl restart systemd-journald
```

Prevention: set limits in `/etc/systemd/journald.conf`.

```ini
SystemMaxUse=500M
SystemKeepFree=1G
```

### Case 5: Old snap revisions or APT cache

This is less likely on a clean NGINX load balancer, but Ubuntu hosts can accumulate old snap revisions and package cache over time.

Check:

```bash
snap list --all
sudo du -sh /var/lib/snapd/snaps /var/cache/apt/archives 2>/dev/null
```

Impact: wasted disk space from old packages or disabled snap revisions.

Fix:

```bash
snap list --all | awk '/disabled/{print $1, $3}' | \
  while read name rev; do sudo snap remove "$name" --revision="$rev"; done

sudo apt-get clean
```

Prevention: keep the host minimal and reduce snap retention if snap is required.

```bash
sudo snap set system refresh.retain=2
```

### Case 6: Core dumps or crash dumps

Core dumps are less common, but they can be large. If NGINX or an NGINX module is crashing repeatedly, the disk can fill quickly.

Check:

```bash
ls -lh /var/crash/ /var/lib/systemd/coredump/ 2>/dev/null
coredumpctl list
```

Impact: this is more serious than normal disk growth because it may indicate a crash loop, bad module, or system-level issue.

Fix: preserve at least one useful dump for investigation before cleanup. Then remove old dumps after the root cause is understood.

Prevention: limit coredump storage and alert on repeated crashes.

## 3. Long-term prevention

After freeing space, I would add controls so the same issue is caught earlier.

Set disk alerts before the VM reaches 99%:

- 70%: warning
- 85%: on-call action
- 95%: emergency response

Add a rate-of-change alert as well. For example, more than 10GB growth in one hour usually means log spam, cache growth, or abnormal traffic.

I would also ship logs off the VM to CloudWatch Logs, Loki, S3, or another centralized logging system. The VM should only keep short-term local logs.

If this is a critical load balancer, I would consider mounting `/var/log` or `/var` on a separate volume. That way, log growth is less likely to fill the root filesystem and make the whole VM hard to recover.

## 4. Most likely causes

For an NGINX-only load balancer, I would check these first:

1. NGINX access or error logs are growing without proper rotation.
2. NGINX proxy cache is enabled without a size limit.
3. A deleted NGINX log file is still held open by a worker process.

These match the workload running on the VM and are the most common causes of disk usage issues on this kind of server.
