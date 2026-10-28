/**
 * test/tieba.test.mjs —— lib/html.mjs + lib/tieba.mjs 的离线单测
 * ============================================================================
 * **不联网**：所有 HTML 片段都是 2026-11 从真实贴吧页面上剪下来内联在这里的，
 * 跑单测不会再打 tieba.baidu.com（既快又不会招风控）。
 * 覆盖：实体解码 / 标签剥离 / <br> / 截断 4000 / 数字 / URL 拼装 / 列表解析 /
 *       正文楼层解析 / 楼中楼解析 / 噪声清洗 / 错误翻译 / 凭证读写。
 * 跑法：node --test test/
 * ============================================================================
 */

// ──────── 以下是真实页面片段（别手改：改了就失去回归意义）────────
// 自动生成：从 2026-11 实测的贴吧页面剪下来的固定片段（单测用，不联网）
const LIST_LI = `<li class="tl_shadow tl_shadow_new " data-tid="10000000001" data-tasktype="" data-floor="1" data-thread-type="0">            <div class="ti_infos clearfix" data-tid=""><div class="ti_avatar"  data-tid="" data-url="/home/main?un=%E4%BD%90%E8%97%A4%E4%BC%8A%E8%83%BD">            <img src="https://gss0.bdstatic.com/6LZ1dD3d1sgCo2Kml5_Y_D3/sys/portrait/item/tb.1.2fa36325.srWdPWm6scFzjAdAZAgR4w?t=1762770040" alt="">            </div><div class="ti_author_time" data-tid="" data-url="/home/main?un=%E4%BD%90%E8%97%A4%E4%BC%8A%E8%83%BD"><div class="ti_author_icons  clearfix">            <span class="ti_author">        测试用户甲</span>            </div><span class="ti_time">20:43</span></div>        </div><a href="/p/10000000001?lp=5028&amp;mo_device=1&amp;is_jingpost=0"  class="j_common ti_item " data-thread-type="0" data-floor="1" tid="10000000001" data-tasktype="" data-tid="10000000001"><div class="ti_title">                <span>给原神的人物角色颜值打分</span></div>                <div class="medias_wrap ordinary_thread clearfix">                        <div class="medias_one_pic">                            <img class="j_media_thumb_holder medias_img medias_thumb_holder"                                src="//tb2.bdstatic.com/tb/mobile/sfrs/widget/frslist_content/img/frs_pic_loading_big_b606189.png"                                data-url="https://tiebapic.baidu.com/forum/crop%3D0%2C0%2C1272%2C1272%3Bw%3D980/sign=6d3464c57f01213fdb7c149c69d71ae1/e4dde71190ef76c647cbab37db16fdfaaf516795.jpg?tbpicau=2026-11-08-05_f604112cb6acef2de8f065f4b94b0b23"                                data-canclick="1"                                link="/mo/q/album?word=%E5%8E%9F%E7%A5%9E&tid=10000000001&template=slide_image&title=%E7%BB%99%E5%8E%9F%E7%A5%9E%E7%9A%84%E4%BA%BA%E7%89%A9%E8%A7%92%E8%89%B2%E9%A2%9C%E5%80%BC%E6%89%93%E5%88%86&album_from=frs_abstract&direction=2&pic_id=" />                            </div>                                                </div>                                            <div class="ti_zan_reply clearfix">               <div class="ti_func_btn btn_reply"><span class="btn_icon">7615</span></div>               </div>        </a></li>`

const LIST_TOP_LI = `<li class="tl_top scale-1px-bottom" data-tid="10000000002" data-floor="0" data-thread-type="0"><a href="/p/10000000002?lp=5028&amp;mo_device=1&amp;is_jingpost=1" data-thread-type="0" class="j_common ti_item no_border top" data-floor="0" tid="10000000002" data-tid="10000000002" tasktype=""><div class="ti_title">            <span class="ti_title_icon ti_icon_zhiding">置顶</span>            <span>国庆活动进度盘点，分享你的收获</span></div></a></li>`

