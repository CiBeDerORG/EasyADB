"""Linux-only, best-effort FNOS process telemetry for owned ADB/FFmpeg children.

Reads /proc of processes created by THIS live session. It never polls Android,
does not inspect other containers' processes and does not start a background job.
The resulting CPU percent uses 100%=one CPU core, not NAS-wide utilization.
"""
import os
import time
from pathlib import Path


def process_counters(pid, proc_root="/proc"):
    if type(pid) is not int or pid < 1:
        return None
    try:
        blob = (Path(proc_root) / str(pid) / "stat").read_text()
        fields = blob.rsplit(")", 1)[1].split()
        ticks = int(fields[11]) + int(fields[12])  # utime/stime
        rss_pages = int(fields[21])  # RSS after the initial pid and comm
        if ticks < 0 or rss_pages < 0:
            return None
        return ticks / os.sysconf("SC_CLK_TCK"), rss_pages * os.sysconf("SC_PAGE_SIZE")
    except (OSError, ValueError, IndexError, AttributeError):
        return None


class ProcessMeter:
    def __init__(self):
        self.last_at = None
        self.last_cpu = None

    def sample(self, pids, now=None, reader=process_counters):
        now = time.monotonic() if now is None else now
        values = [reader(pid) for pid in set(pids) if type(pid) is int and pid > 0]
        valid = [v for v in values if v is not None]
        if not valid:
            self.last_at = None
            self.last_cpu = None
            return {"proc_cpu_pct": None, "proc_rss_mib": None}
        cpu = sum(v[0] for v in valid)
        rss = sum(v[1] for v in valid)
        pct = None
        if self.last_at is not None and now > self.last_at and self.last_cpu is not None:
            pct = max(0, 100 * (cpu - self.last_cpu) / (now - self.last_at))
        self.last_at = now
        self.last_cpu = cpu
        return {"proc_cpu_pct": round(pct, 1) if pct is not None else None,
                "proc_rss_mib": round(rss / 1048576, 2)}
