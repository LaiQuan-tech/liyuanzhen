/**
 * 抒發情緒：訪客這一句是不是在講「自己」的負面感受（好煩、好累、壓力好大、好委屈、想哭…）。
 *
 * 給 app/api/chat/route.ts 的「同理備援」用：落地檢查以落地率不足攔下模型原答、不是危機延續、
 * 專線救援也沒有接手時，這一句是抒發就改送 content/site.ts 的 VENTING_REPLY，不是 UNGROUNDED_REPLY。
 *
 * 🔴 為什麼要有：本機評測 X-07「我媽一直逼我結婚 好煩喔」連續兩次，模型答得很得體（先同理、再講她書裡
 * 從小看父母吵鬧而排斥婚姻的經歷、最後把決定交還訪客），卻因為換句話說、落地率只有 4–5% 被換成
 * 「這一題我答不上來——資料裡找不到可靠的出處」。對一個在抒發情緒的人，這句冷冰冰而且答非所問。
 * 靠樣式剝掉同理句（lib/answer-guard.ts 的 EMPATHY_CLAUSES）追不上模型每次不同的措辭，
 * 所以改在「攔下之後送什麼」這一層處理。
 * ⚠️ 這支不決定要不要攔、也不放行任何模型原答：被攔的原答照樣一個字都不送，只是換一句替代回覆。
 *
 * ## 判準（改規則先改 lib/venting.test.ts，那裡的正反例就是規格）
 *
 * 1. **只看訪客這一句，不看歷史**（同 lib/crisis.ts 判準 1）。
 * 2. **不跟危機偵測搶。** 危機句由 lib/crisis.ts 在檢索前就接走；detectCrisis 接得到的句子，這裡一律不算——
 *    就算 route 的順序以後被改動，也不會把危機回覆換成同理話。專線救援（hotlineKind）在 route 裡排在這支前面。
 *    ⚠️ detectCrisis 刻意不收的說法（單獨的「活著好累」，見 lib/crisis.ts）會走到這裡，拿到同理回覆——
 *    同理回覆跟改動前的 UNGROUNDED_REPLY 一樣沒有專線，這一點沒有變好也沒有變差。
 * 3. **要有負面感受的說法**（FEELING）：好煩、煩死了、好累、心累、壓力好大、受不了、好難過、好委屈、好生氣、不開心、
 *    好沮喪、好焦慮、好無奈、想哭…。多數要帶程度副詞（好、很、超、真的、快…）或後面接「到／得」才算：
 *    單獨的「累」可能是累積，「辛苦了」「辛苦妳了」是道謝，「麻煩到你了」是客套。
 * 4. **感受是訪客自己的。** 看同一個子句裡、感受前面最近的那個主詞：
 *    - 「我」→ 算（我好委屈、婆婆一直唸我 我好委屈、他讓我好累、我老公氣死我了）。
 *    - 沒有主詞 → 算（好煩喔、工作壓力好大、快受不了了）。前一段只有一個人（「我媽 好累」「妳 壓力很大」「妳一定 很累」，
 *      主詞被空白斷開）時，那個人就是主詞；只有稱呼她（「老師，好累喔」）是在叫她，「跟妳說」「妳知道嗎」是開場白，都不算主詞。
 *    - 她（妳、你、您、老師、李元貞…）→ 不算：「妳當年壓力大嗎」「妳一定很累」「看到妳小時候被打的故事好難過」。
 *      她出現在感受前面、主詞又不是「我」，她讓我怎樣，或感受的受詞是她（「跟妳聊天好累」「妳讓我好累」「我討厭妳」）
 *      是在抱怨她，也不算。「老師叫我重寫報告好煩」的單獨「老師」是訪客學校的老師，照算。
 *    - 別人（她、他、我媽、朋友、女性…），中間只隔副詞、「說／覺得」或那個人自己的事（工作、考試…）→ 那是別人的感受，
 *      不算：「我媽說她很累」「我朋友最近壓力好大」「我老公工作壓力很大」。中間隔著別的事（「我老公都不做家事好累」）
 *      → 累的是講話的人，算。例外：嫌別人煩、討厭而且後面沒有受詞（「我媽好煩」「我婆婆超煩的」「我老闆很討厭」）
 *      是講話的人在煩，算；轉述的（「我媽說她很煩」「我媽覺得很煩」）、煩惱煩躁（「我媽很煩惱我的婚事」）、有受詞的好惡
 *      （「我兒子很討厭上學」）、隔著時間在講那個人最近的狀態（「我女兒最近很煩 因為要考試」）不算——除非整句有那個人
 *      對「我」做的事（「我媽最近好煩 一直逼我結婚」）。感受後面接著「我」（「我老公氣死我了」「大家都討厭我」）是講話的人受了氣，算。
 *    - 受詞不是主詞（isSubject）：「被我媽煩死了」「跟我媽吵架好煩」「帶這些小孩好累」「照顧老人好累」「當新手媽媽好累」
 *      累的是講話的人。數量、指示、修飾語先剝掉再看前面是不是動詞：「很多媽媽都很累」「那個主管好煩」的人是主詞。
 *      ⚠️ 已知漏網：主詞延續上一段的別人（「我媽身體不好 心情很差」）分不出來，會被當成講話的人——跟規格正例
 *      「我老公都不做家事 好累」是同一個句型，要靠語意才分得開。後果是送出一句不太貼切的同理話。
 * 5. **不是在問。** 感受後面緊接嗎、呢、吧、ㄇ、對吧，正反問（壓力大不大、開不開心），子句以問號收尾，
 *    或前面有會不會、是不是、有沒有 → 不算：「婦運很累嗎」「妳會煩惱嗎」。「工作壓力好大怎麼辦」問的是怎麼辦，算。
 *    被空白切開的問句一樣不算：「寫作很累 嗎」（只有助詞的一段先併回去）、「妳 會不會 很累」（前一段以會不會收尾）。
 * 6. **不是否定、假設、推測或修飾**：「一點都不累」「沒什麼好難過的」「別太難過」「如果很累的話」「一定很累」
 *    「難過的時候怎麼辦」不算。「想哭」在感動、好笑的句子裡不算（「好感動 好想哭」）。
 * 7. **沒有明講「我」的感受、整句又在講她的年代或婦運**（當年、那個年代、婦運、修法…）→ 不算：
 *    「當年的社會壓力很大 妳怎麼撐過來的」「婦運好辛苦」。明講「我」的只看「我」跟感受中間（「我覺得當年的婦運好辛苦」不算）。
 *    沒有明講「我」、整句在問怎麼安慰或幫前面那個人（「我朋友失戀了 很難過 不知道怎麼安慰她」）也不算；
 *    「好累 我要怎麼照顧我媽」「好累 不知道怎麼照顧我媽」是講話的人在累，照算。
 *    整句沒有「我」又問她「怎麼看」是議題題（「婚姻很累 妳怎麼看」「現在的社會壓力很大 妳怎麼看」），不算——
 *    代價是「好煩 妳怎麼看」也不算。有「我」的照算（「我媽一直逼我結婚 好煩 妳怎麼看」「好煩喔 妳覺得呢」）：
 *    同理回覆本來就說「我沒辦法替你做決定」。
 * 8. **整句在問她的往事、或是被她的故事觸動 → 不算**（不論有沒有明講「我」）：「我好難過 妳以前怎麼撐過來的」
 *    「我好痛苦 婦女新知當年是怎麼撐過來的」「妳的故事讓我好難過」「看完妳的自傳 好難過」「老師 聽了好難過」。
 *    同理回覆說「想聽老師當年怎麼面對類似的事，都可以問我」，送給剛問完這件事的人就是答非所問；這種句子照舊送
 *    UNGROUNDED_REPLY（問的事答不上來）。她的書只在感受那一段或前一段出現時才算觸動（「工作壓力好大 想看妳的書放鬆一下」照算）。
 *    ⚠️ 沒有提到她的觸動（「聽完好想哭」）只看這一句分不出來，會拿到同理回覆。
 *
 * ⚠️ 簡體：先過 lib/crisis.ts 的 toTraditional；那張表沒收的字（煩難喪無悶惱憂鬱單獨潰絕憊討厭樂級瘋爛別）在規則裡兩種寫法都寫。
 * ⚠️ 正則不可以有「同一串字有兩種切法」的重複選項（例如同時收「每天都」與「每天」「都」、「常常」與「常」）：
 *    配上 * 或 + 會指數回溯，300 字的特製輸入就能卡住整個請求（審查實測，見測試「特製輸入不會卡住」）。
 */