const LIST_THREADS_JSON = `[{"id":10000000002,"tid":10000000002,"title":"国庆活动进度盘点，分享你的收获","reply_num":52,"view_num":8497,"create_time":1790593625,"last_time":"10-23","last_time_int":1792693796,"thread_types":1043,"is_multi_forum":0,"is_top":1,"is_good":1,"is_vote":0,"is_bakan":0,"is_protal":0,"is_voice_thread":0,"is_activity":0,"is_klose_top":0,"is_bazhu_task":0,"is_bazhu_mask":0,"is_bazhu_recruit":0,"is_bazhu_vote":0,"is_bazhu_publicity":0,"zan":[],"first_post_id":153978766891,"is_notice":0,"location":null,"author":{"name":"崩坏学园总策划","type":2,"name_show":"贴吧用户_7QC47SV","mParr_props":{"all_level":{"1":{"end_time":"1482734621","level":1,"pic_url":"http://imgsrc.baidu.com/forum/pic/item/964edcc451da81cb906345a65066d016082431f0.jpg","score_limit":8000},"2":{"end_time":"1799718223","level":2,"pic_url":"http://imgsrc.baidu.com/forum/pic/item/6afa80cb39dbb6fdf9de234d0b24ab18962b37f0.jpg","score_limit":8000}},"level":{"end_time":"1799718223","pic_url":"http://imgsrc.baidu.com/forum/pic/item/6afa80cb39dbb6fdf9de234d0b24ab18962b37f0.jpg","props_id":2},"portrait":{"end_time":"2196545618","props_id":"1090130","url":"http://c.hiphotos.baidu.com/forum/eWH=150,150;bp=1090130,0,0,200/sign=172d959c34f33a878c077d17f7692014/5bafa40f4bfbfbed697020d376f0f736afc31f74.jpg"}},"vipInfo":{"a_score":"100","e_time":"1799718223","ext_score":"228600","icon_url":"http://tb1.bdstatic.com/tb/cms/icon_crown_year_v5.png","icon_url_new":"https://tieba-ares.cdn.bcebos.com/mis/2023-7/1689061482682/13afea50121d.png","n_score":39000,"s_time":"1700582400","v_level":5,"v_status":"3","y_score":1000},"portrait":"tb.1.6bcd371e.WNjnlZOtkSh0a3LIfwFVEA?t=1495418313","id":2213840917,"is_verify":true,"is_interestman":0,"is_bawu":1,"show_nickname":"崩坏学园总策划","new_iconinfo":{"1":[],"2":[],"3":{"category_id":102,"end_time":"4294967295","forum_list":"","icon":"http://imgsrc.baidu.com/forum/pic/item/4e4a20a4462309f70a1a389d700e0cf3d6cad6cc.png","intro":"获取规则：在星座勋章馆中获得。","intro_url":"http://tieba.baidu.com/f?ie=utf-8&amp;kw=%E8%9B%87%E5%A4%AB%E5%BA%A7&amp;fr=search","is_advanced":0,"is_force":0,"level":"1","level_1":{"icon_1":"http://imgsrc.baidu.com/forum/pic/item/0ff41bd5ad6eddc464a621743bdbb6fd536633ff.png","icon_2":"http://imgsrc.baidu.com/forum/pic/item/6c224f4a20a4462390bf30ed9a22720e0df3d7cc.png","icon_3":"http://imgsrc.baidu.com/forum/pic/item/4e4a20a4462309f70a1a389d700e0cf3d6cad6cc.png","icon_4":"http://imgsrc.baidu.com/forum/pic/item/1ad5ad6eddc451dab7b79964b4fd5266d11632ff.png","icon_5":"http://imgsrc.baidu.com/forum/pic/item/dcc451da81cb39db8e81f2d9d2160924aa1830ff.png","icon_6":"http://imgsrc.baidu.com/forum/pic/item/ac6eddc451da81cb0ea716425066d016082431ff.png","level_info":{"forum_list":"","intro":"获取规则：在星座勋章馆中获得。","intro_url":"http://tieba.baidu.com/f?ie=utf-8&amp;kw=%E8%9B%87%E5%A4%AB%E5%BA%A7&amp;fr=search","pay_pic_pad":"","pay_pic_pc":"","title":"水瓶座印记","title_url":"http://tieba.baidu.com/f?ie=utf-8&amp;kw=%E8%9B%87%E5%A4%AB%E5%BA%A7&amp;fr=search"}},"name":"shuiping","pay_pic_pad":"","pay_pic_pc":"","position":{"card":1,"frs":1,"home":1,"pb":1},"price":0,"slot_no":"3","slot_type":"0","sprite":{"1":"1793126772,0"},"terminal":{"client":1,"pc":1,"wap":1},"title":"水瓶座印记","title_url":"http://tieba.baidu.com/f?ie=utf-8&amp;kw=%E8%9B%87%E5%A4%AB%E5%BA%A7&amp;fr=search","type":2,"value":"1","weight":1},"4":{"category_id":107,"end_time":"4294967295","forum_list":"","icon":"https://tieba-ares.cdn.bcebos.com/mis/2025-6/1748918532159/dd345ef3ab7d.png","intro":"6月累计活跃15天","intro_url":"https://tieba.baidu.com/mo/q/hybrid-main-user/taskCenter?customfullscreen=1&amp;nonavigationbar=1&amp;fr=icon","is_advanced":0,"is_force":0,"level":"1","level_1":{"icon_1":"https://tieba-ares.cdn.bcebos.com/mis/2025-6/1748918537792/f2b0d72f8e7d.png","icon_2":"https://tieba-ares.cdn.bcebos.com/mis/2025-6/1748918534822/b64740bde842.png","icon_3":"https://tieba-ares.cdn.bcebos.com/mis/2025-6/1748918532159/dd345ef3ab7d.png","icon_4":"https://tieba-ares.cdn.bcebos.com/mis/2025-6/1748918545550/d29f1cd6aaca.png","icon_5":"https://tieba-ares.cdn.bcebos.com/mis/2025-6/1748918541696/449f3c9a303a.png","icon_6":"https://tieba-ares.cdn.bcebos.com/mis/2025-6/1748918548228/74ace14851a3.png","level_info":{"forum_list":"","intro":"6月累计活跃15天","intro_url":"https://tieba.baidu.com/mo/q/hybrid-main-user/taskCenter?customfullscreen=1&amp;nonavigationbar=1&amp;fr=icon","pay_pic_pad":"","pay_pic_pc":"","title":"6月活跃挑战赛","title_url":"https://tieba.baidu.com/mo/q/hybrid-main-user/taskCenter?customfullscreen=1&amp;nonavigationbar=1&amp;fr=icon"}},"name":"June25_icon","pay_pic_pad":"","pay_pic_pc":"","position":{"card":1,"frs":1,"home":1,"pb":1},"price":0,"slot_no":"4","slot_type":"0","sprite":{"1":"1793126772,"},"terminal":{"client":1,"pc":1,"wap":1},"title":"6月活跃挑战赛","title_url":"https://tieba.baidu.com/mo/q/hybrid-main-user/taskCenter?customfullscreen=1&amp;nonavigationbar=1&amp;fr=icon","type":4,"value":"1","weight":1}},"iconinfo":[{"icon":"http://imgsrc.baidu.com/forum/pic/item/79f0f736afc37931bce2f312e8c4b74543a91106.png","name":"is_verify","position":{"frs":1,"pb":1,"home":1,"card":1},"sprite":{"1":"1793126772,24"},"terminal":{"pc":1,"wap":1,"client":1},"value":2,"weight":1},{"icon":"http://imgsrc.baidu.com/forum/pic/item/fcfaaf51f3deb48f6684322df21f3a292cf57850.png","name":"is_coreuser","position":{"frs":1,"pb":1,"home":1,"card":1},"sprite":{"1":"1793126772,39"},"terminal":{"pc":1,"wap":1,"client":1},"value":2,"weight":500},{"icon":"http://imgsrc.baidu.com/forum/pic/item/9345d688d43f879429723d15d11b0ef41bd53a7f.png","name":"user_type","position":{"frs":1,"pb":1,"home":1,"card":1},"sprite":{"1":"1793126772,25"},"terminal":{"pc":1,"wap":1,"client":1},"value":1,"weight":999}],"tshow_icon":[{"icon":"http://imgsrc.baidu.com/forum/pic/item/6afa80cb39dbb6fdf9de234d0b24ab18962b37f0.jpg","name":"t_show","url":""}]},"last_replyer":{"name":"地狱王子罗德","type":1,"name_show":"地狱王子罗德","id":6912761837,"is_verify":false},"comment_num":0,"share_num":4,"abstract":"各位旅行者，最近肝得怎么样？活动奖励拿满了吗？贴吧「国庆回血计划」现已开启，活动时间为9月28日-10月20日。新图探索、剧情体验、抽卡结果、整活玩法都能分享，还有机会拿奖励。 参与规则：发贴从以下4个活动话题中任选1个带上，内容对应话题方向，即可视为有效参与： 1、#在路上充电#：出游行程、避坑指南、小众目的地、穷游/徒步/摩旅攻略。 2、#在热爱里充电#：游戏战绩、追番追剧、健身打卡、手工创作等各类爱好日常。 3、#在奋斗里","media":[{"type":"pic","size":"748007","width":"560","height":"661","water_pic":"http://tiebapic.baidu.com/forum/w%3D580%3B/sign=a429f77e971373f0f53f6f9794344afb/b21c8701a18b87d65215c41a410828381f30fd64.jpg?tbpicau=2026-11-08-05_cf7017cd2218727c9bb0d8368c9b5d4c","small_pic":"http://tiebapic.baidu.com/forum/crop%3D0%2C0%2C1084%2C1084%3Bw%3D210%3Bq%3D100%3Bg%3D0/sign=64b5f3d9cc13632701a29873acbf8cdc/b21c8701a18b87d65215c41a410828381f30fd64.jpg?tbpicau=2026-11-08-05_a1b0789554e2213b4f9b8a57cb94866b","big_pic":"http://tiebapic.baidu.com/forum/crop%3D0%2C0%2C1084%2C1084%3Bw%3D980/sign=836929b8ef773912d069df21c529aa28/b21c8701a18b87d65215c41a410828381f30fd64.jpg?tbpicau=2026-11-08-05_c1020d994430d0dd2021a19994cf0574"}],"brand_fid_copy":null,"media_num":1,"thread_type":0,"voice_info":[],"video_info":[],"agree":{"agree_num":65,"has_agree":0},"is_ntitle":0,"thumbnail_centre_point":{"tag_2":[{"center_multi":[0.5,0.4234375],"center_single":[0.5,0.4234375],"height":1084,"pic_id":"301542828661","src_image_height":1280,"src_image_width":1084,"start_x":0,"start_y":0,"width":1084}]},"top_agree_post":[],"swan_t_share_image":"http://tiebapic.baidu.com/forum/pic/item/a1ec08fa513d2697e6a6105b13fbb2fb4316d8bb.jpg?tbpicau=2026-11-08-05_fb57369ea18f48c4ffc58910c355bf8f","ala_info":null,"is_ala_live_video":false,"is_ala_share_thread":false,"origin_thread_info":null,"has_original_content":0,"is_ugc_share":0,"ori_ugc_info":null,"agree_num":65,"act_info":[],"act_media":[]},{"id":10000000001,"tid":10000000001,"title":"给原神的人物角色颜值打分","reply_num":7615,"view_num":292037,"create_time":1771265436,"last_time":"10-28","last_time_int":1793191410,"thread_types":1040,"is_multi_forum":0,"is_top":0,"is_good":0,"is_vote":0,"is_bakan":0,"is_protal":0,"is_voice_thread":0,"is_activity":0,"is_klose_top":0,"is_bazhu_task":0,"is_bazhu_mask":0,"is_bazhu_recruit":0,"is_bazhu_vote":0,"is_bazhu_publicity":0,"zan":[],"first_post_id":153208732138,"is_notice":0,"location":null,"author":{"name":"佐藤伊能","type":1,"name_show":"测试用户甲","mParr_props":{"all_level":{"2":{"end_time":"1773764526","level":2,"pic_url":"http://imgsrc.baidu.com/forum/pic/item/6afa80cb39dbb6fdf9de234d0b24ab18962b37f0.jpg","score_limit":8000}},"level":{"end_time":"1773764526","pic_url":"http://imgsrc.baidu.com/forum/pic/item/6afa80cb39dbb6fdf9de234d0b24ab18962b37f0.jpg","props_id":2}},"vipInfo":{"a_score":-50,"e_time":"1773764526","ext_score":"200","icon_url":"http://tb1.bdstatic.com/tb/cms/icon_crown_super_non1.png","icon_url_new":"https://tieba-ares.cdn.bcebos.com/mis/2023-7/1689061483501/5ca1ea248b0e.png","n_score":"2600","s_time":"1773763200","v_level":"1","v_status":"0"},"portrait":"tb.1.2fa36325.srWdPWm6scFzjAdAZAgR4w?t=1762770040","id":6384124506,"is_verify":false,"is_interestman":0,"is_bawu":0,"show_nickname":"海猫络合物","new_iconinfo":{"1":{"category_id":104,"end_time":"1772035200","forum_list":"","icon":"http://tb1.bdstatic.com/tb/cms/com/icon/file_1461120125568.png","intro":"手机端连续签到7天可获得本印记","intro_url":"http://tieba.baidu.com/mo/q/medal","is_advanced":0,"is_force":0,"level":"3","level_1":{"icon_1":"http://tb1.bdstatic.com/tb/cms/com/icon/file_1461120129311.png","icon_2":"http://tb1.bdstatic.com/tb/cms/com/icon/file_1461120127398.png","icon_3":"http://tb1.bdstatic.com/tb/cms/com/icon/file_1461120125568.png","icon_4":"http://tb1.bdstatic.com/tb/cms/com/icon/file_1461120133253.png","icon_5":"http://tb1.bdstatic.com/tb/cms/com/icon/file_1461120131365.png","icon_6":"http://tb1.bdstatic.com/tb/cms/com/icon/file_1461120134989.png","level_info":{"forum_list":"","intro":"手机端连续签到7天可获得本印记","intro_url":"http://tieba.baidu.com/mo/q/medal","pay_pic_pad":"","pay_pic_pc":"","title":"初级核心用户","title_url":"http://tieba.baidu.com/mo/q/medal"}},"level_2":{"icon_1":"http://tb1.bdstatic.com/tb/cms/com/icon/file_1461120158133.png","icon_2":"http://tb1.bdstatic.com/tb/cms/com/icon/file_1461120156578.png","icon_3":"http://tb1.bdstatic.com/tb/cms/com/icon/file_1461120154957.png","icon_4":"http://tb1.bdstatic.com/tb/cms/com/icon/file_1461120161806.png","icon_5":"http://tb1.bdstatic.com/tb/cms/com/icon/file_1461120159955.png","icon_6":"http://tb1.bdstatic.com/tb/cms/com/icon/file_1461120163634.png","level_info":{"forum_list":"","intro":"手机端连续签到30天可获得本印记","intro_url":"http://tieba.baidu.com/mo/q/medal","pay_pic_pad":"","pay_pic_pc":"","title":"中级核心用户","title_url":"http://tieba.baidu.com/mo/q/medal"}},"level_3":{"icon_1":"http://tb1.bdstatic.com/tb/cms/com/icon/file_1461120185989.png","icon_2":"http://tb1.bdstatic.com/tb/cms/com/icon/file_1461120183110.png","icon_3":"http://tb1.bdstatic.com/tb/cms/com/icon/file_1461120181163.png","icon_4":"http://tb1.bdstatic.com/tb/cms/com/icon/file_1461120189864.png","icon_5":"http://tb1.bdstatic.com/tb/cms/com/icon/file_1461120187522.png","icon_6":"http://tb1.bdstatic.com/tb/cms/com/icon/file_1461120192434.png","level_info":{"forum_list":"","intro":"手机端连续签到90天可获得本印记","intro_url":"http://tieba.baidu.com/mo/q/medal","pay_pic_pad":"","pay_pic_pc":"","title":"高级核心用户","title_url":"http://tieba.baidu.com/mo/q/medal"}},"name":"signprize","pay_pic_pad":"","pay_pic_pc":"","position":{"card":1,"frs":1,"home":1,"pb":1},"price":0,"slot_no":"1","slot_type":"0","sprite":{"1":"1793126772,94","2":"1793126772,95","3":"1793126772,96"},"terminal":{"client":1,"pc":1,"wap":1},"title":"初级核心用户","title_url":"http://tieba.baidu.com/mo/q/medal","type":2,"value":"1","weight":1}},"iconinfo":[],"tshow_icon":[]},"last_replyer":{"name":"","type":1,"name_show":"","id":1720398054,"is_verify":false},"comment_num":0,"share_num":72,"abstract":"10 神夯了 9 夯 8 这颜值无敌了 7 神中神 6 顶级 5 太好看了 4 人上人 3 NPC 2 一般 1 拉完了 ","media":[{"type":"pic","size":"161354","width":"560","height":"888","water_pic":"http://tiebapic.baidu.com/forum/w%3D580%3B/sign=f01c366fbdf2b211e42e8546fabb6438/e4dde71190ef76c647cbab37db16fdfaaf516795.jpg?tbpicau=2026-11-08-05_ac15d2e8b4b2509305798ff15c53aedf","small_pic":"http://tiebapic.baidu.com/forum/crop%3D0%2C0%2C1272%2C1272%3Bw%3D210%3Bq%3D100%3Bg%3D0/sign=befbe89d8d1349546a51b2246b7ebe68/e4dde71190ef76c647cbab37db16fdfaaf516795.jpg?tbpicau=2026-11-08-05_0ebcf399cef9f8e85e87020a4c359ee4","big_pic":"http://tiebapic.baidu.com/forum/crop%3D0%2C0%2C1272%2C1272%3Bw%3D980/sign=6d3464c57f01213fdb7c149c69d71ae1/e4dde71190ef76c647cbab37db16fdfaaf516795.jpg?tbpicau=2026-11-08-05_f604112cb6acef2de8f065f4b94b0b23"}],"brand_fid_copy":null,"media_num":1,"thread_type":0,"voice_info":[],"video_info":[],"agree":{"agree_num":12611,"has_agree":0},"is_ntitle":0,"thumbnail_centre_point":{"tag_2":[{"center_multi":[0.5,0.31516352824579],"center_single":[0.5,0.31516352824579],"height":1272,"pic_id":"301392536800","src_image_height":2018,"src_image_width":1272,"start_x":0,"start_y":0,"width":1272}]},"top_agree_post":[],"swan_t_share_image":"http://tiebapic.baidu.com/forum/pic/item/a71ea8d3fd1f41345b1d927f631f95cad1c85e8d.jpg?tbpicau=2026-11-08-05_988afc9f5c725953437431194e465831","ala_info":null,"is_ala_live_video":false,"is_ala_share_thread":false,"origin_thread_info":null,"has_original_content":0,"is_ugc_share":0,"ori_ugc_info":null,"agree_num":12611,"act_info":[],"act_media":[]},{"id":11145608123,"tid":11145608123,"title":"我服了啊，这能用吗","reply_num":3,"view_num":28,"create_time":1793190677,"last_time":"10-28","last_time_int":1793191402,"thread_types":1040,"is_multi_forum":0,"is_top":0,"is_good":0,"is_vote":0,"is_bakan":0,"is_protal":0,"is_voice_thread":0,"is_activity":0,"is_klose_top":0,"is_bazhu_task":0,"is_bazhu_mask":0,"is_bazhu_recruit":0,"is_bazhu_vote":0,"is_bazhu_publicity":0,"zan":[],"first_post_id":154081438938,"is_notice":0,"location":null,"author":{"name":"编辑","type":1,"name_show":"编辑","mParr_props":{"all_level":{"2":{"end_time":"1717773460","level":2,"pic_url":"http://imgsrc.baidu.com/forum/pic/item/6afa80cb39dbb6fdf9de234d0b24ab18962b37f0.jpg","score_limit":8000}},"level":{"end_time":"1717773460","pic_url":"http://imgsrc.baidu.com/forum/pic/item/6afa80cb39dbb6fdf9de234d0b24ab18962b37f0.jpg","props_id":2}},"vipInfo":{"a_score":"100","e_time":"1717773460","ext_score":"144920","icon_url":"http://tb1.bdstatic.com/tb/cms/icon_crown_super_v5.png","icon_url_new":"https://tieba-ares.cdn.bcebos.com/mis/2023-7/1689061482682/13afea50121d.png","n_score":39000,"s_time":"1717084800","v_level":5,"v_status":"2","y_score":1000},"portrait":"tb.1.31103897.VFU02ezSjliD3le63uufbw?t=1743868765","id":69629,"is_verify":false,"is_interestman":0,"is_bawu":0,"show_nickname":"编辑","new_iconinfo":{"1":{"category_id":102,"end_time":"1735660800","forum_list":"","icon":"http://imgsrc.baidu.com/forum/pic/item/7c1ed21b0ef41bd5999c427b53da81cb38db3d75.png","intro":"获取规则：在星座勋章馆中获得。","intro_url":"http://tieba.baidu.com/f?ie=utf-8&amp;kw=%E8%9B%87%E5%A4%AB%E5%BA%A7&amp;fr=search","is_advanced":0,"is_force":0,"level":"1","level_1":{"icon_1":"http://imgsrc.baidu.com/forum/pic/item/d1160924ab18972bebdaaa45e4cd7b899f510a58.png","icon_2":"http://imgsrc.baidu.com/forum/pic/item/aa18972bd40735faa710e4369c510fb30e240858.png","icon_3":"http://imgsrc.baidu.com/forum/pic/item/7c1ed21b0ef41bd5999c427b53da81cb38db3d75.png","icon_4":"http://imgsrc.baidu.com/forum/pic/item/962bd40735fae6cd395401ee0db30f2443a70f58.png","icon_5":"http://imgsrc.baidu.com/forum/pic/item/d31b0ef41bd5ad6ee836ce6583cb39dbb7fd3c75.png","icon_6":"http://imgsrc.baidu.com/forum/pic/item/1ad5ad6eddc451dab639a664b4fd5266d1163275.png","level_info":{"forum_list":"","intro":"获取规则：在星座勋章馆中获得。","intro_url":"http://tieba.baidu.com/f?ie=utf-8&amp;kw=%E8%9B%87%E5%A4%AB%E5%BA%A7&amp;fr=search","pay_pic_pad":"","pay_pic_pc":"","title":"巨蟹座印记","title_url":"http://tieba.baidu.com/f?ie=utf-8&amp;kw=%E8%9B%87%E5%A4%AB%E5%BA%A7&amp;fr=search"}},"name":"juxie","pay_pic_pad":"","pay_pic_pc":"","position":{"card":1,"frs":1,"home":1,"pb":1},"price":0,"slot_no":"1","slot_type":"0","sprite":{"1":"1793126772,20"},"terminal":{"client":1,"pc":1,"wap":1},"title":"巨蟹座印记","title_url":"http://tieba.baidu.com/f?ie=utf-8&amp;kw=%E8%9B%87%E5%A4%AB%E5%BA%A7&amp;fr=search","type":2,"value":"1","weight":1}},"iconinfo":[],"tshow_icon":[]},"last_replyer":{"name":"编辑","type":1,"name_show":"编辑","id":69629,"is_verify":false},"comment_num":0,"share_num":0,"abstract":"本来看防御没歪起飞，结果4次大公鸡 ","media":[{"type":"pic","size":"1083498","width":"560","height":"254","water_pic":"http://tiebapic.baidu.com/forum/w%3D580%3B/sign=98e6283d764e251fe2f7e4f097bdc817/b7fd5266d016092472ca281c920735fae7cd34ce.jpg?tbpicau=2026-11-08-05_713ed145956b5f7b9174acb7531d2ece","small_pic":"http://tiebapic.baidu.com/forum/crop%3D265%2C0%2C1256%2C1256%3Bw%3D210%3Bq%3D100%3Bg%3D0/sign=53c1dc1024d0f703f2fdcf9c35c86708/b7fd5266d016092472ca281c920735fae7cd34ce.jpg?tbpicau=2026-11-08-05_60b7ce40df157e2d5b016bac1874e751","big_pic":"http://tiebapic.baidu.com/forum/crop%3D0%2C0%2C2512%2C1256%3Bw%3D960/sign=25d12d729088d43fe4e6cbb2402efe2b/b7fd5266d016092472ca281c920735fae7cd34ce.jpg?tbpicau=2026-11-08-05_ae3d30976596f1805b5382b685465cbc"}],"brand_fid_copy":null,"media_num":1,"thread_type":0,"voice_info":[],"video_info":[],"agree":{"agree_num":0,"has_agree":0},"is_ntitle":0,"thumbnail_centre_point":{"tag_2":[{"center_multi":[0.32391304347826,0.5],"center_single":[0.32391304347826,0.5],"height":1256,"pic_id":"301583028953","src_image_height":1256,"src_image_width":2760,"start_x":266,"start_y":0,"width":1256}]},"top_agree_post":[],"swan_t_share_image":null,"ala_info":null,"is_ala_live_video":false,"is_ala_share_thread":false,"origin_thread_info":null,"has_original_content":0,"is_ugc_share":0,"ori_ugc_info":null,"agree_num":0,"act_info":[],"act_media":[]}]`

