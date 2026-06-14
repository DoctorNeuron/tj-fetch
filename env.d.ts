declare global {
  namespace NodeJS {
    interface ProcessEnv {
      readonly CRON_SECRET: string;
      readonly API_KEY: string;
      readonly API_URL: string;
    }
  }
}

export {}