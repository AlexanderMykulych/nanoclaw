/// <reference types="vite/client" />

interface TelegramWebApp {
  ready(): void;
  expand(): void;
  close(): void;
  initData: string;
  themeParams: {
    bg_color?: string;
    text_color?: string;
    hint_color?: string;
    button_color?: string;
    button_text_color?: string;
    secondary_bg_color?: string;
  };
  BackButton: {
    show(): void;
    hide(): void;
    onClick(cb: () => void): void;
  };
}

interface Window {
  Telegram?: {
    WebApp?: TelegramWebApp;
  };
}
