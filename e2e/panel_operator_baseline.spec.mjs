import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from './fixtures.mjs';


const captureEnabled = process.env.XKEEN_CAPTURE_STAGE0_BASELINE === '1';
const outputDir = path.join(process.cwd(), 'docs', 'panel-operator-stage0-baseline');
const viewports = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 360, height: 800 },
];


test.describe('Operator Console Stage 0 visual baseline capture', () => {
  test.skip(!captureEnabled, 'Set XKEEN_CAPTURE_STAGE0_BASELINE=1 to refresh the documented baseline.');

  for (const theme of ['dark', 'light']) {
    for (const viewport of viewports) {
      test(`routing ${theme} ${viewport.width}x${viewport.height}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.addInitScript((nextTheme) => {
          localStorage.setItem('xkeen-theme', nextTheme);
          localStorage.setItem('xkeen.editor.engine', 'codemirror');
        }, theme);
        await page.goto('/');
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(page.locator('#view-routing')).toBeVisible();
        await expect(page.locator('.panel-header')).toBeVisible();
        await page.evaluate(() => document.fonts?.ready);
        await page.addStyleTag({
          content: `
            *, *::before, *::after {
              animation-duration: 0s !important;
              animation-delay: 0s !important;
              transition-duration: 0s !important;
              caret-color: transparent !important;
            }
          `,
        });

        fs.mkdirSync(outputDir, { recursive: true });
        await page.screenshot({
          path: path.join(outputDir, `routing-${theme}-${viewport.width}x${viewport.height}.png`),
          fullPage: false,
          animations: 'disabled',
          caret: 'hide',
        });
      });
    }
  }
});