import { detectCrisis, toTraditional } from "./crisis";

/** 程度副詞，以及常夾在主詞和感受之間的副詞（好累、也好累、每天都好累、真的快受不了）。⚠️ 選項之間不可以互相拼得出來（見檔頭） */
const DEG =
  "(?:好|很|超[級级]|超|真的|真是|真|太|有點|有些|有夠|蠻|滿|挺|非常|特別|十分|實在|越來越|愈來愈|整個|更|快要|快|已經|一直|總是|老是|每天|天天|也|又|都|就)";

/**
 * 要帶程度副詞、或後面接「到／得」才算的感受。
 * ⚠️ 麻煩、不耐煩的「煩」，累積、連累的「累」不算；「生氣」不可以是生氣蓬勃；
 * 「辛苦」後面接「了」或她是道謝（老師真的辛苦了、真是辛苦妳了）。
 */
const NEEDS_DEGREE = [
  "[煩烦][惱恼]",
  "[煩烦][悶闷]",
  "[煩烦]躁",
  "(?<![麻耐])[煩烦](?![請惱恼悶闷躁])",
  "(?<![積連拖勞])累(?![積計犯贅加進])",
  "[難难]過",
  "[難难]受",
  "[難难]熬",
  "委屈",
  "生氣(?!蓬勃)",
  "沮[喪丧]",
  "焦[慮虑]",
  "[無无]奈",
  "[無无]助",
  "痛苦",
  "傷心",
  "心酸",
  "心痛",
  "[鬱郁][悶闷]",
  "[鬱郁]卒",
  "阿雜",
  "[憂忧][鬱郁](?!症)",
  "孤[單单]",
  "孤[獨独]",
  "寂寞",
  "失落",
  "低落",
  "崩[潰溃]",
  "[絕绝]望",
  "疲[憊惫倦]",
  "辛苦(?!了|[妳你您]|老師)",
  "[討讨][厭厌]",
  "[厭厌]世",
  "倒[楣霉]",
];
/**
 * 「氣」只在帶程度副詞、而且在子句結尾或接語氣詞、死、炸、到時才算（好氣喔、很氣、超氣的）。
 * 不放進上面那張表：那張表也用在「沒有程度副詞、後面接到」的寫法，「運氣到了」「力氣到哪去」會被當成生氣。
 */