const FLOOR_1 = `<li tid="10000000003" data-tid="10000000003" fn="1"    data-info="{&quot;un&quot;:&quot;\\u6d4b\\u8bd5\\u7528\\u6237\\u4e19&quot;,&quot;is_annoy&quot;:0,&quot;pid&quot;:10000000003,&quot;floor_num&quot;:1,&quot;name_show&quot;:&quot;\\u8d34\\u5427\\u7528\\u6237_5XWJMbS&quot;,&quot;portrait&quot;:&quot;tb.1.164cbb79.vNVAhKiRbkuCYPg_RAQ_kA?t=1770703687&quot;}"    class="list_item post_list_item default_feedback j_post_list_item    no_border"is_inner_floor=''><div class="list_item_wrapper"><div class="list_main">        <div class="post_title_embed">话说木偶一命到底有啥用    </div><div class="list_item_top clearfix"><div class="list_item_user_wrap"><div class="list_item_top_avatar">                    <a href="javascript:;"><span><img src="http://gss3.bdstatic.com/84oSdTum2Q5BphGlnYG/timg?mowebapp&amp;quality=80&amp;size=b72_72&amp;cut_x=0&amp;cut_w=0&amp;cut_y=0&amp;cut_h=0&amp;sec=1369815402&amp;di=f76fa776d5d2dd4f61e5143a4c30df2e&amp;wh_rate=null&amp;src=http%3A%2F%2Ftb.himg.baidu.com%2Fsys%2Fportrait%2Fitem%2Ftb.1.164cbb79.vNVAhKiRbkuCYPg_RAQ_kA%3Ft%3D1770703687.jpg" alt="头像" width="36" height="36" class="user_img"></span></a></div><div class="list_item_top_name">                    <span class="user_name"><a href="javascript:;" class="user_name">测试用户乙</a></span>                        <span                                class="level level_10">10</span>                                                                                                <br/><span class="list_item_time">10-27 14:59</span></div></div><div class="list_item_more_operation">                <span class="poster_only">只看楼主</span>                </div>            <div class="content"                 lz="1">                               喷长一点有啥用？dps又不提高，就30赠伤?                </div>                    <div class="operate_statistic_wrapper"><div class="ti_func_btn btn_reply"><span class="btn_icon">48</span></div><div class="ti_func_btn btn_collect"><span class="btn_icon"></span></div></div>        </div></div></li>`

