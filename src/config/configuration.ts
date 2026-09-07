function envBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') return defaultValue;
  return value === 'true' || value === '1';
}

export default () => ({
  port: parseInt(process.env.PORT ?? '3340', 10),
  dbd: {
    baseUrl: process.env.DBD_BASE_URL ?? 'https://datawarehouse.dbd.go.th',
    headless: envBool(process.env.DBD_HEADLESS, false),
    navTimeoutMs: parseInt(process.env.DBD_NAV_TIMEOUT_MS ?? '30000', 10),
    browserChannel: process.env.DBD_BROWSER_CHANNEL?.trim() || undefined,
    debug: envBool(process.env.DBD_DEBUG, false),
    blockAssets: envBool(process.env.DBD_BLOCK_ASSETS, true),
  },
});