const ANGRY = "氣(?=[了喔哦啦耶欸啊呀死炸到的]|$)";

/** 本身就是負面感受、不必帶程度副詞的說法（前面可以有：真的受不了、好想哭、好不開心） */
const ALWAYS = [
  "(?<![麻耐])[煩烦]死",
  "(?<![麻耐不])[煩烦](?=[耶欸吶啦捏喔哦]|$)", // 煩耶、煩欸；單獨一個「煩」（煩惱、煩躁後面接的不是這些字，比對不到）
  "[討讨][厭厌]死",
  "(?<=我)[討讨][厭厌]", // 我討厭我婆婆（「我不討厭」的「不」夾在中間，比對不到）
  "累(?:死|爆|翻|壞|癱)",
  "(?<![積連拖勞])累了",
  "氣死",
  "氣炸",
  "受不了",
  "撐不住",
  "快要?(?:[瘋疯]|抓狂|哭)",
  "要(?:[瘋疯]|抓狂)了",
  "(?:逼|搞|弄)[瘋疯]",
  "抓狂",
  "想哭",
  `心${DEG}*累`,
  "身心俱疲",
  "不開心",
  "不快[樂乐]",
  "不好受",
  "不爽",
  `心情${DEG}*(?:不好|不佳|差|糟|低落|[爛烂]|不美麗)`,
  "[煩烦]心",
  "心[煩烦]",
  `壓力${DEG}*大`,
  "壓力山大",
  "壓力爆表",
  "有壓力",
  "(?:好|很|超|非常)大的壓力",
];

const FEELING = new RegExp(
  [
    `${DEG}*(?:${ALWAYS.join("|")})`,
    `${DEG}+(?:${NEEDS_DEGREE.join("|")}|${ANGRY})`,
    `(?:${NEEDS_DEGREE.join("|")})(?=到|得)`,
  ].join("|"),
  "g"
);
/** 嫌別人：主詞是別人也是講話的人在煩（我媽好煩、我老闆很討厭、婆婆很煩人）。不含煩惱、煩躁、煩悶——那是主詞自己的感受 */
const ANNOYED = /(?:[煩烦]|[煩烦]死|[討讨][厭厌]|[討讨][厭厌]死)$/;

/** 子句：連續的文字與數字（同 lib/crisis.ts 的 CLAUSE）。語音與手機輸入常用空白代替標點，空白也是分界 */
const CLAUSE = new RegExp("[\\p{L}\\p{N}]+", "gu");
/**
 * 只有句尾助詞的一段前面的空白（「寫作很累 嗎」「好煩 喔」）不是分句，是打字時的停頓——切子句之前先併回去，
 * 不然「嗎」被切走，問句就被當成抒發（同 lib/crisis.ts 的 PARTICLE_GAP）。
 */
const PARTICLE_GAP = new RegExp(
  "(?<=\\p{Script=Han})[ \\u3000]+(?=[了啦啊呀喔哦囉耶欸唷呦嘛吧呢哇嗎ㄇㄋ]+(?:[^\\p{L}\\p{N}]|$))",
  "gu"
);
/** 前一個子句以這些收尾，這一句的感受就是被問的那件事：「妳 會不會 很累」「是不是 很煩」 */
const ASKS_AT_END = /(?:會不會|是不是|有沒有|是否|難道|可不可能)$/;

