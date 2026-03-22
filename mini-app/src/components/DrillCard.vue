<script setup lang="ts">
defineProps<{
  icon: string;
  title: string;
  subtitle: string;
  alert?: boolean;
}>();

const emit = defineEmits<{
  tap: [];
}>();
</script>

<template>
  <div class="drill-card" :class="{ alert }" @click="emit('tap')">
    <div class="card-icon">{{ icon }}</div>
    <div class="card-content">
      <div class="card-title">{{ title }}</div>
      <div class="card-subtitle">{{ subtitle }}</div>
    </div>
    <div class="card-arrow">›</div>
  </div>
</template>

<style scoped>
.drill-card {
  background: var(--secondary-bg);
  border-radius: 12px;
  padding: 14px;
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  transition: opacity 0.15s;
}

.drill-card:active {
  opacity: 0.7;
}

.drill-card.alert {
  border-left: 2px solid #f87171;
}

.card-icon {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  flex-shrink: 0;
}

.card-content {
  flex: 1;
  min-width: 0;
}

.card-title {
  font-weight: 600;
  font-size: 14px;
}

.card-subtitle {
  font-size: 11px;
  color: var(--hint-color);
  margin-top: 2px;
}

.card-arrow {
  font-size: 20px;
  color: var(--hint-color);
  opacity: 0.4;
}
</style>
