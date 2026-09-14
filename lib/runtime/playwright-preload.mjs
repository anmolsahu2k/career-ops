/**
 * Side-effect preload: strip Cursor sandbox Playwright paths before any
 * `import 'playwright'` in this process. Must be the first import of CLI
 * entrypoints (bin/career-ops.mjs, doctor.mjs).
 */
import { sanitizePlaywrightBrowsersEnv } from './playwright-browser.mjs';

sanitizePlaywrightBrowsersEnv();
