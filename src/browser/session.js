import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ResearchError, abortIfNeeded } from '../domain/errors.js';

export function assertBossUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new ResearchError('INVALID_URL'); }
  if (url.protocol !== 'https:' || !(url.hostname === 'zhipin.com' || url.hostname.endsWith('.zhipin.com')) || url.username || url.password) throw new ResearchError('INVALID_URL', '仅允许 BOSS 官方 HTTPS 页面');
  return url;
}
export const AUTH = 'a[ka="header-message"], a[ka="header-resume"], a[href*="/web/geek/chat"], li.nav-figure';
const LOGIN = 'a.header-login-btn, a[href="/web/user/"], a[href*="/web/user/?intent=0"]';
const visible = selector => selector.split(', ').map(s => `${s}:visible`).join(', ');
export async function sessionState(page) {
  if (page.isClosed()) throw new ResearchError('BROWSER_CLOSED', '采集浏览器已关闭');
  assertBossUrl(page.url());
  if (/\/.*(?:verify|security-check|safe\/verify)/i.test(new URL(page.url()).pathname)
    || await page.locator('.geetest_panel:visible, iframe[src*="captcha"]:visible').first().isVisible().catch(() => false)) return 'verification';
  if (await page.locator(visible(LOGIN)).first().isVisible().catch(() => false)) return 'unauthenticated';
  if (await page.locator(visible(AUTH)).first().isVisible().catch(() => false)) return 'authenticated';
  return 'unknown';
}
export async function requireAuthenticated(page) {
  await page.locator(visible(`${AUTH}, ${LOGIN}`)).first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  const state = await sessionState(page);
  if (state === 'verification') throw new ResearchError('VERIFICATION_REQUIRED', '平台要求验证，已暂停；请先运行 login 完成人工验证');
  if (state !== 'authenticated') throw new ResearchError('AUTHENTICATION_REQUIRED', '无法确认登录状态，已暂停；请先运行 login');
}
export async function openSession({ profileDir = '.profiles/boss', browser = 'chrome', headless = false } = {}) {
  if (!['chrome','msedge','chromium'].includes(browser)) throw new ResearchError('INVALID_BROWSER', 'browser 可选 chrome、msedge、chromium');
  await mkdir(profileDir, { recursive: true });
  const { chromium } = await import('patchright');
  const context = await chromium.launchPersistentContext(resolve(profileDir), { ...(browser === 'chromium' ? {} : { channel: browser }),
    headless, viewport: null, locale: 'zh-CN' });
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(15000);
  return { context, page, close: () => context.close() };
}
export async function login(session, { timeoutSeconds = 300, signal, log = console.log } = {}) {
  const page = session.page;
  await page.goto('https://www.zhipin.com/web/geek/jobs', { waitUntil: 'domcontentloaded', timeout: 45000 });
  log('请在打开的独立浏览器窗口中完成登录／验证；确认成功后程序会自动保存会话并退出。');
  const deadline = Date.now() + timeoutSeconds*1000;
  while (Date.now() < deadline) {
    abortIfNeeded(signal);
    if (await sessionState(page) === 'authenticated') { log('登录状态已确认，会话保存在本机 Profile 中。'); return; }
    await page.waitForTimeout(1000);
  }
  throw new ResearchError('LOGIN_TIMEOUT', '等待登录超时，可重新运行 login');
}
