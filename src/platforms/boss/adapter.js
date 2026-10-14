import { assertBossUrl, requireAuthenticated } from '../../browser/session.js';
import { ResearchError, abortIfNeeded } from '../../domain/errors.js';
import { mapListJob, mapDetail, resolveRegion, searchUrl, decodeBossText } from './mapping.js';
import { sanitizeJob } from '../../domain/job.js';

const CARD = 'li.job-card-wrapper, ul.rec-job-list li.job-card-box, .job-list-container li.job-card-box';
const LIST_PATHS = ['/wapi/zpgeek/search/joblist.json','/wapi/zpgeek/pc/recommend/job/list.json'];
export class BossAdapter {
  constructor(page) { this.page = page; }
  async authenticate() { await requireAuthenticated(this.page); }
  async initialize() {
    await this.page.goto('https://www.zhipin.com/web/geek/jobs', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await this.authenticate();
  }
  async regionCode(name) {
    if (!this.regions) {
      const response = await this.page.request.get('https://www.zhipin.com/wapi/zpCommon/data/city.json', { timeout: 15000 });
      if (!response.ok()) throw new ResearchError('REGION_UNAVAILABLE', '无法加载平台城市字典');
      const payload = await response.json();
      if (payload.code !== 0 || !Array.isArray(payload.zpData?.cityList)) throw new ResearchError('REGION_UNAVAILABLE', '平台城市字典格式不符');
      this.regions = payload.zpData.cityList;
    }
    return resolveRegion(this.regions, name);
  }
  async discover({ keyword, cityCode, maxScrolls, limit, onBatch, signal }) {
    await this.authenticate();
    const url = searchUrl(cityCode, keyword);
    const seen = new Set(), pending = new Set();
    let hasMore = null, received = 0, rejected = false, closed = false, invalidItems = 0;
    const batches = [];
    const handler = response => {
      const responseUrl = new URL(response.url());
      if (!LIST_PATHS.includes(responseUrl.pathname) || !responseUrl.hostname.endsWith('zhipin.com')) return;
      if (responseUrl.searchParams.has('query') && responseUrl.searchParams.get('query') !== keyword) return;
      const task = (async () => {
        if (!response.ok()) return;
        const payload = await response.json();
        if (closed) return;
        if (payload.code !== 0) { rejected = true; return; }
        if (!Array.isArray(payload.zpData?.jobList)) return;
        received++;
        hasMore = payload.zpData.hasMore ?? null;
        const jobs = [];
        for (const item of payload.zpData.jobList) {
          try { jobs.push(mapListJob(item)); } catch { invalidItems++; }
        }
        batches.push(jobs);
      })().catch(() => {});
      pending.add(task); task.finally(() => pending.delete(task));
    };
    const flush = async () => {
      await Promise.all([...pending]);
      const items = batches.splice(0).flat();
      const candidates = received > 0 ? items : await this.readCards();
      const fresh = candidates.filter(job => !seen.has(job.platformJobId)).slice(0, Math.max(limit-seen.size,0));
      if (fresh.length) {
        await onBatch(fresh, { sourceUrl: url });
        fresh.forEach(job => seen.add(job.platformJobId));
      }
    };
    this.page.on('response', handler);
    try {
      abortIfNeeded(signal);
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await this.page.locator(`${CARD}, .job-list-empty, .search-job-result .empty-result`).first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      await this.authenticate();
      await flush();
      let stagnant = 0;
      for (let step=0;step<maxScrolls && seen.size<limit && hasMore!==false;step++) {
        abortIfNeeded(signal);
        const before = seen.size, beforeResponses = received;
        const cards = this.page.locator(CARD), count = await cards.count();
        if (count) await cards.last().scrollIntoViewIfNeeded().catch(() => {});
        await this.page.evaluate(() => {
          const target = ['.job-list-container','.job-list-box'].map(s => document.querySelector(s)).find(e => e && e.scrollHeight>e.clientHeight);
          (target || window).scrollBy(0,800);
        });
        await this.page.waitForTimeout(1800);
        await this.authenticate();
        await flush();
        stagnant = seen.size>before || received>beforeResponses ? 0 : stagnant+1;
        if (stagnant>=2) break;
      }
      if (!seen.size && rejected) throw new ResearchError('LIST_RESPONSE_REJECTED', '平台列表接口拒绝请求，未取得有效岗位');
      if (!seen.size && invalidItems) throw new ResearchError('LIST_SCHEMA_MISMATCH', '列表响应存在但岗位字段无法解析，请检查平台适配');
      if (!seen.size && !received && !await this.page.locator('.job-list-empty, .empty-result').first().isVisible().catch(() => false)) throw new ResearchError('LIST_UNAVAILABLE', '未识别到列表响应或明确空结果，请核对页面适配');
      return { url, discovered: seen.size, invalidItems, reason: seen.size>=limit ? 'limit' : hasMore===false ? 'end' : 'scroll_budget' };
    } catch(error) {
      if(this.page.isClosed()) throw new ResearchError('BROWSER_CLOSED','浏览器已关闭，采集已暂停');
      throw error;
    } finally { closed = true; this.page.off('response',handler); await Promise.all([...pending]); }
  }
  async readCards() {
    const cards = this.page.locator(CARD), jobs = [];
    const text = async (card,selector) => (await card.locator(selector).first().textContent().catch(() => ''))?.trim() || '';
    for (let i=0;i<await cards.count();i++) {
      const card = cards.nth(i);
      const href = await card.locator('a[href*="/job_detail/"]').first().getAttribute('href').catch(() => null);
      if (!href) continue;
      const url = new URL(href,'https://www.zhipin.com');
      assertBossUrl(url);
      const id = url.pathname.match(/^\/job_detail\/([\w~-]+)\.html$/)?.[1];
      if (!id) continue;
      jobs.push(sanitizeJob({ platformJobId: id, title: await text(card,'.job-name, .job-title'), company: await text(card,'.company-name'),
        city: await text(card,'.job-area, .job-area-wrapper'), salary: decodeBossText(await text(card,'.job-salary, .salary')),
        summary: await text(card,'.job-card-footer, .tag-list'), detailStatus: 'pending' }));
    }
    return jobs;
  }
  async detail(job) {
    await this.authenticate();
    assertBossUrl(job.href);
    // Listen BEFORE navigation; only the encrypted ID in the response can establish identity.
    const responses = [], pending = new Set();
    const handler = response => {
      const url = new URL(response.url());
      if (url.hostname !== 'www.zhipin.com' || url.pathname !== '/wapi/zpgeek/job/detail.json') return;
      const promise = (async () => { if(response.ok()) responses.push(await response.json()); })().catch(() => {});
      pending.add(promise); promise.finally(() => pending.delete(promise));
    };
    this.page.on('response',handler);
    try {
      await this.page.goto(job.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await this.page.locator('.job-sec-text, .job-detail, .job-banner, .job-status').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      await this.authenticate();
      await this.page.waitForTimeout(500);
      await Promise.all([...pending]);
      const candidates = responses.filter(p => (p.zpData?.jobInfo?.encryptId || p.zpData?.jobInfo?.encryptJobId) === job.platformJobId);
      if (!candidates.length) {
        if (responses.some(p => p.zpData?.jobInfo)) throw new ResearchError('IDENTITY_MISMATCH', '响应属于其他岗位，已拒绝写入');
        throw new ResearchError('DETAIL_MISSING', '未取得可校验身份的详情响应；页面标签不会作为完整 JD');
      }
      return mapDetail(candidates.at(-1),job);
    } catch(error) {
      if(this.page.isClosed()) throw new ResearchError('BROWSER_CLOSED','浏览器已关闭，采集已暂停');
      throw error;
    } finally { this.page.off('response',handler); await Promise.all([...pending]); }
  }
}
