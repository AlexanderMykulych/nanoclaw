import os from 'os';
import fs from 'fs';
import { insertMetric, cleanupMetrics, cleanupTokenUsage } from './db.js';
import { logger } from './logger.js';
import type { GroupQueue } from './group-queue.js';

const COLLECT_INTERVAL = 5 * 60 * 1000; // 5 minutes
const RETENTION_DAYS = 3;

let prevCpuInfo: { idle: number; total: number } | null = null;

function getCpuPercent(): number {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total +=
      cpu.times.user +
      cpu.times.nice +
      cpu.times.sys +
      cpu.times.idle +
      cpu.times.irq;
  }

  if (!prevCpuInfo) {
    prevCpuInfo = { idle, total };
    return 0;
  }

  const idleDiff = idle - prevCpuInfo.idle;
  const totalDiff = total - prevCpuInfo.total;
  prevCpuInfo = { idle, total };

  if (totalDiff === 0) return 0;
  return Math.round((1 - idleDiff / totalDiff) * 100 * 10) / 10;
}

function getDiskUsage(): { totalGb: number; usedGb: number; percent: number } {
  try {
    const stats = fs.statfsSync('/');
    const totalBytes = stats.bsize * stats.blocks;
    const freeBytes = stats.bsize * stats.bavail;
    const usedBytes = totalBytes - freeBytes;
    const totalGb = Math.round((totalBytes / 1073741824) * 10) / 10;
    const usedGb = Math.round((usedBytes / 1073741824) * 10) / 10;
    const percent = Math.round((usedBytes / totalBytes) * 100 * 10) / 10;
    return { totalGb, usedGb, percent };
  } catch {
    return { totalGb: 0, usedGb: 0, percent: 0 };
  }
}

function collectMetric(queue: GroupQueue): void {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const loadAvg = os.loadavg();
  const disk = getDiskUsage();
  const queueStatus = queue.getStatus();

  insertMetric({
    cpu_percent: getCpuPercent(),
    mem_total_mb: Math.round(totalMem / 1048576),
    mem_used_mb: Math.round(usedMem / 1048576),
    mem_percent: Math.round((usedMem / totalMem) * 100 * 10) / 10,
    disk_total_gb: disk.totalGb,
    disk_used_gb: disk.usedGb,
    disk_percent: disk.percent,
    load_avg_1: Math.round(loadAvg[0] * 100) / 100,
    load_avg_5: Math.round(loadAvg[1] * 100) / 100,
    load_avg_15: Math.round(loadAvg[2] * 100) / 100,
    containers_active: queueStatus.activeCount,
    containers_queued: queueStatus.queuedCount,
    uptime_seconds: Math.round(process.uptime()),
  });
}

export function startMetricsCollector(queue: GroupQueue): void {
  // Initial cleanup
  cleanupMetrics(RETENTION_DAYS);

  // Collect first metric after 10 seconds (let CPU baseline establish)
  setTimeout(() => {
    getCpuPercent(); // prime the baseline
    setTimeout(() => {
      collectMetric(queue);
      logger.info(
        'Metrics collector started (interval: 5min, retention: 3 days)',
      );
    }, 5000);
  }, 5000);

  // Collect every 5 minutes
  setInterval(() => {
    collectMetric(queue);
  }, COLLECT_INTERVAL);

  // Cleanup daily
  setInterval(
    () => {
      cleanupMetrics(RETENTION_DAYS);
      cleanupTokenUsage(30);
    },
    24 * 60 * 60 * 1000,
  );
}
