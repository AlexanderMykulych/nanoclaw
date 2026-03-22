import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./views/HomeView.vue') },
    { path: '/groups', component: () => import('./views/GroupsView.vue') },
    { path: '/tasks', component: () => import('./views/TasksView.vue') },
    { path: '/errors', component: () => import('./views/ErrorsView.vue') },
  ],
});

// Telegram BackButton integration
const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

router.afterEach((to) => {
  if (to.path !== '/' && tg) {
    tg.BackButton.show();
  } else if (tg) {
    tg.BackButton.hide();
  }
});

if (tg) {
  tg.BackButton.onClick(() => router.back());
}

const app = createApp(App);
app.use(router);
app.mount('#app');
