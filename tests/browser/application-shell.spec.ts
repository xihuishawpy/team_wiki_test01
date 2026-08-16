import { expect, test } from '@playwright/test';

test('application shell remains usable while readiness is unavailable', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Team Wiki' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText(/系统状态|正在检查依赖|部分能力未配置/);
});