const FLOOR_4 = `<li tid="10000000004" data-tid="10000000004" fn="6"    data-info="{&quot;un&quot;:&quot;\\u6d4b\\u8bd5\\u7528\\u6237\\u4e01&quot;,&quot;is_annoy&quot;:0,&quot;pid&quot;:10000000004,&quot;floor_num&quot;:6,&quot;name_show&quot;:&quot;\\u6d4b\\u8bd5\\u7528\\u6237\\u4e01&quot;,&quot;portrait&quot;:&quot;tb.1.d66dfd14.JfN0yrJBD1MPG6vAYlHPhQ&quot;}"    class="list_item post_list_item default_feedback j_post_list_item class_hide_flag   "is_inner_floor=''><div class="list_item_wrapper"><div class="list_main">        <div class="list_item_top clearfix"><div class="list_item_user_wrap"><div class="list_item_top_avatar">                    <a href="javascript:;"><span><img src="http://gss3.bdstatic.com/84oSdTum2Q5BphGlnYG/timg?mowebapp&amp;quality=80&amp;size=b72_72&amp;cut_x=0&amp;cut_w=0&amp;cut_y=0&amp;cut_h=0&amp;sec=1369815402&amp;di=41e8ccc3d7b38480a87d9327552777d1&amp;wh_rate=null&amp;src=http%3A%2F%2Ftb.himg.baidu.com%2Fsys%2Fportrait%2Fitem%2Ftb.1.d66dfd14.JfN0yrJBD1MPG6vAYlHPhQ.jpg" alt="头像" width="36" height="36" class="user_img"></span></a></div><div class="list_item_top_name">                    <span class="user_name"><a href="javascript:;" class="user_name">许沐沐灬</a></span>                        <span                                class="level level_8">8</span>                                                                                                <br/><span class="list_item_time">10-27 16:08</span></div></div><div class="list_item_more_operation">                <a href="javascript:;"                   class="list_item_more_operation_btn j_list_item_more_operation_btn icon_btn">操作</a><div class="list_item_operation j_list_item_operation clearfix">                                            <a href="javascript:;"                        class="op-btn bookmark_icon j_floor_num ">收藏</a>                        <a href="javascript:;" class="j_nreply_btn op-btn reply_icon">回复</a>                                                                                                        <a href="/mo/q/postreport?fid=3193775&tid=11141821521&pid=10000000004"                           class="j_report_btn report_icon op-btn">举报</a>                    </div>                </div>            <div class="content"                 lz="0">                               喷久一点就是输出舒适度更高点，另外30%星烁反应伤害是全队触发 ，只要队伍是4c 提升还算过得去                </div>            <div class="fr_list 6 j_floor_panel" data-list-count="5">                <ul class="flist">                        <li pid="20000000001" data-info='{"pid":20000000001,"un":"发光体LED"}' class="list_item_floor j_list_item_floor"><div class="fmain j_floor_main"><div class="floor_footer_item"><a href="/home/main?un=发光体LED" class="user_name ">正人君子<img src="//tb1.bdstatic.com/tb/cms/nickemoji/1-29.png" class="nicknameEmoji" style="width:13px;height:13px; vertical-align: middle;"/>:</a><span class="floor_content">                                没必要4c，即使3拐1伤害全在主c手里30增伤也是全队提升</span>                                    </div></div></li><li pid="20000000002" data-info='{"pid":20000000002,"un":""}' class="list_item_floor j_list_item_floor"><div class="fmain j_floor_main"><div class="floor_footer_item"><a href="/home/main?un=" class="user_name ">神箭游侠<img src="//tb1.bdstatic.com/tb/cms/nickemoji/3-30.png" class="nicknameEmoji" style="width:13px;height:13px; vertical-align: middle;"/>:</a><span class="floor_content">                                回复 <a href="/home/main?un= 光明丨磊落"> 光明丨磊落</a> :四c才能体现出价值，不然和前台增伤有啥区别</span>                                    </div></div></li></ul>                                                                    <span class="pb_floow_load lzl_cut_more_btn j_enter_lzl_daoliu">打开APP查看3条评论</span>                                                            </div>                </div></div></li>`

