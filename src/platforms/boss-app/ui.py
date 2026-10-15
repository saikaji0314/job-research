"""BOSS Android UI worker. No private APIs, messages, application or recruiter actions."""
import hashlib
import json
import re
import sys
import time
import uuid
import xml.etree.ElementTree as ET
from urllib.parse import urlsplit

PACKAGE = 'com.hpbr.bosszhipin'
PREFIX = PACKAGE + ':id/'


class UiError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def norm(text):
    return re.sub(r'\s+', '', text or '')


def clean_title(text):
    # A trailing accessibility decoration observed on list titles; preserve the raw value separately.
    return re.sub(r'\s*&@\s*$', '', text or '').strip()


def bounds(node):
    values = list(map(int, re.findall(r'-?\d+', node.get('bounds', ''))))
    return values if len(values) == 4 else [0, 0, 0, 0]


def by_id(root, name):
    return next((n for n in root.iter('node') if n.get('resource-id') == PREFIX + name), None)


def text_of(root, name):
    n = by_id(root, name)
    return n.get('text', '') if n is not None else ''


def detail_ready(root):
    return all(text_of(root, name) for name in ['tv_job_name','tv_boss_title','tv_description'])


def verify_identity(card, title, company, full_company=None):
    if norm(title)!=norm(card['title']):
        raise UiError('IDENTITY_MISMATCH')
    truncated = lambda s: bool(re.search(r'(?:\.{3,}|…+)$',norm(s)))
    if norm(company)==norm(card['company']) and not truncated(company):
        return 'exact-title-and-company'
    strip_ellipsis = lambda s: re.sub(r'(?:\.{3,}|…+)$','',norm(s))
    prefix = strip_ellipsis(company)
    if truncated(company) and truncated(card['company']) and prefix==strip_ellipsis(card['company']):
        if len(prefix)<6 or not full_company or truncated(full_company):
            raise UiError('DETAIL_COMPANY_UNAVAILABLE')
        if not norm(full_company).startswith(prefix):
            raise UiError('IDENTITY_MISMATCH')
        return 'same-truncated-display-prefix-with-detail-full-company'
    raise UiError('IDENTITY_MISMATCH')


def is_client_company_display(card, publisher, company_label):
    match = re.fullmatch(r'客户公司\s*[:：]\s*(.+)',company_label or '')
    return bool(match and norm(match.group(1))==norm(card['company']) and norm(publisher)!=norm(card['company']))


def card_key(card):
    fields = ['title', 'company', 'city', 'salary', 'experience', 'degree']
    return hashlib.sha256(json.dumps([norm(card.get(k)) for k in fields], ensure_ascii=False).encode()).hexdigest()


def parse_cards(root):
    parents = {c: p for p in root.iter() for c in p}
    cards = []
    for title in root.iter('node'):
        if title.get('resource-id') != PREFIX + 'tv_position_name':
            continue
        container = title
        while container in parents and by_id(container, 'tv_company_name') is None:
            container = parents[container]
        if len([n for n in container.iter('node') if n.get('resource-id') == PREFIX + 'tv_position_name']) != 1:
            continue
        company = by_id(container, 'tv_company_name')
        if company is None or bounds(title)[3] <= 0 or bounds(company)[3] <= 0:
            continue
        labels = [n.get('text', '') for n in container.iter('node')]
        card = dict(title=clean_title(title.get('text')), listTitleRaw=title.get('text'),
                    company=company.get('text'), salary=text_of(container, 'tv_salary_statue'),
                    city=text_of(container, 'tv_distance'), industry=text_of(container, 'tvIndustryName'),
                    companyScale=text_of(container, 'tv_scale'), summary=text_of(container, 'tv_digest'),
                    experience=next((s for s in labels if re.fullmatch(r'(?:\d+(?:-\d+)?年(?:以上|以下)?|经验不限|应届生?|在校/应届)', s)), ''),
                    degree=next((s for s in labels if s in ['学历不限', '不限学历', '初中', '高中', '中专', '中技', '大专', '本科', '硕士', '博士']), ''),
                    tapBounds=bounds(title))
        card['fingerprint'] = card_key(card)
        cards.append(card)
    return cards


