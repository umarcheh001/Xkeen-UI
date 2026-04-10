import fs from 'node:fs/promises';
import path from 'node:path';

import { chromium } from '@playwright/test';


function getEnv(name, fallback) {
  const value = String(process.env[name] || '').trim();
  return value || fallback;
}


async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}


async function fillAndSubmit(page, formType) {
  const username = getEnv('E2E_USERNAME', 'admin');
  const password = getEnv('E2E_PASSWORD', 'secret123');

  if (formType === 'setup') {
    await page.getByLabel(/логин/i).fill(username);
    await page.getByLabel(/^пароль/i).fill(password);
    await page.getByLabel(/повтор/i).fill(password);
    await page.getByRole('button', { name: /сохранить/i }).click();
    return;
  }

  await page.getByLabel(/логин/i).fill(username);
  await page.getByLabel(/пароль/i).fill(password);
  await page.getByRole('button', { name: /войти/i }).click();
}


async function ensureAuthenticated(page, baseURL) {
  await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const url = page.url();
    if (!url.includes('/login') && !url.includes('/setup')) {
      await page.waitForLoadState('networkidle').catch(() => {});
      return;
    }

    if (url.includes('/setup')) {
      await fillAndSubmit(page, 'setup');
    } else {
      await fillAndSubmit(page, 'login');
    }

    await page.waitForLoadState('networkidle').catch(() => {});
  }

  const errorText = await page.locator('.auth-error').textContent().catch(() => '');
  throw new Error(
    [
      `Playwright auth bootstrap failed at ${page.url()}.`,
      'If you are targeting an existing server, provide E2E_USERNAME/E2E_PASSWORD.',
      errorText ? `Server response: ${errorText.trim()}` : '',
    ]
      .filter(Boolean)
      .join(' '),
  );
}


export default async function globalSetup(fullConfig) {
  const project = fullConfig.projects[0] || {};
  const baseURL = getEnv('E2E_BASE_URL', project.use?.baseURL || 'http://127.0.0.1:18188');
  const authPath = path.resolve('e2e/.auth/user.json');

  await ensureDir(path.dirname(authPath));

  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await ensureAuthenticated(page, baseURL);
    await page.context().storageState({ path: authPath });
  } finally {
    await browser.close();
  }
}