const LZL_HTML = `<li class="lzl_single_post j_lzl_s_p first_no_border" data-field='{&quot;spid&quot;:20000000001,&quot;showname&quot;:&quot;\\u5149\\u660e\\u4e28\\u78ca\\u843d&quot;,&quot;user_name&quot;:&quot;\\u6d4b\\u8bd5\\u7528\\u6237\\u620a&quot;,&quot;portrait&quot;:&quot;tb.1.fdfd39e7.17xlOd0iMBRoLCL-FowKzA&quot;}' ><a rel="noopener" name="20000000001"></a>  <a rel="noopener" data-field='{&quot;un&quot;:&quot;\\u6d4b\\u8bd5\\u7528\\u6237\\u620a&quot;,&quot;id&quot;:&quot;tb.1.fdfd39e7.17xlOd0iMBRoLCL-FowKzA&quot;}' target="_blank" class="j_user_card lzl_p_p" href="/home/main?id=tb.1.fdfd39e7.17xlOd0iMBRoLCL-FowKzA&fr=pb" username="发光体LED"><img  src="https://gss0.bdstatic.com/6LZ1dD3d1sgCo2Kml5_Y_D3/sys/portrait/item/tb.1.fdfd39e7.17xlOd0iMBRoLCL-FowKzA"/></a><div class="lzl_cnt" data-field='{&quot;iconArr&quot;:{&quot;all_level&quot;:{&quot;2&quot;:{&quot;end_time&quot;:&quot;1772722291&quot;,&quot;level&quot;:2,&quot;pic_url&quot;:&quot;http:\\/\\/imgsrc.baidu.com\\/forum\\/pic\\/item\\/6afa80cb39dbb6fdf9de234d0b24ab18962b37f0.jpg&quot;,&quot;score_limit&quot;:8000}},&quot;level&quot;:{&quot;end_time&quot;:&quot;1772722291&quot;,&quot;pic_url&quot;:&quot;http:\\/\\/imgsrc.baidu.com\\/forum\\/pic\\/item\\/6afa80cb39dbb6fdf9de234d0b24ab18962b37f0.jpg&quot;,&quot;props_id&quot;:2}},&quot;free_flag&quot;:null}'><a rel="noopener" class="at j_user_card " data-field='{&quot;un&quot;:&quot;\\u6d4b\\u8bd5\\u7528\\u6237\\u620a&quot;,&quot;id&quot;:&quot;tb.1.fdfd39e7.17xlOd0iMBRoLCL-FowKzA&quot;}' href="/home/main?id=tb.1.fdfd39e7.17xlOd0iMBRoLCL-FowKzA&ie=utf-8&fr=pb" target="_blank" username="发光体LED">光明丨磊落</a>:<span class="lzl_content_main" data-username="">        没必要4c，即使3拐1伤害全在主c手里30增伤也是全队提升        </span><div class="lzl_content_reply"><span class="lzl_jb" style="display:none;"></span><span class="lzl_op_list j_lzl_o_l" style="display:none;"></span><span class="lzl_time">2026-10-27 20:14</span><a rel="noopener" href="#" class="lzl_s_r">回复</a></div></div></li><li class="lzl_single_post j_lzl_s_p " data-field='{&quot;spid&quot;:20000000002,&quot;showname&quot;:&quot;\\u795e\\u7bad\\u6e38\\u4fa0\\ud83d\\udcab&quot;,&quot;user_name&quot;:&quot;&quot;,&quot;portrait&quot;:&quot;tb.1.92de6bff.jGjamDiCSgsoAWRYjjQNdQ&quot;}' ><a rel="noopener" name="20000000002"></a>  <a rel="noopener" data-field='{&quot;un&quot;:&quot;&quot;,&quot;id&quot;:&quot;tb.1.92de6bff.jGjamDiCSgsoAWRYjjQNdQ&quot;}' target="_blank" class="j_user_card lzl_p_p" href="/home/main?id=tb.1.92de6bff.jGjamDiCSgsoAWRYjjQNdQ&fr=pb" username=""><img  src="https://gss0.bdstatic.com/6LZ1dD3d1sgCo2Kml5_Y_D3/sys/portrait/item/tb.1.92de6bff.jGjamDiCSgsoAWRYjjQNdQ"/></a><div class="lzl_cnt" data-field='{&quot;iconArr&quot;:{&quot;all_level&quot;:{&quot;2&quot;:{&quot;end_time&quot;:&quot;1803875520&quot;,&quot;level&quot;:2,&quot;pic_url&quot;:&quot;http:\\/\\/imgsrc.baidu.com\\/forum\\/pic\\/item\\/6afa80cb39dbb6fdf9de234d0b24ab18962b37f0.jpg&quot;,&quot;score_limit&quot;:8000}},&quot;level&quot;:{&quot;end_time&quot;:&quot;1803875520&quot;,&quot;pic_url&quot;:&quot;http:\\/\\/imgsrc.baidu.com\\/forum\\/pic\\/item\\/6afa80cb39dbb6fdf9de234d0b24ab18962b37f0.jpg&quot;,&quot;props_id&quot;:2}},&quot;free_flag&quot;:null}'><a rel="noopener" class="at j_user_card " data-field='{&quot;un&quot;:&quot;&quot;,&quot;id&quot;:&quot;tb.1.92de6bff.jGjamDiCSgsoAWRYjjQNdQ&quot;}' href="/home/main?id=tb.1.92de6bff.jGjamDiCSgsoAWRYjjQNdQ&ie=utf-8&fr=pb" target="_blank" username="">神箭游侠💫</a>:<span class="lzl_content_main" data-username="">        回复 <a href="http://tieba.baidu.com/i/sys/jump?un= " onclick="Stats.sendRequest('fr=tb0_forum&st_mod=pb&st_value=atlink');" onmouseover="showattip(this)" onmouseout="hideattip(this)" username=" " portrait="tb.1.fdfd39e7.17xlOd0iMBRoLCL-FowKzA" target="_blank" class="at">光明丨磊落</a> :四c才能体现出价值，不然和前台增伤有啥区别        </span><div class="lzl_content_reply"><span class="lzl_jb" style="display:none;"></span><span class="lzl_op_list j_lzl_o_l" style="display:none;"></span><span class="lzl_time">2026-10-27 20:34</span><a rel="noopener" href="#" class="lzl_s_r">回复</a></div></div></li><li class="lzl_single_post j_lzl_s_p " data-field='{&quot;spid&quot;:154078555398,&quot;showname&quot;:&quot;\\u6d4b\\u8bd5\\u7528\\u6237\\u5df1&quot;,&quot;user_name&quot;:&quot;\\u6d4b\\u8bd5\\u7528\\u6237\\u5df1&quot;,&quot;portrait&quot;:&quot;tb.1.a1495f0e.VGsLSE4-Jt2tj0HX1Xf3nQ&quot;}' ><a rel="noopener" name="154078555398"></a>  <a rel="noopener" data-field='{&quot;un&quot;:&quot;\\u6d4b\\u8bd5\\u7528\\u6237\\u5df1&quot;,&quot;id&quot;:&quot;tb.1.a1495f0e.VGsLSE4-Jt2tj0HX1Xf3nQ&quot;}' target="_blank" class="j_user_card lzl_p_p" href="/home/main?id=tb.1.a1495f0e.VGsLSE4-Jt2tj0HX1Xf3nQ&fr=pb" username="牌魔郑逸"><img  src="https://gss0.bdstatic.com/6LZ1dD3d1sgCo2Kml5_Y_D3/sys/portrait/item/tb.1.a1495f0e.VGsLSE4-Jt2tj0HX1Xf3nQ"/></a><div class="lzl_cnt" data-field='{&quot;iconArr&quot;:[],&quot;free_flag&quot;:null}'><a rel="noopener" class="at j_user_card " data-field='{&quot;un&quot;:&quot;\\u6d4b\\u8bd5\\u7528\\u6237\\u5df1&quot;,&quot;id&quot;:&quot;tb.1.a1495f0e.VGsLSE4-Jt2tj0HX1Xf3nQ&quot;}' href="/home/main?id=tb.1.a1495f0e.VGsLSE4-Jt2tj0HX1Xf3nQ&ie=utf-8&fr=pb" target="_blank" username="牌魔郑逸">牌魔郑逸</a>:<span class="lzl_content_main" data-username="">        回复 <a href="http://tieba.baidu.com/i/sys/jump?un= " onclick="Stats.sendRequest('fr=tb0_forum&st_mod=pb&st_value=atlink');" onmouseover="showattip(this)" onmouseout="hideattip(this)" username=" " portrait="tb.1.92de6bff.jGjamDiCSgsoAWRYjjQNdQ" target="_blank" class="at">神箭游侠💫</a> :你管他几C？反正就是全队总增伤30%。这个跟队伍里有几个C没关系。        </span><div class="lzl_content_reply"><span class="lzl_jb" style="display:none;"></span><span class="lzl_op_list j_lzl_o_l" style="display:none;"></span><span class="lzl_time">2026-10-27 23:54</span><a rel="noopener" href="#" class="lzl_s_r">回复</a></div></div></li><li class="lzl_single_post j_lzl_s_p " data-field='{&quot;spid&quot;:154078580498,&quot;showname&quot;:&quot;\\u6d4b\\u8bd5\\u7528\\u6237\\u5e9a&quot;,&quot;user_name&quot;:&quot;\\u6d4b\\u8bd5\\u7528\\u6237\\u5e9a&quot;,&quot;portrait&quot;:&quot;tb.1.2d3e38df.ul8cOIT_zrQhhCo22UX5Hw&quot;}' ><a rel="noopener" name="154078580498"></a>  <a rel="noopener" data-field='{&quot;un&quot;:&quot;\\u6d4b\\u8bd5\\u7528\\u6237\\u5e9a&quot;,&quot;id&quot;:&quot;tb.1.2d3e38df.ul8cOIT_zrQhhCo22UX5Hw&quot;}' target="_blank" class="j_user_card lzl_p_p" href="/home/main?id=tb.1.2d3e38df.ul8cOIT_zrQhhCo22UX5Hw&fr=pb" username="你是真的惹不起"><img  src="https://gss0.bdstatic.com/6LZ1dD3d1sgCo2Kml5_Y_D3/sys/portrait/item/tb.1.2d3e38df.ul8cOIT_zrQhhCo22UX5Hw"/></a><div class="lzl_cnt" data-field='{&quot;iconArr&quot;:{&quot;all_level&quot;:{&quot;2&quot;:{&quot;end_time&quot;:&quot;1774664589&quot;,&quot;level&quot;:2,&quot;pic_url&quot;:&quot;http:\\/\\/imgsrc.baidu.com\\/forum\\/pic\\/item\\/6afa80cb39dbb6fdf9de234d0b24ab18962b37f0.jpg&quot;,&quot;score_limit&quot;:8000}},&quot;level&quot;:{&quot;end_time&quot;:&quot;1774664589&quot;,&quot;pic_url&quot;:&quot;http:\\/\\/imgsrc.baidu.com\\/forum\\/pic\\/item\\/6afa80cb39dbb6fdf9de234d0b24ab18962b37f0.jpg&quot;,&quot;props_id&quot;:2}},&quot;free_flag&quot;:null}'><a rel="noopener" class="at j_user_card " data-field='{&quot;un&quot;:&quot;\\u6d4b\\u8bd5\\u7528\\u6237\\u5e9a&quot;,&quot;id&quot;:&quot;tb.1.2d3e38df.ul8cOIT_zrQhhCo22UX5Hw&quot;}' href="/home/main?id=tb.1.2d3e38df.ul8cOIT_zrQhhCo22UX5Hw&ie=utf-8&fr=pb" target="_blank" username="你是真的惹不起">你是真的惹不起</a>:<span class="lzl_content_main" data-username="">        1命还好，2命之后舍不得后几段的高爆伤，然而两轮重击轴长就开始挑拐的覆盖率了        </span><div class="lzl_content_reply"><span class="lzl_jb" style="display:none;"></span><span class="lzl_op_list j_lzl_o_l" style="display:none;"></span><span class="lzl_time">2026-10-28 00:02</span><a rel="noopener" href="#" class="lzl_s_r">回复</a></div></div></li><li class="lzl_single_post j_lzl_s_p " data-field='{&quot;spid&quot;:154079339914,&quot;showname&quot;:&quot;\\u6d4b\\u8bd5\\u7528\\u6237\\u4e01&quot;,&quot;user_name&quot;:&quot;\\u6d4b\\u8bd5\\u7528\\u6237\\u4e01&quot;,&quot;portrait&quot;:&quot;tb.1.d66dfd14.JfN0yrJBD1MPG6vAYlHPhQ&quot;}' ><a rel="noopener" name="154079339914"></a>  <a rel="noopener" data-field='{&quot;un&quot;:&quot;\\u6d4b\\u8bd5\\u7528\\u6237\\u4e01&quot;,&quot;id&quot;:&quot;tb.1.d66dfd14.JfN0yrJBD1MPG6vAYlHPhQ&quot;}' target="_blank" class="j_user_card lzl_p_p" href="/home/main?id=tb.1.d66dfd14.JfN0yrJBD1MPG6vAYlHPhQ&fr=pb" username="许沐沐灬"><img  src="https://gss0.bdstatic.com/6LZ1dD3d1sgCo2Kml5_Y_D3/sys/portrait/item/tb.1.d66dfd14.JfN0yrJBD1MPG6vAYlHPhQ"/></a><div class="lzl_cnt" data-field='{&quot;iconArr&quot;:{&quot;all_level&quot;:{&quot;2&quot;:{&quot;end_time&quot;:&quot;1580958086&quot;,&quot;level&quot;:2,&quot;pic_url&quot;:&quot;http:\\/\\/imgsrc.baidu.com\\/forum\\/pic\\/item\\/6afa80cb39dbb6fdf9de234d0b24ab18962b37f0.jpg&quot;,&quot;score_limit&quot;:8000}},&quot;level&quot;:{&quot;end_time&quot;:&quot;1580958086&quot;,&quot;pic_url&quot;:&quot;http:\\/\\/imgsrc.baidu.com\\/forum\\/pic\\/item\\/6afa80cb39dbb6fdf9de234d0b24ab18962b37f0.jpg&quot;,&quot;props_id&quot;:2}},&quot;free_flag&quot;:null}'><a rel="noopener" class="at j_user_card " data-field='{&quot;un&quot;:&quot;\\u6d4b\\u8bd5\\u7528\\u6237\\u4e01&quot;,&quot;id&quot;:&quot;tb.1.d66dfd14.JfN0yrJBD1MPG6vAYlHPhQ&quot;}' href="/home/main?id=tb.1.d66dfd14.JfN0yrJBD1MPG6vAYlHPhQ&ie=utf-8&fr=pb" target="_blank" username="许沐沐灬">许沐沐灬</a>:<span class="lzl_content_main" data-username="">        回复 <a href="http://tieba.baidu.com/i/sys/jump?un= " onclick="Stats.sendRequest('fr=tb0_forum&st_mod=pb&st_value=atlink');" onmouseover="showattip(this)" onmouseout="hideattip(this)" username=" " portrait="tb.1.a1495f0e.VGsLSE4-Jt2tj0HX1Xf3nQ" target="_blank" class="at">牌魔郑逸</a> :至冬的辅多多少少带点C，如果后续真的加入达，和冰神摔炮，那这30%是很客观的数字了        </span><div class="lzl_content_reply"><span class="lzl_jb" style="display:none;"></span><span class="lzl_op_list j_lzl_o_l" style="display:none;"></span><span class="lzl_time">2026-10-28 08:46</span><a rel="noopener" href="#" class="lzl_s_r">回复</a></div></div></li><li class="lzl_li_pager j_lzl_l_p lzl_li_pager_s" data-field='{&quot;total_num&quot;:5,&quot;total_page&quot;:1}' ><a rel="noopener" class="j_lzl_p btn-sub btn-small pull-right" href="##"><i class="icon-reply"></i>我也说一句</a>  <p>&nbsp;</p>    </li>`

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  UA_DESKTOP, UA_MOBILE,
  clearCredential, ensureTbs, listThreads, loadCredential,
  postThread, readSubPosts, readThread, replyPost, replySubPost,
  saveCredential, whoami,
  __test,
} from '../lib/tieba.mjs'
import { decodeEntities, findElements, htmlToText, stripTags, toCount, truncate } from '../lib/html.mjs'

