<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useHealth } from '../composables/useHealth';
import HealthIndicator from '../components/HealthIndicator.vue';
import DrillCard from '../components/DrillCard.vue';

const router = useRouter();
const { health, loading, error } = useHealth();

const summary = computed(() => {
  if (!health.value) return '';
  const h = health.value;
  const parts: string[] = [];
  parts.push(`${h.groups_count} groups`);
  parts.push(`${h.tasks_count} tasks`);
  if (h.errors_last_hour > 0) {
    parts.push(`${h.errors_last_hour} error${h.errors_last_hour > 1 ? 's' : ''} in last hour`);
  }
  return parts.join(' · ');
});

const containersSubtitle = computed(() => {
  if (!health.value) return '';
  const h = health.value;
  const parts = [`${h.active_containers} running`];
  if (h.queued_containers > 0) parts.push(`${h.queued_containers} queued`);
  return parts.join(' · ');
});
</script>

<template>
  <div class="home">
    <div v-if="loading" class="loading">Loading...</div>
    <div v-else-if="error" class="error-msg">{{ error }}</div>
    <template v-else-if="health">
      <HealthIndicator
        :status="health.status"
        :uptime="health.uptime"
        :version="health.version"
        :summary="summary"
      />

      <div class="cards">
        <DrillCard
          icon="👥"
          title="Groups"
          :subtitle="`${health.groups_count} registered`"
          @tap="router.push('/groups')"
        />
        <DrillCard
          icon="⏰"
          title="Scheduled Tasks"
          :subtitle="`${health.tasks_count} active`"
          @tap="router.push('/tasks')"
        />
        <DrillCard
          icon="⚠️"
          title="Errors"
          :subtitle="health.errors_last_hour > 0
            ? `${health.errors_last_hour} in last hour`
            : 'No recent errors'"
          :alert="health.errors_last_hour > 0"
          @tap="router.push('/errors')"
        />
        <DrillCard
          icon="📦"
          title="Containers"
          :subtitle="containersSubtitle"
          @tap="() => {}"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 8px;
}

.loading,
.error-msg {
  text-align: center;
  padding: 40px 0;
  color: var(--hint-color);
}

.error-msg {
  color: #f87171;
}
</style>