/** 她：對她說話或講她。⚠️「我們老師」「我的老師」是訪客自己的老師，歸在別人 */
const HER = "(?:數位李元貞|李元貞老師|元貞老師|李老師|李元貞|元貞|(?<!我們?的?)老師|妳們|你們|您們|妳|你|您)";
/** 只是稱呼她：前一段只有這幾個字時是在叫她（老師，好累喔），不是主詞。「妳」「你」單獨一段仍然當主詞（妳 壓力很大） */
const HER_TITLE = /^(?:數位李元貞|李元貞老師|元貞老師|李老師|李元貞|元貞|老師)$/;
/** 講話的人自己。「自我」不算 */
const SELF = "(?:我們|咱們|(?<!自)我|咱)";
const POSSESSIVE = "(?:我們的|我們|我的|我|妳的|你的|您的|他的|她的|他們的|她們的)";
/** 別人：代名詞 */
const PRONOUN = "(?:他們|她們|它們|他|她|它|牠|對方)";
/** 別人：家人與身邊的人。長的放前面 */
const KIN =
  "(?:老媽|媽媽|媽咪|母親|老爸|爸爸|父親|爸媽|父母|家人|家裡的人|老公|先生|丈夫|老婆|太太|妻子|婆婆|公公|岳母|岳父|丈母娘|" +
  "前男友|前女友|男朋友|男友|女朋友|女友|前夫|前妻|另一半|伴侶|兒子|女兒|小孩|孩子|寶寶|兒女|哥哥|姊姊|姐姐|弟弟|妹妹|" +
  "阿嬤|阿公|奶奶|爺爺|外婆|外公|阿姨|叔叔|舅舅|姑姑|嬸嬸|親戚|長輩|朋友|好友|閨蜜|同學|同事|主管|老闆|上司|室友|鄰居|" +
  "學生|媳婦|女婿|網友|客戶|教授|(?<=我們?的?)老師|媽|爸|哥|姊|姐|弟|妹)";
/** 別人：泛稱的一群人（女人好辛苦、現代女性壓力很大）——前面是修飾語也還是主詞，只有「當／身為…」時是講話的人自己 */
const GROUP =
  "(?:女性|女人|婦女|女孩子|女孩|女生|男生|男人|前輩|年輕人|上班族|家庭主婦|主婦|職業婦女|單親媽媽|媽媽們|老人家|老人|大家|別人|人們|有人)";
const PERSON = new RegExp(`${POSSESSIVE}?(?:${KIN}|${GROUP})|${HER}|${PRONOUN}|${SELF}`, "g");
const HER_ONLY = new RegExp(`^${HER}$`);
const SELF_ONLY = new RegExp(`^${SELF}$`);
const GROUP_ONLY = new RegExp(`^(?:${POSSESSIVE})?${GROUP}$`);
/** 「我們女生好辛苦」：講話的人也在裡面 */
const OUR_GROUP = new RegExp(`^我們的?${GROUP}$`);
/** 感受後面緊接著「我」（氣死我了、大家都討厭我）：受影響的是講話的人。「我媽」「我的朋友」不算 */
const AFFECTS_ME = new RegExp(`^${SELF}(?!的?(?:${KIN}|${GROUP}))`);
const OBJECT_ME = /^(?:我們|咱們|我|咱)/;
/** 子句從這裡開始就是一個人稱（感受後面接著別人＝感受有受詞：我媽很討厭我婆婆） */
const PERSON_AT_START = new RegExp(`^(?:${POSSESSIVE}?(?:${KIN}|${GROUP})|${HER}|${PRONOUN}|${SELF})`);
/** 感受後面緊接著她（我討厭妳、我真的很討厭妳）：是在抱怨她。「我好難過你知道嗎」「我好累妳呢」的她不是受詞 */
const HER_AT_START = new RegExp(`^${HER}(?!知道|懂|曉得|呢)`);
/**
 * 她讓我、她害我…：是訪客在抱怨她（妳讓我好累、妳講的讓我好生氣），不是在抒發自己的事。
 * ⚠️ 單獨的「老師」不算：「老師叫我重寫報告好煩」是訪客學校的老師。
 */
const HER_BY_NAME = "(?:數位李元貞|李元貞老師|元貞老師|李老師|李元貞|元貞|妳們|你們|您們|妳|你|您)";
const HER_CAUSES = new RegExp(`${HER_BY_NAME}[^我]{0,8}?(?:讓|害|使|令|逼|叫|把|搞得|弄得)我`);
/** 「跟妳說」「告訴妳」「妳知道嗎」是開場白，不是抱怨她（跟妳說喔好累、妳知道嗎好累） */
const TELLS_HER = /(?:跟|和|對|告訴)$/;
const DISCOURSE_AFTER_HER = /^(?:知道嗎|懂嗎|知道|曉得)/;

/** 「我」與她接在這些字後面時不是主詞（受詞、身分）：跟我說、跟妳講這些好難過 */
const NOT_SUBJECT_BEFORE = /(?:被|跟|和|與|同|對|向|幫|替|陪|為|給|把|找|等|當|做|身為|作為|像)$/;
/** 泛稱的一群人接在這些字後面時是講話的人的身分：當女生好累、身為女人好辛苦、我是女生壓力好大 */
const IDENTITY_BEFORE = /(?:當|身為|作為|做|是)$/;
/**
 * 別人（家人、身邊的人、代名詞）只有在子句開頭、或緊接在這些字後面時才是主詞：
 * 說／覺得／看到（我覺得我媽很累）、連接詞、使役（他讓我媽好累＝媽媽累）、時間、語氣詞、「的」（隔壁的阿姨好煩）。
 * 數量、指示與修飾語（很多、這些、那個、新手…）先剝掉再看：「很多媽媽都很累」「那個主管好煩」是主詞，
 * 「帶這些小孩好累」「當新手媽媽好累」前面是動詞，還是受詞。
 * 其餘都當受詞：帶小孩好辛苦、照顧我媽好累、跟我媽吵架好煩、被我媽煩死了、當媽媽好累——累的是講話的人。
 * ⚠️ 代價：「照顧生病的媽媽好累」的「的」被當成主詞的修飾，漏接（回 UNGROUNDED_REPLY，跟改動前一樣）。
 */
