<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api, type ErrorEntry } from '../api';

const errors = ref<ErrorEntry[]>([]);
const loading = ref(true);
const offset = ref(0);
const limit = 30;
const hasMore = ref(true);

async function loadErrors(append = false) {
  loading.value = true;
  try {
    const data = await api.errors(limit, offset.value);
    if (append) {
      errors.value.push(...data);
    } else {
      errors.value = data;
    }
    hasMore.value = data.length === limit;
  } finally {
    loading.value = false;
  }
}

function loadMore() {
  offset.value += limit;
  loadErrors(true);
}

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

onMounted(() => loadErrors());
</script>

<template>
  <div>
    <h2 class="page-title">Errors</h2>
    <div v-if="loading && errors.length === 0" class="loading">Loading...</div>
    <div v-else class="list">
      <div v-for="err in errors" :key="err.id" class="error-item">
        <div class="error-header">
          <span class="error-source" v-if="err.source">{{ err.source }}</span>
          <span class="error-time">{{ timeAgo(err.timestamp) }}</span>
        </div>
        <div class="error-message">{{ err.message }}</div>
        <div v-if="err.group_folder" class="error-group">{{ err.group_folder }}</div>
      </div>
      <div v-if="errors.length === 0" class="empty">No errors in the last 5 days</div>
      <button v-if="hasMore && errors.length > 0" class="load-more" @click="loadMore">
        Load more
      </button>
    </div>
  </div>
</template>

<style scoped>
.page-title { font-size: 20px; font-weight: 700; margin-bottom: 16px; }
.list { display: flex; flex-direction: column; gap: 8px; }
.error-item { background: var(--secondary-bg); border-radius: 10px; padding: 12px 14px; border-left: 2px solid #f87171; }
.error-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.error-source { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: #f87171; font-weight: 600; }
.error-time { font-size: 11px; color: var(--hint-color); }
.error-message { font-size: 13px; line-height: 1.4; }
.error-group { font-size: 11px; color: var(--hint-color); margin-top: 4px; }
.load-more { background: var(--secondary-bg); color: var(--button-color); border: none; border-radius: 10px; padding: 12px; font-size: 14px; cursor: pointer; width: 100%; margin-top: 4px; }
.loading, .empty { text-align: center; padding: 24px; color: var(--hint-color); }
</style>
