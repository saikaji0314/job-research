import importlib.util
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location('app_ui', Path(__file__).parents[1] / 'src/platforms/boss-app/ui.py')
ui = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ui)


class AndroidUiTests(unittest.TestCase):
    def test_different_truncated_company_labels_remain_unverified(self):
        card={'title':'虚构工程师','company':'虚构示例企业...'}
        with self.assertRaisesRegex(ui.UiError,'DETAIL_COMPANY_UNAVAILABLE'):
            ui.verify_identity(card,'虚构工程师','虚构示例企业.....')
        with self.assertRaisesRegex(ui.UiError,'IDENTITY_MISMATCH'):
            ui.verify_identity(card,'其他职位','虚构示例企业...')
        with self.assertRaisesRegex(ui.UiError,'IDENTITY_MISMATCH'):
            ui.verify_identity(card,'虚构工程师','另一家企业')
        with self.assertRaisesRegex(ui.UiError,'IDENTITY_MISMATCH'):
            ui.verify_identity(card,'虚构工程师','虚构示例企业.....','其他完整公司名称')
        self.assertEqual(ui.verify_identity(card,'虚构工程师','虚构示例企业.....','虚构示例企业咨询有限公司'),
                         'same-truncated-display-prefix-with-detail-full-company')
        with self.assertRaisesRegex(ui.UiError,'DETAIL_COMPANY_UNAVAILABLE'):
            ui.verify_identity({'title':'虚构工程师','company':'示例...'},'虚构工程师','示例.....','示例有限公司')
        ui.verify_identity({'title':'虚构工程师','company':'虚构公司'},'虚构工程师','虚构公司')
    def test_filter_categories_scope_identical_unlimited_labels(self):
        root=ET.Element('hierarchy')
        for name,selected in [('学历要求','不限'),('BOSS活跃（单选）','3日内活跃')]:
            group=ET.SubElement(root,'node');header=ET.SubElement(group,'node')
            ET.SubElement(header,'node',{'resource-id':ui.PREFIX+'tv_condition_title','text':name})
            for text in ['不限','3日内活跃']:
                ET.SubElement(group,'node',{'resource-id':ui.PREFIX+'keywords_view_text','text':text,'selected':str(text==selected).lower()})
        groups=ui.filter_groups(root)
        self.assertEqual([n.get('text') for n in groups['学历要求'] if n.get('selected')=='true'],['不限'])
        self.assertEqual([n.get('text') for n in groups['BOSS活跃'] if n.get('selected')=='true'],['3日内活跃'])

    def test_switch_uses_thumb_position_and_refuses_ambiguous_visuals(self):
        from PIL import Image,ImageDraw
        node=ET.Element('node',{'bounds':'[0,0][180,100]','checked':'false','selected':'false'})
        for expected,x in [(False,38),(True,140)]:
            im=Image.new('RGB',(180,100),(15,160,160));draw=ImageDraw.Draw(im)
            draw.ellipse((x-25,25,x+25,75),fill='white')
            self.assertEqual(ui.contact_switch_state(im,node),expected)
        with self.assertRaisesRegex(ui.UiError,'APP_CONTACT_SWITCH_UNVERIFIED'):
            ui.contact_switch_state(Image.new('RGB',(180,100),'black'),node)

    def test_link_identity_requires_exact_official_host_and_job_path(self):
        self.assertEqual(ui.share_job_id('岗位 https://m.zhipin.com/mpa/html/weijd/weijd-job/fixture-id?sid=discard'), 'fixture-id')
        for value in ['https://m.zhipin.com.evil.test/mpa/html/weijd/weijd-job/wrong', 'https://m.zhipin.com@evil.test/mpa/html/weijd/weijd-job/wrong',
                      'http://m.zhipin.com/mpa/html/weijd/weijd-job/wrong', 'https://m.zhipin.com/other/fixture-id', 'job-research-stale-sentinel']:
            with self.assertRaises(ui.UiError):
                ui.share_job_id(value)

    def test_xml_preserves_greater_than_entities_and_multiline_text(self):
        root = ET.fromstring('<hierarchy><node resource-id="com.hpbr.bosszhipin:id/tv_description" text="A > B&#10;完整正文 &amp; 末尾"/></hierarchy>')
        self.assertEqual(ui.text_of(root, 'tv_description'), 'A > B\n完整正文 & 末尾')

    def test_card_grouping_does_not_mix_companies_or_recruiter_fields(self):
        root = ET.Element('hierarchy')
        for i in range(2):
            row = ET.SubElement(root, 'node')
            fields = [('tv_position_name', '虚构工程师 &@ '), ('tv_company_name', '虚构公司'+str(i)), ('tv_salary_statue', '20-30K'),
                      ('tv_distance', '示例城市'), ('', '1-3年'), ('', '本科'), ('tv_employer', '不得保留的个人信息')]
            for key,value in fields:
                ET.SubElement(row, 'node', {'resource-id':ui.PREFIX+key if key else '', 'text':value, 'bounds':'[10,800][300,900]'})
        cards = ui.parse_cards(root)
        self.assertEqual(len(cards),2)
        self.assertEqual(cards[0]['company'],'虚构公司0')
        self.assertEqual(cards[1]['company'],'虚构公司1')
        self.assertEqual(cards[0]['title'],'虚构工程师')
        self.assertNotEqual(cards[0]['fingerprint'],cards[1]['fingerprint'])
        self.assertNotIn('不得保留的个人信息', str(cards))

    def test_message_and_favourite_buttons_cannot_be_clicked(self):
        worker = ui.AppUi.__new__(ui.AppUi)
        for name in ['btn_chat','iv_favor','send_resume','apply']:
            node = ET.Element('node', {'resource-id':ui.PREFIX+name,'bounds':'[1,1][20,20]'})
            with self.assertRaisesRegex(ui.UiError,'FORBIDDEN_ACTION'):
                worker.click(node,True)

    def test_result_search_bar_is_an_edittext_but_does_not_mean_editor_is_open(self):
        worker=ui.AppUi.__new__(ui.AppUi)
        worker.keyword='fixture';worker.city='示例城市'
        root=ET.fromstring('<hierarchy><node resource-id="com.hpbr.bosszhipin:id/et_search" class="android.widget.EditText" text="fixture"/>'
                           '<node resource-id="com.hpbr.bosszhipin:id/tv_tab_label" text="最新优先"/>'
                           '<node resource-id="com.hpbr.bosszhipin:id/tv_tab_label" text="示例城市"/></hierarchy>')
        worker.snapshot=lambda:root
        self.assertIs(worker.list_root(),root)
        ET.SubElement(root,'node',{'resource-id':ui.PREFIX+'tv_search','text':'搜索'})
        with self.assertRaisesRegex(ui.UiError,'APP_STATE_CHANGED'):
            worker.list_root()

    def test_title_arriving_before_company_and_body_is_not_ready_for_identity_check(self):
        root=ET.fromstring('<hierarchy><node resource-id="com.hpbr.bosszhipin:id/tv_job_name" text="虚构岗位"/></hierarchy>')
        self.assertFalse(ui.detail_ready(root))
        ET.SubElement(root,'node',{'resource-id':ui.PREFIX+'tv_boss_title','text':'虚构公司 • 招聘者'})
        self.assertFalse(ui.detail_ready(root))
        ET.SubElement(root,'node',{'resource-id':ui.PREFIX+'tv_description','text':'虚构正文'})
        self.assertTrue(ui.detail_ready(root))

    def test_collapsed_header_requires_same_query_prior_receipt_and_observed_list_layout(self):
        from types import SimpleNamespace
        worker=ui.AppUi.__new__(ui.AppUi);worker.keyword='fixture';worker.city='示例城市'
        worker.header_verified=True;worker.filter_receipt={'groups':{}}
        worker.d=SimpleNamespace(app_current=lambda:{'activity':'.search.geek.activity.GeekSearchActivity'})
        root=ET.Element('hierarchy')
        for name,text in [('et_search','fixture'),('recyclerView_lable_filter',''),('recyclerView_list','')]:
            ET.SubElement(root,'node',{'resource-id':ui.PREFIX+name,'text':text})
        worker.snapshot=lambda:root
        self.assertIs(worker.list_root(),root)
        self.assertEqual(worker.condition_visibility,'collapsed-header-prior-verification')
        worker.header_verified=False
        with self.assertRaisesRegex(ui.UiError,'APP_SORT_UNVERIFIED'):
            worker.list_root()
        worker.header_verified=True
        ui.by_id(root,'et_search').set('text','other')
        with self.assertRaisesRegex(ui.UiError,'APP_QUERY_MISMATCH'):
            worker.list_root()
        ui.by_id(root,'et_search').set('text','fixture')
        ET.SubElement(root,'node',{'resource-id':ui.PREFIX+'tv_tab_label','text':'综合排序'})
        with self.assertRaisesRegex(ui.UiError,'APP_SORT_UNVERIFIED'):
            worker.list_root()

    def test_search_recovers_controls_from_retained_scroll_before_checking_sort(self):
        from types import SimpleNamespace
        worker=ui.AppUi.__new__(ui.AppUi);worker.keyword='fixture';worker.width=1440;worker.height=3200
        root=ET.Element('hierarchy')
        for name,text in [('et_search','fixture'),('recyclerView_lable_filter',''),('recyclerView_list','')]:
            ET.SubElement(root,'node',{'resource-id':ui.PREFIX+name,'text':text})
        worker.snapshot=lambda:root
        worker.wait=lambda predicate:root if predicate(root) else self.fail('Unexpected wait')
        swipes=[]
        def swipe(*args):
            swipes.append(args)
            ET.SubElement(root,'node',{'resource-id':ui.PREFIX+'tv_tab_label','text':'最新优先'})
        worker.d=SimpleNamespace(swipe=swipe)
        worker.ensure_latest()
        self.assertEqual(len(swipes),1)



if __name__ == '__main__':
    unittest.main()