const SUBJECT_BEFORE =
  /(?:說|講|覺得|認為|以為|發現|聽說|知道|看到|聽到|感覺|但是|但|可是|不過|而且|因為|所以|然後|結果|其實|讓|害|使|令|逼|叫|最近|今天|昨天|現在|平常|每天|後來|唉|哎|欸|嗯|喔|啊|啦|了|呢|嗎|的|是|也|都|又|還)$/;
/** 人前面的數量、指示與修飾語（判斷主詞前先剝掉） */
const MODIFIER_BEFORE = /(?:很多|許多|有些|一些|不少|大部分|多數|所有|每個|每位|其他|單親|職業|全職|新手|現代|這些|那些|這個|那個|這位|那位|有的)$/;
/** 泛稱的一群人前面是這些動詞時是受詞：照顧老人好累、每天照顧老人家好辛苦 */
const CARE_VERB_BEFORE = /(?:照顧|照料|帶|教|陪|管|養|顧|服務|應付|面對|伺候|哄|餵)$/;
/** 別人前面緊接著轉述的動詞：那是別人說出來的感受（我媽說她很煩），嫌別人煩的例外不適用 */
const REPORTED_BEFORE = /(?:說|講|表示|抱怨|喊|提到)$/;
/** 嫌別人煩的例外只在那個人直接接感受、或只隔著強調的副詞時成立（我媽好煩、我婆婆真的超煩）；隔著時間是在講那個人最近的狀態 */
const EMPHASIS_GAP = /^(?:真的|真是|實在|也|都|就|又|還|超|好|很)*$/;
/** 整句有別人對「我」做的事（逼我、唸我、叫我…）：那個人的「煩」是講話的人在煩（我媽最近好煩 一直逼我結婚） */
const ACTS_ON_ME = /(?:逼|唸|念|叫|罵|管|吵|催|嫌|盯|欺負|問|煩|針對|找|限制|控制|不讓|不准|一直說)我/;

/**
 * 別人跟感受中間只隔這些：那是那個人的感受（我媽說她很累、我朋友最近壓力好大、我媽覺得好累），
 * 包括那個人自己的事（我老公工作壓力很大、我兒子考試壓力好大、我老公工作很累）。
 * 隔著別的事（我老公都不做家事好累）就是講話的人在累。⚠️ 選項之間不可以互相拼得出來（「常常」由「常」重複涵蓋）。
 */
const ADVERBIAL_GAP = new RegExp(
  "^(?:(?:跟|和|對|向)我們?|說|講|覺得|感覺|好像|似乎|表示|抱怨|喊|也|又|都|還|就|最近|今天|昨天|這陣子|這幾天|每天|天天|" +
    "一直|總是|老是|經常|真的|一定|應該|可能|大概|其實|確實|現在|目前|也是|會|總|常|已經|的|" +
    "工作|課業|學業|功課|生活|經濟|精神|心理|身體|考試|感情)*$"
);
/** 別人後面接著轉述或感覺的動詞：那是那個人自己的感受（我媽說好煩、我媽覺得很煩） */
const REPORTED_GAP = /^(?:說|講|表示|抱怨|喊|覺得|感覺|認為)/;

/** 感受前面緊接著否定或反問：一點都不累、不會很累、別太難過、沒有不開心、沒什麼好難過的 */
const NEGATED =
  /(?:不|沒|沒有|別|别|不要|不用|不必|不會|不是|不太|並不|才不|不再|從不|從沒|免得|以免|沒什麼|沒甚麼|有什麼|有甚麼|何必|幹嘛|不需要|不值得)$/;
/** 假設：如果很累的話 */
const HYPOTHETICAL = /如果|要是|假如|萬一|假設|一旦/;
/** 推測別人：一定很累、想必很辛苦（「妳一定很累」「老師 一定很累」）。明講「我」的不受影響 */
const PRESUMED = /(?:一定|想必|應該)$/;
/** 前面有這些就是在問感受本身：會不會很累、是不是很煩 */
const ASKS_BEFORE = /會不會|是不是|有沒有|是否|難道|怎麼會|可不可能/;
/** 感受後面的語氣詞（不含問句的嗎、呢、吧） */
const TAIL_PARTICLES = /^[了啦喔哦耶欸唷呦啊呀囉嘛哇捏餒咧ㄛ]+/;
/**
 * 感受後面緊接著這些就是在問：嗎、呢、吧、注音的ㄇ；附加問句（對吧、是不是）要在子句結尾才算——
 * 「我好累是不是生病了」問的是原因，不是感受。
 */
