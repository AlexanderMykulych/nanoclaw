import { ref, onMounted, onUnmounted } from 'vue';
import { api, type HealthResponse } from '../api';

export function useHealth(intervalMs = 30000) {
  const health = ref<HealthResponse | null>(null);
  const loading = ref(true);
  const error = ref<string | null>(null);
  let timer: ReturnType<typeof setInterval> | null = null;

  async function fetch() {
    try {
      health.value = await api.health();
      error.value = null;
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  onMounted(() => {
    fetch();
    timer = setInterval(fetch, intervalMs);
  });

  onUnmounted(() => {
    if (timer) clearInterval(timer);
  });

  return { health, loading, error, refresh: fetch };
}
