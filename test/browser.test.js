import test from 'node:test';
import assert from 'node:assert/strict';
import { BossAdapter } from '../src/platforms/boss/adapter.js';
import { sessionState } from '../src/browser/session.js';

// Opt-in: actual browser process, but ALL requests are intercepted; never accesses a recruitment site.
test('Chrome local-fixture integration: discovery, full JD, mismatched ID, login and verification',
  {skip:process.env.JOB_RESEARCH_BROWSER_TEST!=='1',timeout:60000},async()=> {
    const {chromium}=await import('patchright');
    const browser=await chromium.launch({channel:process.env.JOB_RESEARCH_TEST_BROWSER || 'chrome',headless:true});
    const context=await browser.newContext({serviceWorkers:'block'}),requests=[];
    try {
      await context.route('**/*',async route=> {
        const request=route.request(),url=new URL(request.url());requests.push({path:url.pathname,method:request.method()});
        if(url.hostname!=='www.zhipin.com') return route.abort();
        if(url.pathname==='/wapi/zpgeek/search/joblist.json') return route.fulfill({json:{code:0,zpData:{hasMore:false,jobList:[{encryptJobId:'fixture-browser',jobName:'虚构岗位',brandName:'虚构公司',salaryDesc:'18-28K',jobExperience:'1-3年'}]}}});
        if(url.pathname==='/wapi/zpgeek/job/detail.json') return route.fulfill({json:{code:0,zpData:{jobInfo:{encryptId:url.searchParams.get('id'),jobName:'虚构岗位',postDescription:'岗位职责：开发接口。\n本公司直招。此内容完全虚构。'}}}});
        const auth='<nav><ul><li class="nav-figure">虚构登录标记</li></ul></nav>';
        let html;
        if(url.pathname.includes('verify')) html='<div>本地验证页面</div>';
        else if(url.pathname.includes('/web/user/')) html='<a class="header-login-btn">登录</a>';
        else if(url.pathname.startsWith('/job_detail/')) {
          const id=url.pathname.includes('wrong')?'other-job':'fixture-browser';
          html=auth+`<div class="job-sec-text">本地样例正文</div><script>fetch('/wapi/zpgeek/job/detail.json?id=${id}')</script>`;
        } else html=auth+'<div class="job-list-container"><li class="job-card-wrapper"><a href="/job_detail/fixture-browser.html"><span class="job-name">虚构岗位</span></a></li></div><script>fetch("/wapi/zpgeek/search/joblist.json?query=sample")</script>';
        return route.fulfill({contentType:'text/html; charset=utf-8',body:html});
      });
      const page=await context.newPage(),adapter=new BossAdapter(page);
      await adapter.initialize();let jobs=[];
      const result=await adapter.discover({keyword:'sample',cityCode:'fixture-city',maxScrolls:1,limit:3,onBatch:async batch=>jobs.push(...batch)});
      assert.equal(result.discovered,1);assert.equal(jobs[0].detailStatus,'pending');assert.equal(jobs[0].description,'');
      const detail=await adapter.detail(jobs[0]);assert.equal(detail.detailStatus,'complete');assert.equal(detail.employmentType,'direct');
      assert.ok(detail.description.includes('此内容完全虚构'));
      await assert.rejects(adapter.detail({...jobs[0],platformJobId:'wrong',href:'https://www.zhipin.com/job_detail/wrong.html'}),e=>e.code==='IDENTITY_MISMATCH');
      await page.goto('https://www.zhipin.com/web/user/');assert.equal(await sessionState(page),'unauthenticated');
      await assert.rejects(adapter.authenticate(),e=>e.code==='AUTHENTICATION_REQUIRED');
      await page.goto('https://www.zhipin.com/web/user/safe/verify-slider');assert.equal(await sessionState(page),'verification');
      assert.ok(requests.every(x=>x.method==='GET'));assert.ok(!requests.some(x=>/friend|chat|send|deliver/.test(x.path)));
    }finally{await context.close();await browser.close();}
  });