const ASKS_AFTER = /^(?:嗎|呢|吧|麼|ㄇ|ㄋ)|^(?:對吧|對不對|是吧|是不是|沒錯吧|對嗎)[啦喔哦耶欸啊呀嘛]*$/;
/** 修飾或時間：難過的時候、很累時、壓力大的話——不是在說現在的感受。子句結尾的「的」是語氣（超氣的），不算 */
const MODIFIER_AFTER = /^(?:的(?=[^啦喔哦耶欸])|時|之後|以後|之前)/;
/** 「想哭」「快哭了」在這些句子裡是感動或好笑（判準 6） */
const MOVED = /感動|笑|開心|高興|幸福|溫暖|喜極/;

/** 她的年代或婦運（判準 7） */
const ERA_OR_TOPIC = /當年|那個年代|那年代|那個時代|那時代|早年|上一代|婦運|婦女運動|女權運動|社會運動|社運|修法|婦女新知|戒嚴|黨外/;
/**
 * 問怎麼幫別人（判準 7）：我朋友失戀了 很難過 我要怎麼安慰她——「很難過」沒有主詞，延續的是前面那個朋友。
 * ⚠️ 只收「怎麼＋動詞＋代名詞（她、他）」指回前面那個人：「每天照顧我媽 好累」「好累 我要怎麼照顧我媽」是講話的人在累，照算。
 * 安慰、開導、鼓勵（COMFORTS_OTHERS）表示難過的是那個人，一律不算；幫、照顧、陪這類前面是「不知道怎麼」
 * （SELF_STRUGGLE：「每天照顧失智的媽媽 好累 不知道怎麼幫她」）是講話的人自己的難處，照算。
 */
const COMFORTS_OTHERS = new RegExp(`(?:怎麼|如何|怎樣)(?:安慰|開導|鼓勵)${PRONOUN}`);
const HELPS_OTHERS = new RegExp(`(?:怎麼|如何|怎樣)(?:幫助|幫忙|幫|體貼|陪伴|陪|支持|照顧|關心)${PRONOUN}`);
const SELF_STRUGGLE = /不(?:知道|曉得|懂)(?:要|該)?(?:怎麼|如何|怎樣)/;
/**
 * 問她對議題的看法（判準 7）：婚姻很累 妳怎麼看、現在的社會壓力很大 妳怎麼看、女人結婚好累 妳怎麼看。
 * ⚠️ 只在整句沒有「我」時算議題題：「我媽一直逼我結婚 好煩 妳怎麼看」照算。代價：「好煩 妳怎麼看」也不算（退回 UNGROUNDED_REPLY）。
 */
const ASKS_VIEW = new RegExp(`${HER}(?:怎麼看|的看法|有什麼看法)`);
const MENTIONS_SELF = /我|咱/;
/** 問句的字眼（判準 8 的「問她的年代或婦運」） */
const QUESTION_WORD = /怎麼|如何|怎樣|為什麼|為何|什麼|哪|嗎|呢|ㄇ|有沒有|是不是|會不會/;
/** 問她的往事（判準 8）：妳以前怎麼撐過來的、老師妳都怎麼紓壓的、妳當年怎麼面對的 */
const ASKS_HER_PAST = new RegExp(
  `${HER}[^\\s，。！？,.!?]{0,6}?(?:以前|當年|那時|小時候|年輕|過去|都怎麼|是怎麼|怎麼撐|怎麼熬|怎麼走|怎麼度過|怎麼面對|` +
    "怎麼調適|怎麼紓壓|怎麼處理|遇過|經歷過|曾經|也曾|有沒有過)"
);
/**
 * 被她的故事或作品觸動（判準 8）：妳的故事讓我好難過、讀妳的書讓我好想哭、看完妳的自傳 好難過。
 * 只看感受所在的子句與前一段——「工作壓力好大 想看妳的書放鬆一下」是抒發完才提到書，照算。
 */
const HER_STORY = new RegExp(`${HER}的?(?:故事|書|經歷|遭遇|詩|文章|自傳|人生|一生|童年|小時候|過去|往事|寫的)`);
/** 看到、聽了她講的事（老師，好難過喔 看到妳離婚那段、聽妳這樣說 好難過）：整句有這個就是被她觸動 */
const REACTS_TO_HER = new RegExp(`(?:看到|看了|看完|聽到|聽了|聽完|讀到|讀了|讀完|想到)${HER}|聽${HER}(?:這樣|那樣)?[說講]`);
/**
 * 叫了她之後說「聽了好難過」：難過的是她說的事（老師 聽了好難過）。只在「聽了／看完…」緊接著感受時才算——
 * 「聽了我媽的話好難過 妳覺得呢」「今天看了醫生好難過 你懂嗎」是訪客自己的事。
 */
const REACTION = /(?:聽了|聽完|看了|看完|讀了|讀完)$/;

