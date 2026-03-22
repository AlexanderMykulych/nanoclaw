const tg = window.Telegram?.WebApp;

async function fetchApi<T>(path: string): Promise<T> {
  const url = new URL(path, window.location.origin);
  if (tg?.initData) {
    url.searchParams.set('_auth', tg.initData);
  }

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<T>;
}

export interface HealthResponse {
  status: 'ok' | 'warning' | 'error';
  uptime: number;
  version: string;
  groups_count: number;
  tasks_count: number;
  errors_last_hour: number;
  active_containers: number;
  queued_containers: number;
}

export interface Group {
  jid: string;
  name: string;
  folder: string;
  has_active_container: boolean;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  status: string;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
}

export interface TaskLog {
  run_at: string;
  duration_ms: number;
  status: string;
  result: string | null;
  error: string | null;
}

export interface ErrorEntry {
  id: number;
  timestamp: string;
  level: string;
  source: string | null;
  group_folder: string | null;
  message: string;
  stack: string | null;
}

export const api = {
  health: () => fetchApi<HealthResponse>('/api/health'),
  groups: () => fetchApi<Group[]>('/api/groups'),
  tasks: () => fetchApi<ScheduledTask[]>('/api/tasks'),
  taskLogs: (id: string) => fetchApi<TaskLog[]>(`/api/tasks/${id}/logs`),
  errors: (limit = 50, offset = 0) =>
    fetchApi<ErrorEntry[]>(`/api/errors?limit=${limit}&offset=${offset}`),
};