// ═══════════════════════════════════════════════════════════════════════
// 固定片段 = 2026-11 实测页面里剪下来的（不是手搓的）：
//   LIST_THREADS_JSON ← 原神吧移动列表页 <script> 里的 thread_list JSON
//   LIST_TOP_LI / LIST_LI ← 同一个列表页的两个 <li>
//   FLOOR_1 / FLOOR_4 ← 贴子 11141821521 正文页的第 1 楼 / 有楼中楼那楼
//   LZL_HTML ← /p/comment?tid=11141821521&pid=10000000004 的真实返回
// ═══════════════════════════════════════════════════════════════════════

const LIST_PAGE_JSON = `<html><head><title>原神吧_百度贴吧</title></head><body>
<span class="forum-name-txt">原神吧</span>
<p class="info_paragraph j_like_con"><span class="info_label">关注</span><span class="info_value">            285.4W</span><span class="info_label">贴子</span><span class="info_value">7040.8W</span></p>
<script>$(function(){ new tlist({ conf: { thread_list: ${LIST_THREADS_JSON} } }); });</script>
</body></html>`

const LIST_PAGE_HTML = `<span class="forum-name-txt">原神吧</span>${LIST_TOP_LI}${LIST_LI}`

const THREAD_PAGE = `<html><head><title>话说木偶一命到底有啥用</title></head><body>
<a href="/f?kw=%E5%8E%9F%E7%A5%9E&amp;mo_device=1" class="post_title_text">原神吧</a>
<ul id="pblist" class="list father_cut_list_class">${FLOOR_1}${FLOOR_4}</ul>
<script>listPageInit.init({ conf: { page: {"req_num":30,"page_size":30,"offset":0,"current_page":1,"total_page":2,"total_num":60} } });</script>
</body></html>`

