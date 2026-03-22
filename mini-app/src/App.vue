<script setup lang="ts">
const tg = window.Telegram?.WebApp;
const theme = tg?.themeParams ?? {};

const cssVars = {
  '--bg-color': theme.bg_color ?? '#0f0f23',
  '--text-color': theme.text_color ?? '#e0e0e0',
  '--hint-color': theme.hint_color ?? '#999999',
  '--button-color': theme.button_color ?? '#60a5fa',
  '--secondary-bg': theme.secondary_bg_color ?? '#1a1a3e',
};
</script>

<template>
  <div class="app" :style="cssVars">
    <router-view />
  </div>
</template>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}

.app {
  background: var(--bg-color);
  color: var(--text-color);
  min-height: 100vh;
  padding: 16px;
}
</style>
