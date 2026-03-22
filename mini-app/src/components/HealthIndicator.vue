<script setup lang="ts">
const props = defineProps<{
  status: 'ok' | 'warning' | 'error';
  uptime: number;
  version: string;
  summary: string;
}>();

const statusColors: Record<string, string> = {
  ok: '#4ade80',
  warning: '#fbbf24',
  error: '#f87171',
};

const statusLabels: Record<string, string> = {
  ok: 'OK',
  warning: 'WARNING',
  error: 'ERROR',
};

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}
</script>

<template>
  <div class="health-indicator">
    <div
      class="circle"
      :style="{
        borderColor: statusColors[props.status],
        background: `radial-gradient(circle, ${statusColors[props.status]}20, transparent)`,
      }"
    >
      <span class="label" :style="{ color: statusColors[props.status] }">
        {{ statusLabels[props.status] }}
      </span>
    </div>
    <div class="info">
      Uptime {{ formatUptime(props.uptime) }} · v{{ props.version }}
    </div>
    <div class="summary">{{ props.summary }}</div>
  </div>
</template>

<style scoped>
.health-indicator {
  text-align: center;
  padding: 24px 0;
}

.circle {
  width: 100px;
  height: 100px;
  border-radius: 50%;
  border: 3px solid;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
}

.label {
  font-size: 28px;
  font-weight: 800;
}

.info {
  margin-top: 12px;
  font-size: 13px;
  color: var(--hint-color);
}

.summary {
  margin-top: 4px;
  font-size: 12px;
  color: var(--hint-color);
  opacity: 0.7;
}
</style>