// ── html.mjs ────────────────────────────────────────────────────────────

test('实体解码：命名实体 + 十进制/十六进制 + &amp; 最后解', () => {
  assert.equal(decodeEntities('&amp;&lt;&gt;&quot;&#39;&nbsp;'), '&<>"\' ')
  assert.equal(decodeEntities('&#20013;&#x6587;'), '中文')
  // 先剥标签再解实体 ⇒ 正文里写的 &lt;b&gt; 不该被当成标签删掉
  assert.equal(decodeEntities('&amp;lt;'), '&lt;')
  assert.equal(decodeEntities(''), '')
  assert.equal(decodeEntities(null), '')
})

test('正文转文本：<br> → 换行，script/style 整段丢掉', () => {
  const t = htmlToText('一<br>二<br/>三<script>var x = 1</script><style>.a{}</style>四')
  assert.match(t, /^一\n二\n三/)
  assert.ok(!t.includes('var x'))
  assert.ok(!t.includes('.a{}'))
  assert.ok(!t.includes('<'))
})

test('正文转文本：文字里的 &lt;b&gt; 保留成字面量', () => {
  assert.equal(htmlToText('&lt;b&gt;不是标签&lt;/b&gt;'), '<b>不是标签</b>')
})

test('标签剥离后多余空白会被收掉', () => {
  assert.equal(htmlToText('  前面   <span> 中间 </span>\r\n\r\n\r\n  后面  '), '前面 中间\n\n后面')
  assert.equal(stripTags('<b>粗</b>'), '粗')
})

test('findElements：同名标签嵌套也能配平', () => {
  const html = '<div class="x"><div class="x">内</div>尾巴</div><div class="y">别的</div>'
  const xs = findElements(html, 'x')
  assert.equal(xs.length, 2)
  assert.match(xs[0].inner, /尾巴$/)
  assert.equal(findElements(html, 'y').length, 1)
  // 精确到词：ti_title 不该命中 ti_title_extra
  assert.equal(findElements('<div class="ti_title_extra">x</div>', 'ti_title').length, 0)
})

test('截断：4000 字上限，截断处加 …（按码点切，不劈 emoji）', () => {
  assert.equal(__test.MAX_FLOOR_CHARS, 4000)
  const exact = 'a'.repeat(4000)
  assert.equal(truncate(exact, 4000), exact)

  const long = 'a'.repeat(4001)
  const cut = truncate(long, 4000)
  assert.equal(Array.from(cut).length, 4001)
  assert.ok(cut.endsWith('…'))
  assert.equal(Array.from(cut).slice(0, 4000).join(''), exact)

  const emoji = truncate('😀'.repeat(4001), 4000)
  assert.ok(emoji.endsWith('…'))
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji), false)
})

test('数字：1.2万 / 2,345 / 空', () => {
  assert.equal(toCount('1.2万'), 12000)
  assert.equal(toCount('2,345'), 2345)
  assert.equal(toCount('7615'), 7615)
  assert.equal(toCount(''), 0)
  assert.equal(toCount('暂无'), 0)
})

// ── URL 拼装（贴吧的 pn 是「第几条开始」，不是页码）────────────────────

test('列表 URL：首页不带 pn，第 2 页换算成 pn=31', () => {
  const home = __test.listUrl({ kw: '原神' })
  assert.equal(home, 'https://tieba.baidu.com/mo/q/m?kw=%E5%8E%9F%E7%A5%9E')
  assert.equal(__test.listUrl({ kw: '原神', page: 1 }), home)
  assert.ok(__test.listUrl({ kw: '原神', page: 2 }).endsWith('&pn=31'))
  assert.ok(__test.listUrl({ kw: '原神', page: 3 }).endsWith('&pn=61'))
  assert.ok(__test.listUrl({ kw: '原神', good: true }).endsWith('&lm=4'))
  assert.equal(__test.PAGE_SIZE, 30)
})

test('正文 URL：第 1 页不带 pn，第 2 页 pn=31', () => {
  assert.equal(__test.threadUrl({ tid: '11141821521' }), 'https://tieba.baidu.com/mo/q/m?kz=11141821521')
  assert.ok(__test.threadUrl({ tid: '11141821521', page: 2 }).endsWith('&pn=31'))
})

test('楼中楼 URL：/p/comment?tid=&pid=&pn=1（不是被猜错的 lzl=1）', () => {
  const u = __test.commentUrl({ tid: '11141821521', pid: '10000000004' })
  assert.equal(u, 'https://tieba.baidu.com/p/comment?tid=11141821521&pid=10000000004&pn=1')
  assert.ok(!u.includes('lzl='))
})

// ── 列表解析 ────────────────────────────────────────────────────────────

test('列表解析：优先啃页面里的 thread_list JSON', () => {
  const { bar, threads } = __test.parseListPage(LIST_PAGE_JSON)
  assert.equal(bar.name, '原神吧')
  assert.equal(bar.kw, '原神') // 去掉「吧」的形态，能原样喂回 kw
  assert.equal(bar.memberCount, 2854000)
  assert.equal(bar.threadCount, 70408000)
  assert.match(bar.url, /^https:\/\/tieba\.baidu\.com\/f\?kw=/)

  assert.equal(threads.length, 3)
  const [top, normal] = threads
  assert.equal(top.tid, '10000000002')
  assert.equal(top.pinned, true)
  assert.equal(top.isGood, true)
  assert.equal(top.replyCount, 52)
  assert.equal(top.title, '国庆活动进度盘点，分享你的收获')
  assert.equal(top.url, 'https://tieba.baidu.com/p/10000000002')

  assert.equal(normal.tid, '10000000001')
  assert.equal(normal.replyCount, 7615)
  assert.equal(normal.pinned, false)
  assert.equal(normal.hasImage, true)
  assert.equal(normal.author, '测试用户甲')
  // 契约字段一个都不能少
  for (const k of ['tid', 'title', 'author', 'time', 'replyCount', 'pinned', 'hasImage', 'isGood', 'url']) {
    assert.ok(k in normal, `thread 缺字段 ${k}`)
  }
})

test('列表解析：JSON 块没有时退回 HTML（置顶 li.tl_top 也要认出来）', () => {
  const { threads } = __test.parseListPage(LIST_PAGE_HTML)
  assert.equal(threads.length, 2)
  const top = threads[0]
  assert.equal(top.tid, '10000000002')
  assert.equal(top.pinned, true)
  assert.equal(top.title, '国庆活动进度盘点，分享你的收获') // 不能把「置顶」图标文字吃进标题
  const normal = threads[1]
  assert.equal(normal.tid, '10000000001')
  assert.equal(normal.replyCount, 7615)
  assert.equal(normal.hasImage, true)
  assert.match(normal.title, /颜值打分/)
})

