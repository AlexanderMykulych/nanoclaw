<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api, type ScheduledTask, type TaskLog } from '../api';

const tasks = ref<ScheduledTask[]>([]);
const loading = ref(true);
const expandedTask = ref<string | null>(null);
const taskLogs = ref<Record<string, TaskLog[]>>({});

onMounted(async () => {
  try {
    tasks.value = await api.tasks();
  } finally {
    loading.value = false;
  }
});

async function toggleLogs(taskId: string) {
  if (expandedTask.value === taskId) {
    expandedTask.value = null;
    return;
  }
  expandedTask.value = taskId;
  if (!taskLogs.value[taskId]) {
    taskLogs.value[taskId] = await api.taskLogs(taskId);
  }
}

function formatDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleString();
}
</script>

<template>
  <div>
    <h2 class="page-title">Scheduled Tasks</h2>
    <div v-if="loading" class="loading">Loading...</div>
    <div v-else class="list">
      <div v-for="task in tasks" :key="task.id" class="task-card" @click="toggleLogs(task.id)">
        <div class="task-header">
          <div class="task-prompt">{{ task.prompt.slice(0, 80) }}{{ task.prompt.length > 80 ? '...' : '' }}</div>
          <span class="badge" :class="task.status">{{ task.status }}</span>
        </div>
        <div class="task-meta">
          {{ task.schedule_type }}: {{ task.schedule_value }} · next: {{ formatDate(task.next_run) }}
        </div>
        <div v-if="expandedTask === task.id && taskLogs[task.id]" class="logs">
          <div v-for="log in taskLogs[task.id]" :key="log.run_at" class="log-entry">
            <span class="log-status" :class="log.status">{{ log.status }}</span>
            <span class="log-date">{{ formatDate(log.run_at) }}</span>
            <span class="log-duration">{{ log.duration_ms }}ms</span>
          </div>
          <div v-if="taskLogs[task.id].length === 0" class="empty">No run history</div>
        </div>
      </div>
      <div v-if="tasks.length === 0" class="empty">No scheduled tasks</div>
    </div>
  </div>
</template>

<style scoped>
.page-title { font-size: 20px; font-weight: 700; margin-bottom: 16px; }
.list { display: flex; flex-direction: column; gap: 8px; }
.task-card { background: var(--secondary-bg); border-radius: 10px; padding: 12px 14px; cursor: pointer; }
.task-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
.task-prompt { font-weight: 500; font-size: 13px; flex: 1; }
.task-meta { font-size: 11px; color: var(--hint-color); margin-top: 6px; }
.badge { font-size: 10px; padding: 2px 8px; border-radius: 8px; font-weight: 600; flex-shrink: 0; }
.badge.active { background: #4ade8033; color: #4ade80; }
.badge.paused { background: #fbbf2433; color: #fbbf24; }
.badge.completed { background: rgba(255,255,255,0.1); color: var(--hint-color); }
.logs { margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.05); display: flex; flex-direction: column; gap: 6px; }
.log-entry { display: flex; gap: 8px; font-size: 11px; align-items: center; }
.log-status { padding: 1px 6px; border-radius: 4px; font-weight: 600; font-size: 10px; }
.log-status.success { background: #4ade8033; color: #4ade80; }
.log-status.error { background: #f8717133; color: #f87171; }
.log-status.skipped { background: #fbbf2433; color: #fbbf24; }
.log-date { color: var(--hint-color); }
.log-duration { color: var(--hint-color); opacity: 0.6; }
.loading, .empty { text-align: center; padding: 24px; color: var(--hint-color); }
</style>