def share_job_id(text):
    for raw in re.findall(r'https://[^\s]+', text or ''):
        u = urlsplit(raw)
        if u.scheme != 'https' or u.netloc != 'm.zhipin.com':
            continue
        match = re.fullmatch(r'/mpa/html/weijd/weijd-job/([\w~-]{1,160})', u.path)
        if match:
            return match.group(1)
    raise UiError('APP_JOB_LINK_UNAVAILABLE')


def filter_groups(root):
    parents = {c:p for p in root.iter() for c in p}
    groups = {}
    for title in root.iter('node'):
        if title.get('resource-id') != PREFIX+'tv_condition_title':
            continue
        group = title
        while group in parents:
            group = parents[group]
            titles = [n for n in group.iter('node') if n.get('resource-id') == PREFIX+'tv_condition_title']
            choices = [n for n in group.iter('node') if n.get('resource-id') == PREFIX+'keywords_view_text']
            if len(titles) != 1:
                break
            if choices:
                groups[re.sub(r'[（(].*', '', title.get('text','')).strip()] = choices
                break
    return groups


def contact_switch_state(image, node):
    # This App exposes an ImageView with permanently false checked/selected attributes.
    # Accept only an unambiguous bright circular thumb, at the left or right of its own bounds.
    x1,y1,x2,y2 = bounds(node)
    if x2<=x1 or y2<=y1:
        raise UiError('APP_CONTACT_SWITCH_UNVERIFIED')
    crop = image.convert('RGB').crop((x1,y1,x2,y2))
    w,h = crop.size
    xs = [x/w for y in range(h) for x in range(w)
          if min(crop.getpixel((x,y)))>220 and max(crop.getpixel((x,y)))-min(crop.getpixel((x,y)))<30]
    if not .06 < len(xs)/(w*h) < .5:
        raise UiError('APP_CONTACT_SWITCH_UNVERIFIED')
    center = sum(xs)/len(xs)
    if center > .61:
        return True
    if center < .39:
        return False
    raise UiError('APP_CONTACT_SWITCH_UNVERIFIED')