test('列表兜底：只有 class="tl_top"（没有 data-floor）也算置顶，标题别吃进「置顶」两字', () => {
  const html = '<li class="tl_top scale-1px-bottom" data-tid="42"><a class="ti_item"><div class="ti_title"><span class="ti_title_icon ti_icon_zhiding">置顶</span><span>置顶的标题</span></div></a></li>'
  const { threads } = __test.parseListPage(html)
  assert.equal(threads.length, 1)
  assert.equal(threads[0].pinned, true)
  assert.equal(threads[0].title, '置顶的标题')
})

// ── 正文解析 ────────────────────────────────────────────────────────────

test('正文解析：楼层号取自 li 的 fn，不是楼中楼里的用户名', () => {
  const t = __test.parseThreadPage(THREAD_PAGE)
  assert.equal(t.title, '话说木偶一命到底有啥用')
  assert.equal(t.bar, '原神吧')
  assert.equal(t.kw, '原神')
  assert.equal(t.author, '测试用户乙')
  assert.equal(t.createdAt, '10-27 14:59')
  assert.equal(t.page, 1)
  assert.equal(t.totalPage, 2)
  assert.equal(t.floors.length, 2)

  const f1 = t.floors[0]
  assert.equal(f1.pid, '10000000003')
  assert.equal(f1.floor, 1)
  assert.equal(f1.isOp, true)
  assert.equal(f1.author, '测试用户乙')
  assert.equal(f1.time, '10-27 14:59')
  assert.match(f1.content, /喷长一点有啥用/)
  assert.deepEqual(f1.images, [])
  // 契约字段齐全
  for (const k of ['pid', 'floor', 'author', 'time', 'content', 'images', 'likeCount', 'subPostCount', 'isOp']) {
    assert.ok(k in f1, `floor 缺字段 ${k}`)
  }

  const f6 = t.floors[1]
  assert.equal(f6.pid, '10000000004')
  assert.equal(f6.floor, 6)
  assert.equal(f6.subPostCount, 5)
  assert.equal(f6.isOp, false)
  assert.match(f6.content, /喷久一点就是输出舒适度更高点/)
})

test('正文解析：楼层号不会误取成楼中楼里的名字（回归 lead 报的瑕疵）', () => {
  const t = __test.parseThreadPage(THREAD_PAGE)
  assert.deepEqual(t.floors.map((f) => f.floor), [1, 6])
  for (const f of t.floors) {
    assert.equal(typeof f.floor, 'number')
    assert.ok(Number.isInteger(f.floor))
  }
  // 关键：第 1 楼的正文只能是它自己的话，绝不能把楼中楼预览（「没必要4c…」）吃进来
  assert.ok(!t.floors[0].content.includes('没必要4c'))
  assert.equal(t.floors[1].author, '许沐沐灬')
  assert.ok(!t.floors[1].content.includes('回复 光明丨磊落'))
})

test('正文噪声：App 引流句子被清掉', () => {
  const html = `<ul><li tid="1" data-tid="1" fn="2" class="list_item post_list_item" data-info="{&quot;pid&quot;:1,&quot;floor_num&quot;:2}">
    <div class="list_item_wrapper"><div class="list_main"><div class="list_item_top clearfix"><div class="list_item_user_wrap"><div class="list_item_top_name"><span class="user_name"><a href="#">某吧友</a></span>
    <br/><span class="list_item_time">12:00</span></div></div></div>
    <div class="content" lz="0">真正的内容<br>第二行 打开贴吧App，查看全部40条评论<br>查看高清大图，就在手机贴吧</div>
    </div></div></li></ul>`
  const t = __test.parseThreadPage(html)
  assert.equal(t.floors.length, 1)
  assert.equal(t.floors[0].content, '真正的内容\n第二行')
  assert.equal(t.floors[0].floor, 2)
  assert.equal(t.floors[0].author, '某吧友')
})

// ── 楼中楼解析 ──────────────────────────────────────────────────────────

test('楼中楼解析：作者 / 时间 / 正文（去掉「回复 某人 :」前缀）', () => {
  const { replies, total, totalPage } = __test.parseSubPosts(LZL_HTML)
  assert.equal(replies.length, 5)
  assert.equal(total, 5)
  assert.equal(totalPage, 1)

  assert.equal(replies[0].author, '光明丨磊落')
  assert.equal(replies[0].time, '2026-10-27 20:14')
  assert.equal(replies[0].content, '没必要4c，即使3拐1伤害全在主c手里30增伤也是全队提升')

  assert.equal(replies[1].author, '神箭游侠💫')
  assert.ok(!replies[1].content.startsWith('回复'))
  assert.match(replies[1].content, /四c才能体现出价值/)
  for (const k of ['author', 'time', 'content']) {
    assert.ok(k in replies[0], `reply 缺字段 ${k}`)
  }
})

test('回复前缀清洗：回复 @某人 : / 回复 某人： 两种写法', () => {
  assert.equal(__test.stripReplyPrefix('回复 光明丨磊落 :四c才行'), '四c才行')
  assert.equal(__test.stripReplyPrefix('回复 @某鱼：好的'), '好的')
  assert.equal(__test.stripReplyPrefix('没有前缀的内容'), '没有前缀的内容')
})

// ── 风控 / 错误识别 ─────────────────────────────────────────────────────

test('风控页 / 贴吧404 识别', () => {
  assert.equal(__test.looksBlocked('<title>百度安全验证</title>'), true)
  assert.equal(__test.looksBlocked('<html>正常页面</html>'), false)
  assert.equal(__test.looks404('<title>贴吧404</title>'), true)
  assert.equal(__test.looks404('正常'), false)
})

test('写接口错误翻译成人话（未登录 / 验证码 / tbs / 权限 / 其他）', () => {
  const cases = [
    [{ no: 265, err_code: 230265 }, /未登录/],
    [{ no: 4, error: '请输入验证码' }, /验证码/],
    [{ no: 1, error: 'tbs 参数错误' }, /tbs/],
    [{ no: 2, error: '您已被吧主封禁' }, /权限/],
    [{ no: 9, error: '' }, /no=9/],
  ]
  for (const [input, re] of cases) {
    const r = __test.commitError(input)
    assert.equal(r.ok, false)
    assert.match(r.error, re)
    assert.ok(r.hint && r.hint.length > 0, '失败必须有 hint')
  }
})

// ── 不联网的前置校验（参数错了就别去打贴吧）────────────────────────────

test('参数不对时直接返回人话错误，不发请求', async () => {
  const t = [
    [await listThreads({}), /没给吧名/],
    [await readThread({ tid: 'not-a-number' }), /帖子 ID/],
    [await readSubPosts({ tid: '123', pid: 'x' }), /楼层 ID/],
    [await postThread({}), /未登录/],
    [await replyPost({ bduss: 'x', content: 'y', tid: 'abc' }), /帖子 ID/],
    [await replySubPost({ bduss: 'x', content: 'y', tid: '123', pid: 'abc' }), /楼层 ID/],
  ]
  for (const [r, re] of t) {
    assert.equal(r.ok, false)
    assert.match(r.error, re)
  }
})

test('没登录 / 没 BDUSS 时的读接口：tbs 与 whoami 都给空或人话，不抛', async () => {
  assert.equal(await ensureTbs({}), '')
  assert.equal(await ensureTbs({ bduss: '' }), '')
  const w = await whoami({})
  assert.equal(w.ok, false)
  assert.equal(w.loggedIn, false)
  assert.match(w.error, /未登录/)
})

// ── 凭证 ────────────────────────────────────────────────────────────────

test('凭证：保存 → 读出 → 清掉（永不抛）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tieba-test-'))
  try {
    assert.equal(loadCredential(dir), null)
    saveCredential(dir, { bduss: '  AAA  ', stoken: ' SSS ', uname: ' 大肥鱼 ' })
    assert.equal(existsSync(join(dir, 'tieba_credential.json')), true)
    const c = loadCredential(dir)
    assert.equal(c.bduss, 'AAA')
    assert.equal(c.stoken, 'SSS')
    assert.equal(c.uname, '大肥鱼')
    clearCredential(dir)
    assert.equal(loadCredential(dir), null)
    // 目录都不存在时也不抛
    assert.equal(loadCredential(join(dir, 'nope')), null)
    clearCredential(join(dir, 'nope'))
    // 家目录没传时也不能往当前目录瞎写
    saveCredential(undefined, { bduss: 'X' })
    assert.equal(loadCredential(''), null)
    assert.equal(existsSync(join(process.cwd(), 'tieba_credential.json')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('UA 常量：一个手机一个桌面', () => {
  assert.match(UA_MOBILE, /^Mozilla\/5\.0/)
  assert.match(UA_MOBILE, /iPhone|Android/)
  assert.match(UA_DESKTOP, /Windows NT/)
})
