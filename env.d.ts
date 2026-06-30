declare global {
  namespace NodeJS {
    interface ProcessEnv {
      readonly CRON_SECRET: string;
      readonly API_KEY: string;
      readonly API_URL: string;

      readonly AWS_KEY: string;
      readonly AWS_SECRET: string;
      readonly AWS_URL: string;
      readonly AWS_BUCKET: string;
    }
  }
}

export {}