interface Clause {
  text: string;
  start: number;
}

type Who = "self" | "her" | "other";

/** 一個人稱片段是誰 */
function whoIs(ref: string): Who {
  if (SELF_ONLY.test(ref) || OUR_GROUP.test(ref)) return "self";
  if (HER_ONLY.test(ref)) return "her";
  return "other";
}

/** 這個人稱片段在這裡是不是主詞（判準 4 最後一點） */
function isSubject(prefix: string, ref: RegExpMatchArray): boolean {
  const before = prefix.slice(0, ref.index ?? 0);
  if (whoIs(ref[0]) !== "other") return !NOT_SUBJECT_BEFORE.test(before);
  let base = before;
  for (let i = 0; i < 3 && MODIFIER_BEFORE.test(base); i += 1) base = base.replace(MODIFIER_BEFORE, "");
  if (GROUP_ONLY.test(ref[0])) return !IDENTITY_BEFORE.test(base) && !CARE_VERB_BEFORE.test(base);
  return base === "" || SUBJECT_BEFORE.test(base);
}

/**
 * 子句只有一個人（後面可以有時間或語氣副詞）：「我媽」「妳」「老師」「我媽最近」「妳一定」——主詞被空白斷在前一段。
 * 第一個群組是那個人。
 */
const BARE_PERSON = new RegExp(
  `^(${POSSESSIVE}?(?:${KIN}|${GROUP})|${HER}|${PRONOUN}|${SELF})` +
    "(?:最近|今天|昨天|現在|這陣子|以前|當年|那時候|小時候|年輕時|也|都|一定|應該|真的|其實|一直|每天)*$"
);

interface Experiencer {
  who: Who;
  /** 有沒有明講「我」——判準 7 的範圍看它 */
  explicit: boolean;
  /** 那個人跟感受中間的字 */
  gap: string;
}

/**
 * 感受是誰的。`prefix` 是同一個子句裡、感受前面的字；`prev` 是前一個子句（主詞被斷在前一段時用）；
 * `feeling` 是命中的感受、`after` 是它後面的字（嫌別人煩、「氣死我」的例外用）；`actsOnMe`：整句有別人對「我」做的事。
 */
function experiencer(
  prefix: string,
  prev: Clause | undefined,
  feeling: string,
  after: string,
  actsOnMe: boolean
): Experiencer {
  // 「跟妳說」「告訴妳」「妳知道嗎」的她是開場白，不當主詞、也不算提到她
  const opener = (r: RegExpMatchArray) => {
    const next = prefix.slice((r.index ?? 0) + r[0].length);
    return (
      whoIs(r[0]) === "her" &&
      ((TELLS_HER.test(prefix.slice(0, r.index ?? 0)) && /^[說講](?!話)/.test(next)) || DISCOURSE_AFTER_HER.test(next))
    );
  };
  const all = Array.from(prefix.matchAll(PERSON)).filter((m) => !opener(m));
  const refs = all.filter((m) => isSubject(prefix, m));
  const last = refs[refs.length - 1];
  // 抱怨她（妳很討厭我、妳讓我好累、跟妳聊天好累、我討厭妳）不是抒發自己的事：
  // 她出現在感受前面、主詞又不是「我」，或感受的受詞是她時一律不算。「跟妳說」「告訴妳」是開場白，不算提到她。
  if (HER_CAUSES.test(prefix) || HER_AT_START.test(after)) return { who: "her", explicit: false, gap: "" };
  const herMentioned = all.some((r) => whoIs(r[0]) === "her");
  if (herMentioned && (!last || whoIs(last[0]) !== "self")) return { who: "her", explicit: false, gap: "" };
  if (AFFECTS_ME.test(after)) {
    // 氣死我了、大家都討厭我：受影響的是講話的人
    return refs.some((r) => whoIs(r[0]) === "her") ? { who: "her", explicit: false, gap: "" } : { who: "self", explicit: true, gap: "" };
  }
  // 嫌別人煩、討厭：感受後面沒有受詞（我兒子很討厭上學＝兒子自己的好惡），只剩語氣詞、「人」（煩人）或句尾的「的」
  const annoyed = ANNOYED.test(feeling) && /^(?:的?[了啦喔哦耶欸唷呦啊呀囉嘛哇捏餒咧ㄛ]*|人.*)$/.test(after);
  if (!last) {
    const bare = prev?.text.match(BARE_PERSON);
    // 只有稱呼她（老師，好累喔）是在叫她，不是主詞；「辛苦」例外——對她說辛苦多半是心疼她（老師 好辛苦喔）
    if (bare && !(bare[0] === bare[1] && HER_TITLE.test(bare[1]) && !/辛苦/.test(feeling))) {
      const who = whoIs(bare[1]);
      if (who === "other" && annoyed && (bare[0] === bare[1] || actsOnMe)) return { who: "self", explicit: false, gap: "" }; // 我婆婆 超煩的
      return { who, explicit: who === "self", gap: "" };
    }
    return { who: "self", explicit: false, gap: prefix };
  }
  const gap = prefix.slice((last.index ?? 0) + last[0].length);
  const who = whoIs(last[0]);
  if (who !== "other") return { who, explicit: who === "self", gap };
  // 別人後面接著別的事，感受是講話的人的（我老公都不做家事好累）
  if (!ADVERBIAL_GAP.test(gap)) return { who: "self", explicit: false, gap };
  // 嫌別人煩（我媽好煩、我覺得我媽好煩）是講話的人在煩；轉述的（我媽說她很煩、我媽覺得很煩）是別人在煩；
  // 隔著時間（我女兒最近很煩）是在講那個人的狀態，除非整句有那個人對「我」做的事（我媽最近好煩 一直逼我結婚）
  const reported = REPORTED_BEFORE.test(prefix.slice(0, last.index ?? 0)) || REPORTED_GAP.test(gap);
  if (annoyed && !reported && (EMPHASIS_GAP.test(gap) || actsOnMe)) return { who: "self", explicit: false, gap };
  return { who, explicit: false, gap };
}

