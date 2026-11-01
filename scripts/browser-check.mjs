import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { buildBrief } from '../public/brief.js';

const baseUrl = (process.env.PREFLIGHT_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/u, '');
const artifactDir = resolve('artifacts/browser');
const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

function fail(message) { throw new Error(message); }

async function waitForExample(page) {
  await page.getByRole('button', { name: /See an example report/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.check').length === 16);
}

async function run() {
  const exampleResponse = await fetch(`${baseUrl}/api/example`);
  if (!exampleResponse.ok) fail(`GET /api/example returned ${exampleResponse.status}`);
  const example = await exampleResponse.json();
  if (!example?.ok || !example.report) fail('GET /api/example did not return a report');

  await mkdir(artifactDir, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox'],
  });

  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({ viewport, extraHTTPHeaders: {'X-Archbotics-QA': '1', DNT: '1'} });
      const page = await context.newPage();
      await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
      await page.screenshot({ path: resolve(artifactDir, `preflight-landing-${viewport.name}.png`), fullPage: true });
      const landingAxe = await new AxeBuilder({ page }).analyze();
      if (landingAxe.violations.length) fail(`Landing Axe violations: ${landingAxe.violations.map(item => item.id).join(', ')}`);
      await waitForExample(page);

      const layout = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        checks: document.querySelectorAll('.check').length,
      }));
      if (layout.overflow || layout.checks !== 16) fail(`${viewport.name}: ${JSON.stringify(layout)}`);

      await page.screenshot({ path: resolve(artifactDir, `preflight-example-${viewport.name}.png`), fullPage: true });
      await page.screenshot({ path: resolve(artifactDir, `preflight-example-viewport-${viewport.name}.png`) });
      const reportAxe = await new AxeBuilder({ page }).analyze();
      if (reportAxe.violations.length) fail(`Report Axe violations: ${reportAxe.violations.map(item => item.id).join(', ')}`);

      if (viewport.name === 'desktop') {
        const urlBefore = page.url();
        const checksBefore = await page.locator('.check').count();
        await page.getByRole('button', { name: 'Public API', exact: true }).click();
        await page.getByRole('dialog').waitFor();
        await page.getByRole('button', { name: 'Close documentation' }).click();
        const checksAfter = await page.locator('.check').count();
        if (page.url() !== urlBefore || checksAfter !== checksBefore) fail('Documentation dialog changed report state');

        const download = await Promise.all([
          page.waitForEvent('download'),
          page.getByRole('button', { name: 'Download .md' }).click(),
        ]).then(([item]) => item);
        const downloadedBrief = await readFile(await download.path(), 'utf8');
        if (downloadedBrief !== buildBrief(example.report)) fail('Downloaded Markdown differs from buildBrief(report)');

        const axe = await new AxeBuilder({ page }).analyze();
        if (axe.violations.length) fail(`Axe violations: ${axe.violations.map(item => item.id).join(', ')}`);
      }

      await context.close();
      console.log(`${viewport.name}: 16 checks, no overflow`);
    }
  } finally {
    await browser.close();
  }
}

run().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