class AppUi:
    def __init__(self, serial=None):
        import uiautomator2 as u2
        self.d = u2.connect(serial) if serial else u2.connect()
        self.d.implicitly_wait(8)
        self.width, self.height = self.d.window_size()
        self.keyword = None
        self.city = None
        self.filter_receipt = None
        self.header_verified = False
        self.condition_visibility = None

    def snapshot(self):
        root = ET.fromstring(self.d.dump_hierarchy(compressed=False))
        nodes = list(root.iter('node'))
        if not any(n.get('package') == PACKAGE and n.get('visible-to-user', 'true') == 'true' for n in nodes):
            raise UiError('DEVICE_SCREEN_UNAVAILABLE')
        activity = self.d.app_current()
        if activity.get('package') != PACKAGE:
            raise UiError('APP_NOT_FOREGROUND')
        if re.search(r'verify|captcha|security', activity.get('activity', ''), re.I):
            raise UiError('VERIFICATION_REQUIRED')
        for n in nodes:
            t = n.get('text', '')
            if len(t) < 180 and re.search(r'请完成.{0,8}验证|访问过于频繁|操作过于频繁|人机验证|账号存在异常', t):
                raise UiError('VERIFICATION_REQUIRED')
        return root

    def wait(self, predicate, timeout=12):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            root = self.snapshot()
            if predicate(root):
                return root
            time.sleep(.3)
        raise UiError('APP_STATE_CHANGED')

    def click(self, node, permitted):
        if node is None or not permitted:
            raise UiError('APP_CONTROL_UNAVAILABLE')
        # Explicit operations only. Never allow a generic caller to tap chat, send or favourite controls.
        if re.search(r'btn_chat|send|favor|apply|resume', node.get('resource-id', ''), re.I):
            raise UiError('FORBIDDEN_ACTION')
        x1, y1, x2, y2 = bounds(node)
        if x2 <= x1 or y2 <= y1 or y1 < 0 or y2 > self.height:
            raise UiError('APP_CONTROL_UNAVAILABLE')
        self.d.click((x1+x2)//2, (y1+y2)//2)
        time.sleep(.5)

    def list_root(self):
        root = self.snapshot()
        if by_id(root, 'tv_search') is not None:
            raise UiError('APP_STATE_CHANGED')
        if text_of(root, 'et_search') != self.keyword:
            raise UiError('APP_QUERY_MISMATCH')
        labels = [n.get('text') for n in root.iter('node') if n.get('resource-id') == PREFIX+'tv_tab_label']
        has_sort = any(s in labels for s in ['最新优先','综合排序','距离优先'])
        if not has_sort:
            # Observed RecyclerView scrolling hides the entire native-condition row until returning to top.
            # Keep its prior receipt only on the same verified query and the specific collapsed list layout.
            collapsed = (getattr(self,'header_verified',False) and getattr(self,'filter_receipt',None)
                         and by_id(root,'recyclerView_lable_filter') is not None and by_id(root,'recyclerView_list') is not None
                         and self.d.app_current().get('activity','').endswith('.search.geek.activity.GeekSearchActivity')
                         and not any(str(s).startswith('筛选') for s in labels))
            if not collapsed:
                raise UiError('APP_SORT_UNVERIFIED')
            self.condition_visibility = 'collapsed-header-prior-verification'
            return root
        if '最新优先' not in labels:
            raise UiError('APP_SORT_UNVERIFIED')
        if self.city.rstrip('市') not in [str(t).rstrip('市') for t in labels]:
            raise UiError('APP_CITY_MISMATCH')
        receipt = getattr(self,'filter_receipt',None)
        if receipt:
            count = sum(len([s for s in values if s!='不限']) for values in receipt['groups'].values())
            actual = next((s for s in labels if str(s).startswith('筛选')),None)
            if actual != ('筛选·'+str(count) if count else '筛选'):
                raise UiError('APP_FILTERS_UNVERIFIED')
        self.header_verified = True
        self.condition_visibility = 'visible'
        return root

    def open_editor(self):
        self.stage = 'search-editor'
        root = self.snapshot()
        if by_id(root, 'tv_search') is not None:
            return
        if by_id(root, 'tv_job_name') is not None or by_id(root, 'tv_title') is not None:
            self.click(by_id(root, 'iv_back'), True)
            root = self.wait(lambda r: by_id(r, 'et_search') is not None or len([n for n in r.iter('node') if n.get('resource-id') == PREFIX+'img_icon']) == 2)
        if by_id(root, 'et_search') is None:
            # Homepage after a normal App restart: the observed rightmost header icon is search.
            labels = [n.get('text') for n in root.iter('node')]
            icons = [n for n in root.iter('node') if n.get('resource-id') == PREFIX+'img_icon' and 0 < bounds(n)[1] < self.height*.1]
            if '推荐' in labels and '附近' in labels and len(icons) == 2:
                self.click(max(icons, key=lambda n: bounds(n)[0]), True)
            else:
                raise UiError('APP_SEARCH_UNAVAILABLE')
        else:
            self.click(by_id(root, 'et_search'), True)
        self.wait(lambda r: by_id(r, 'tv_search') is not None and by_id(r, 'et_search') is not None)

    def desired_groups(self, filters):
        activity = {None:'不限','today':'今日活跃','within3days':'3日内活跃','thisWeek':'本周活跃','thisMonth':'本月活跃'}
        return {'学历要求':['不限'],'薪资待遇':['不限'],
                '经验要求':filters.get('experienceInclude') or ['不限'],
                'BOSS活跃':[activity[filters.get('bossActivity')]],'公司规模':['不限'],'融资阶段':['不限']}

    def scan_filters(self, filters, apply=False):
        wanted = self.desired_groups(filters)
        observed = {}
        contact = None
        # Reposition a previously scrolled sheet before reading every category.
        for _ in range(4):
            self.d.swipe(self.width*.88,self.height*.35,self.width*.88,self.height*.82,.35)
        for step in range(10):
            root = self.snapshot()
            groups = filter_groups(root)
            for name, choices in groups.items():
                if name not in wanted:
                    continue
                selected = {n.get('text') for n in choices if n.get('selected')=='true'}
                expected = set(wanted[name])
                if selected != expected and apply:
                    # Re-read after each click; don't reuse coordinates after the sheet lays out again.
                    for _ in range(12):
                        choices = filter_groups(self.snapshot()).get(name,[])
                        selected = {n.get('text') for n in choices if n.get('selected')=='true'}
                        if selected == expected:
                            break
                        missing = expected-selected
                        extra = selected-expected-{'不限'}
                        options = [n for n in choices if n.get('text') in (missing or extra)
                                   and self.height*.08 < bounds(n)[1] < bounds(n)[3] < self.height*.92]
                        if not options:
                            break
                        self.click(options[0],True)
                    choices = filter_groups(self.snapshot()).get(name,[])
                    selected = {n.get('text') for n in choices if n.get('selected')=='true'}
                if selected == expected:
                    observed[name] = sorted(selected)
                else:
                    observed.pop(name,None)
            root = self.snapshot()
            switch = by_id(root,'iv_switch_btn')
            if switch is not None and self.height*.08 < bounds(switch)[1] < bounds(switch)[3] < self.height*.92:
                contact = contact_switch_state(self.d.screenshot(),switch)
                expected_contact = filters.get('showContactedWithin30Days')
                if apply and expected_contact is not None and contact != expected_contact:
                    self.click(switch,True)
                    contact = contact_switch_state(self.d.screenshot(),by_id(self.snapshot(),'iv_switch_btn'))
                if len(observed)==len(wanted):
                    break
            self.d.swipe(self.width*.88,self.height*.78,self.width*.88,self.height*.5,.4)
            time.sleep(.2)
        if len(observed)!=len(wanted) or contact is None or (filters.get('showContactedWithin30Days') is not None and contact!=filters['showContactedWithin30Days']):
            raise UiError('APP_FILTERS_UNVERIFIED')
        return {'groups':observed,'showContactedWithin30Days':contact}

    def open_filters(self):
        root = self.snapshot()
        if by_id(root,'btn_confirm') is None:
            trigger = next((n for n in root.iter('node') if n.get('resource-id')==PREFIX+'tv_tab_label' and n.get('text','').startswith('筛选')),None)
            self.click(trigger,trigger is not None)
            self.wait(lambda r:by_id(r,'btn_confirm') is not None)

    def configure_filters(self, filters):
        self.stage = 'native-filters-apply'
        self.open_filters()
        self.scan_filters(filters,apply=True)
        self.click(by_id(self.snapshot(),'btn_confirm'),True)
        self.wait(lambda r:by_id(r,'btn_confirm') is None and by_id(r,'tv_tab_label') is not None)
        self.stage = 'native-filters-verify'
        self.open_filters()
        receipt = self.scan_filters(filters,apply=False)
        self.click(by_id(self.snapshot(),'btn_confirm'),True)
        self.wait(lambda r:by_id(r,'btn_confirm') is None and by_id(r,'tv_tab_label') is not None)
        self.filter_receipt = receipt

    def ensure_latest(self):
        root = self.wait(lambda r:by_id(r,'tv_search') is None and by_id(r,'et_search') is not None and
                         (by_id(r,'recyclerView_list') is not None or any(n.get('resource-id')==PREFIX+'tv_tab_label' and n.get('text') in ['最新优先','综合排序','距离优先'] for n in r.iter('node'))))
        for _ in range(30):
            if any(n.get('resource-id')==PREFIX+'tv_tab_label' and n.get('text') in ['最新优先','综合排序','距离优先'] for n in root.iter('node')):
                break
            if text_of(root,'et_search')!=self.keyword or by_id(root,'recyclerView_lable_filter') is None:
                raise UiError('APP_SORT_UNVERIFIED')
            # Repeating an existing query can retain its scrolled list and collapsed header.
            self.d.swipe(self.width*.9,self.height*.3,self.width*.9,self.height*.88,.3)
            time.sleep(.2)
            root = self.snapshot()
        else:
            raise UiError('APP_SORT_UNVERIFIED')
        labels = [n for n in root.iter('node') if n.get('resource-id')==PREFIX+'tv_tab_label']
        if not any(n.get('text')=='最新优先' for n in labels):
            choice = next((n for n in labels if n.get('text') in ['综合排序','距离优先']),None)
            self.click(choice,choice is not None)
            menu = self.wait(lambda r:by_id(r,'tv_sort_type') is not None)
            latest = next((n for n in menu.iter('node') if n.get('text')=='最新优先' and n.get('resource-id')==PREFIX+'tv_sort_type'),None)
            self.click(latest,latest is not None)
        self.wait(lambda r:any(n.get('text')=='最新优先' and n.get('resource-id')==PREFIX+'tv_tab_label' for n in r.iter('node')))

    def search(self, keyword, city, filters=None):
        self.filter_receipt = None
        self.header_verified = False
        # A previous stopped inspection may have left the native filter sheet open.
        if by_id(self.snapshot(),'btn_confirm') is not None:
            self.click(by_id(self.snapshot(),'btn_confirm'),True)
        self.open_editor()
        field = self.d(resourceId=PREFIX+'et_search', className='android.widget.EditText')
        field.set_text(keyword)
        if field.get_text() != keyword:
            raise UiError('APP_QUERY_MISMATCH')
        self.click(by_id(self.snapshot(), 'tv_search'), True)
        self.stage = 'search-result'
        self.keyword, self.city = keyword, city
        self.ensure_latest()
        self.stage = 'sort-result'
        self.keyword, self.city = keyword, city
        self.wait(lambda r: any(n.get('text') == '最新优先' and n.get('resource-id') == PREFIX+'tv_tab_label' for n in r.iter('node')))
        self.configure_filters(filters or {})
        # Confirming the native sheet can reset sorting even when its settings were retained.
        self.ensure_latest()
        return self.list()

    def list(self):
        for _ in range(20):
            root = self.list_root()
            cards = parse_cards(root)
            for card in cards:
                card['conditionVisibility'] = self.condition_visibility
            empty = any(n.get('text') in ['暂无相关职位','暂无职位','没有找到相关职位','暂时没有符合条件的职位'] for n in root.iter('node'))
            if cards or empty:
                return {'cards':cards, 'keyword':self.keyword, 'sort':'latest', 'city':self.city,'filters':self.filter_receipt,'conditionVisibility':self.condition_visibility}
            time.sleep(.4)
        raise UiError('APP_LIST_UNAVAILABLE')

    def scroll(self):
        self.list_root()
        self.d.swipe(self.width*.5, self.height*.82, self.width*.5, self.height*.38, .65)
        time.sleep(1.5)
        return self.list()

    def expand(self, root):
        body = text_of(root, 'tv_description')
        if not body:
            raise UiError('DETAIL_MISSING')
        if not body.rstrip().endswith('查看更多'):
            return body
        for _ in range(3):
            if by_id(root, 'tv_com_name') is not None:
                break
            self.d.swipe(self.width*.5, self.height*.82, self.width*.5, self.height*.38, .65)
            time.sleep(.5)
            root = self.snapshot()
        node = by_id(root, 'tv_description')
        if node is None or by_id(root, 'tv_com_name') is None:
            raise UiError('DETAIL_EXPANSION_UNAVAILABLE')
        x1, y1, x2, y2 = bounds(node)
        # Click only the final text line of the collapsed JD, away from all bottom actions.
        y = y2 - max(12, round(self.width*35/1440))
        if not (y1 < y < y2 < self.height*.94):
            raise UiError('DETAIL_EXPANSION_UNAVAILABLE')
        for step in range(13, 0, -1):
            self.d.click(x1+(x2-x1)*step/14, y)
            time.sleep(.2)
            current = text_of(self.snapshot(), 'tv_description')
            if current and not current.rstrip().endswith('查看更多'):
                return current
        raise UiError('DETAIL_EXPANSION_UNAVAILABLE')

    def back_to_list(self):
        self.stage = 'detail-back-to-list'
        root = self.snapshot()
        if by_id(root, 'tv_share_title') is not None:
            self.d.press('back')
            time.sleep(.4)
            root = self.snapshot()
        if by_id(root, 'et_search') is None:
            self.click(by_id(root, 'iv_back'), True)
        self.wait(lambda r: text_of(r, 'et_search') == self.keyword and by_id(r, 'tv_tab_label') is not None)
        return self.list_root()

    def detail(self, expected):
        cards = parse_cards(self.list_root())
        card = next((c for c in cards if c['fingerprint'] == expected['fingerprint']), None)
        if card is None:
            raise UiError('APP_CARD_MOVED')
        x1,y1,x2,y2 = card['tapBounds']
        self.d.click((x1+x2)//2, (y1+y2)//2)
        self.stage = 'detail-header'
        root = self.wait(detail_ready,timeout=18)
        title = text_of(root, 'tv_job_name')
        company_short = re.split(r'[•·]', text_of(root, 'tv_boss_title'))[0].strip()
        if is_client_company_display(card,company_short,text_of(root,'tv_com_name')):
            # Publisher and client are different roles; don't assert a full company identity for this lead.
            raise UiError('DETAIL_COMPANY_UNAVAILABLE')
        try:
            comparison = verify_identity(card,title,company_short)
        except UiError as error:
            if error.code!='DETAIL_COMPANY_UNAVAILABLE':
                raise
            comparison = None
        result = {k:card.get(k, '') for k in ['title','company','salary','city','experience','degree','industry','companyScale','summary','listTitleRaw']}
        for name, field in [('tv_job_salary','salary'),('tv_required_location','city'),('tv_required_work_exp','experience'),('tv_required_degree','degree'),('tv_public_time','publicationLabelRaw')]:
            value = text_of(root, name)
            if value:
                result[field] = value
        self.stage = 'detail-expand'
        result['description'] = self.expand(root)
        result['companyFullName'] = text_of(self.snapshot(), 'tv_com_name')
        if comparison is None:
            for _ in range(4):
                if result['companyFullName']:
                    break
                self.d.swipe(self.width*.5,self.height*.8,self.width*.5,self.height*.4,.5)
                time.sleep(.4)
                result['companyFullName'] = text_of(self.snapshot(),'tv_com_name')
            comparison = verify_identity(card,title,company_short,result['companyFullName'])
        # Fresh sentinel prevents stale clipboard contents from being assigned to another job.
        sentinel = 'job-research-'+uuid.uuid4().hex
        self.d.set_clipboard(sentinel, 'job-research')
        if self.d.clipboard != sentinel:
            raise UiError('APP_CLIPBOARD_UNAVAILABLE')
        self.click(by_id(self.snapshot(), 'iv_share'), True)
        self.stage = 'detail-share-menu'
        menu = self.wait(lambda r: by_id(r, 'tv_share_title') is not None)
        parents = {c:p for p in menu.iter() for c in p}
        copy = next((n for n in menu.iter('node') if n.get('text') == '复制链接'), None)
        if copy is None:
            raise UiError('APP_JOB_LINK_UNAVAILABLE')
        while copy.get('clickable') != 'true' and copy in parents:
            copy = parents[copy]
        self.click(copy, True)
        self.stage = 'detail-copy-link'
        for attempt in range(10):
            value = self.d.clipboard
            if value and value != sentinel:
                result['platformJobId'] = share_job_id(value)
                break
            time.sleep(.3)
        else:
            raise UiError('APP_JOB_LINK_UNAVAILABLE')
        self.back_to_list()
        result['identityEvidence'] = json.dumps({'method':'app-title-company-and-fresh-copy-link','companyComparison':comparison,
            'listTitle':card['title'],'detailTitle':title,'listCompany':card['company'],'detailCompany':company_short,'detailFullCompany':result['companyFullName']},ensure_ascii=False)
        result.update(detailStatus='complete', detailSource='verified-app-ui', sourceChannel='android-app', searchSort='latest')
        return result


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    ui = None
    for line in sys.stdin:
        request = json.loads(line)
        try:
            op = request['op']
            if op == 'init':
                ui = AppUi(request.get('serial'))
                ui.snapshot()
                result = {'ready':True}
            elif op == 'search':
                result = ui.search(request['keyword'],request['city'],request.get('filters'))
            elif op == 'list':
                result = ui.list()
            elif op == 'scroll':
                result = ui.scroll()
            elif op == 'detail':
                result = ui.detail(request['card'])
            elif op == 'recover':
                ui.back_to_list()
                result = {'ready':True}
            elif op == 'close':
                print(json.dumps({'id':request['id'],'result':{'closed':True}}),flush=True)
                break
            else:
                raise UiError('FORBIDDEN_ACTION')
            print(json.dumps({'id':request['id'],'result':result},ensure_ascii=False),flush=True)
        except Exception as error:
            code = error.code if isinstance(error,UiError) else 'ANDROID_DRIVER_ERROR'
            print(json.dumps({'id':request['id'],'error':code,'stage':getattr(ui,'stage','init')}),flush=True)


if __name__ == '__main__':
    main()
