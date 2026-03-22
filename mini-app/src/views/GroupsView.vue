<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api, type Group } from '../api';

const groups = ref<Group[]>([]);
const loading = ref(true);

onMounted(async () => {
  try {
    groups.value = await api.groups();
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div>
    <h2 class="page-title">Groups</h2>
    <div v-if="loading" class="loading">Loading...</div>
    <div v-else class="list">
      <div v-for="group in groups" :key="group.jid" class="list-item">
        <div class="item-name">{{ group.name || group.folder }}</div>
        <div class="item-meta">
          <span v-if="group.has_active_container" class="badge active">active</span>
          <span v-else class="badge idle">idle</span>
        </div>
      </div>
      <div v-if="groups.length === 0" class="empty">No registered groups</div>
    </div>
  </div>
</template>

<style scoped>
.page-title { font-size: 20px; font-weight: 700; margin-bottom: 16px; }
.list { display: flex; flex-direction: column; gap: 8px; }
.list-item { background: var(--secondary-bg); border-radius: 10px; padding: 12px 14px; display: flex; justify-content: space-between; align-items: center; }
.item-name { font-weight: 500; font-size: 14px; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 8px; font-weight: 600; }
.badge.active { background: #4ade8033; color: #4ade80; }
.badge.idle { background: rgba(255, 255, 255, 0.1); color: var(--hint-color); }
.loading, .empty { text-align: center; padding: 24px; color: var(--hint-color); }
</style>
