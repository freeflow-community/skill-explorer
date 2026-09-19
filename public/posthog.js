/** Initialize the browser-only PostHog SDK once from server-provided public config. */
export function initializePosthog(config) {
  if (!config?.projectToken || !config?.host || !config?.assetHost) {
    if (config?.isDevelopment) {
      const variable = !config?.projectToken ? "POSTHOG_PROJECT_TOKEN" : "POSTHOG_HOST";
      throw new Error(`${variable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${variable} is configured`);
    }
    return;
  }

  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.async = true;
    script.src = `${config.assetHost}/static/array.js`;
    script.onload = () => {
      window.posthog.init(config.projectToken, {
        api_host: config.host,
        defaults: "2026-05-30",
        capture_exceptions: {
          capture_unhandled_errors: true,
          capture_unhandled_rejections: true,
          capture_console_errors: false,
        },
      });
      resolve();
    };
    script.onerror = resolve;
    document.head.append(script);
  });
}