/** 正反問：好不好受、開不開心、爽不爽——「不」前後是同一個字 */
function aNotA(prefix: string, feeling: string): boolean {
  const joined = prefix + feeling;
  for (let i = prefix.length; i < joined.length; i += 1) {
    if (joined[i] === "不" && i > 0 && joined[i - 1] === joined[i + 1]) return true;
  }
  return false;
}

/**
 * 訪客這一句是不是在抒發自己的負面情緒。是的話回命中的那段感受（給 log 與測試看），不是回 null。
 */
export function detectVenting(message: string): string | null {
  if (!message.trim() || detectCrisis(message)) return null;
  const text = toTraditional(message).replace(PARTICLE_GAP, "");
  const clauses: Clause[] = Array.from(text.matchAll(CLAUSE), (m) => ({ text: m[0], start: m.index ?? 0 }));
  // 判準 8：問她的往事、問她的年代或婦運、看到聽到她講的事
  if (ASKS_HER_PAST.test(text) || REACTS_TO_HER.test(text)) return null;
  if (clauses.some((c) => ERA_OR_TOPIC.test(c.text) && QUESTION_WORD.test(c.text))) return null;
  // 判準 7：沒有明講「我」的感受，整句在講她的年代或婦運、問怎麼幫別人時不算
  const notMine =
    ERA_OR_TOPIC.test(text) ||
    COMFORTS_OTHERS.test(text) ||
    (HELPS_OTHERS.test(text) && !SELF_STRUGGLE.test(text)) ||
    (ASKS_VIEW.test(text) && !MENTIONS_SELF.test(text));
  const mentionsHer = new RegExp(HER).test(text);
  const actsOnMe = ACTS_ON_ME.test(text);

  for (let ci = 0; ci < clauses.length; ci += 1) {
    const clause = clauses[ci];
    for (const m of Array.from(clause.text.matchAll(FEELING))) {
      const at = m.index ?? 0;
      const prefix = clause.text.slice(0, at);
      const after = clause.text.slice(at + m[0].length);
      // 「氣死我了」「很討厭我嗎」：受詞「我」後面才是語氣詞或問句
      const tail = AFFECTS_ME.test(after) ? after.replace(OBJECT_ME, "") : after;
      const rest = tail.replace(TAIL_PARTICLES, "");
      // 子句後面第一個不是空白的字（「寫作很累 ?」）
      const closing = text.slice(clause.start + clause.text.length).replace(/^[ \u3000]+/, "")[0] ?? "";

      // 判準 5、6：否定、假設、在問、修飾
      if (NEGATED.test(prefix) || HYPOTHETICAL.test(prefix) || ASKS_BEFORE.test(prefix)) continue;
      if (!prefix && ASKS_AT_END.test(clauses[ci - 1]?.text ?? "")) continue; // 「妳 會不會 很累」
      if (MODIFIER_AFTER.test(tail) || ASKS_AFTER.test(rest) || aNotA(prefix, m[0])) continue;
      if (after.startsWith(`不${m[0].slice(-1)}`)) continue; // 正反問：壓力大不大
      if (!rest && /[？?]/.test(closing)) continue;
      if (m[0].includes("哭") && MOVED.test(text)) continue;
      // 判準 8：被她的故事觸動（感受所在的子句或前一段提到她的故事）、叫了她之後說「聽了好難過」
      if (HER_STORY.test(prefix) || HER_STORY.test(clauses[ci - 1]?.text ?? "")) continue;
      if (mentionsHer && REACTION.test(prefix)) continue;

      // 判準 4、6（推測）、7
      const { who, explicit, gap } = experiencer(prefix, clauses[ci - 1], m[0], after, actsOnMe);
      if (who !== "self") continue;
      if (!explicit && PRESUMED.test(prefix)) continue;
      if (explicit ? ERA_OR_TOPIC.test(gap) : notMine) continue;
      return m[0];
    }
  }
  return null;
}
