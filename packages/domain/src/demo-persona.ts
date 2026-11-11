export const DEMO_LOCALES = ["ja", "en"] as const;

export type DemoLocale = (typeof DEMO_LOCALES)[number];

export const DEMO_OWNER_ADDRESS = "demo@himawari.example";

export const DEMO_TIME_ZONES: Readonly<Record<DemoLocale, string>> = Object.freeze({
  ja: "Asia/Tokyo",
  en: "America/Los_Angeles",
});

export function isDemoLocale(value: unknown): value is DemoLocale {
  return typeof value === "string" && (DEMO_LOCALES as readonly string[]).includes(value);
}

type Localized<T> = { readonly [locale in DemoLocale]: T };

const both = <T>(ja: T, en: T): Localized<T> => Object.freeze({ ja, en });

export interface DemoPerson {
  readonly key: string;
  readonly name: string;
  readonly relation: string;
  readonly reverseRelation: string;
  readonly aliases: readonly string[];
}

export interface DemoMemory {
  readonly key: string;
  readonly category:
    | "identity"
    | "preference"
    | "relationship"
    | "goal"
    | "project"
    | "event"
    | "other";
  readonly text: string;
  readonly importancePermille: number;
  readonly confidencePermille: number;
  readonly daysAgo: number;
  readonly entities: readonly string[];
  readonly people: readonly string[];
  readonly pinned: boolean;
  readonly inference: boolean;
  readonly tentative: boolean;
  readonly replacedBy: string | null;
  readonly updates: readonly { readonly daysAgo: number; readonly text: string }[];
}

export interface DemoMail {
  readonly key: string;
  readonly threadKey: string;
  readonly offsetMinutes: number;
  readonly fromName: string;
  readonly fromAddress: string;
  readonly subject: string;
  readonly body: string;
  readonly categories: readonly ("promotions" | "social" | "forums" | "updates")[];
  readonly sentByOwner: boolean;
  readonly participants: readonly string[];
}

interface MemorySpec {
  readonly key: string;
  readonly category: DemoMemory["category"];
  readonly text: Localized<string>;
  readonly importance: number;
  readonly confidence?: number;
  readonly daysAgo: number;
  readonly entities?: Localized<readonly string[]>;
  readonly people?: readonly string[];
  readonly pinned?: boolean;
  readonly inference?: boolean;
  readonly tentative?: boolean;
  readonly replacedBy?: string;
  readonly updates?: readonly { readonly daysAgo: number; readonly text: Localized<string> }[];
}

interface PersonSpec {
  readonly key: string;
  readonly name: Localized<string>;
  readonly relation: Localized<string>;
  readonly reverseRelation: Localized<string>;
  readonly aliases: Localized<readonly string[]>;
}

interface MailSpec {
  readonly key: string;
  readonly threadKey: string;
  readonly offsetMinutes: number;
  readonly from: Localized<{ readonly name: string; readonly address: string }>;
  readonly subject: Localized<string>;
  readonly body: Localized<string>;
  readonly categories?: DemoMail["categories"];
  readonly sentByOwner?: boolean;
  readonly participants?: readonly string[];
}

const PERSON_SPECS: readonly PersonSpec[] = [
  {
    key: "ken",
    name: both("山本 健", "Priya Nair"),
    relation: both("同僚", "coworker"),
    reverseRelation: both("同僚", "coworker"),
    aliases: both(["山本さん", "健さん"], ["Priya"]),
  },
  {
    key: "misaki",
    name: both("佐藤 美咲", "Jordan Reyes"),
    relation: both("妹", "sister"),
    reverseRelation: both("姉", "sibling"),
    aliases: both(["美咲"], ["Jordan"]),
  },
  {
    key: "nakamura",
    name: both("中村 凛", "Sam Whitfield"),
    relation: both("友人", "friend"),
    reverseRelation: both("友人", "friend"),
    aliases: both(["中村さん", "凛さん"], ["Sam"]),
  },
];

const MEMORY_SPECS: readonly MemorySpec[] = [
  {
    key: "job",
    category: "identity",
    text: both(
      "オーナーは中規模のソフトウェア会社でプロダクトデザイナーとして働き、スマートフォンアプリの画面設計を担当している。",
      "The owner works as a product designer at a mid-size software company, designing mobile app screens.",
    ),
    importance: 900,
    daysAgo: 120,
    entities: both(["プロダクトデザイナー"], ["product designer"]),
    pinned: true,
  },
  {
    key: "home",
    category: "identity",
    text: both(
      "オーナーは福岡市に住んでいて、通勤は地下鉄で約25分。",
      "The owner lives in Portland and commutes to work by light rail, about 25 minutes each way.",
    ),
    importance: 700,
    daysAgo: 120,
    entities: both(["福岡"], ["Portland"]),
    pinned: true,
  },
  {
    key: "cat",
    category: "identity",
    text: both(
      "オーナーは「もなか」という名前の三毛猫を3年前から飼っている。",
      "The owner has had a calico cat named Biscuit for three years.",
    ),
    importance: 600,
    daysAgo: 100,
    entities: both(["もなか", "猫"], ["Biscuit", "cat"]),
    updates: [
      {
        daysAgo: 20,
        text: both(
          "もなかは先月から療法食に切り替えた。夕方の餌は18時。",
          "Biscuit switched to a prescription diet last month. Dinner is at 6 pm.",
        ),
      },
    ],
  },
  {
    key: "coffee",
    category: "preference",
    text: both(
      "オーナーはコーヒーを浅煎りのブラックで飲むのが好き。",
      "The owner prefers light-roast coffee, black.",
    ),
    importance: 400,
    daysAgo: 90,
    entities: both(["コーヒー"], ["coffee"]),
  },
  {
    key: "materials",
    category: "preference",
    text: both(
      "オーナーは会議の資料を前日までに共有してもらえると助かると考えている。",
      "The owner likes meeting materials to be shared the day before.",
    ),
    importance: 650,
    daysAgo: 80,
    entities: both(["会議", "資料"], ["meetings", "materials"]),
  },
  {
    key: "night",
    category: "preference",
    text: both(
      "オーナーは夜10時以降の通知を望まない。",
      "The owner does not want notifications after 10 pm.",
    ),
    importance: 800,
    daysAgo: 70,
    entities: both(["通知"], ["notifications"]),
  },
  {
    key: "sister",
    category: "relationship",
    text: both(
      "オーナーの妹の美咲は大阪に住んでいて、誕生日は11月。",
      "The owner's sister Jordan lives in Seattle, and her birthday is in November.",
    ),
    importance: 750,
    daysAgo: 110,
    entities: both(["美咲", "大阪"], ["Jordan", "Seattle"]),
    people: ["misaki"],
  },
  {
    key: "lead",
    category: "relationship",
    text: both(
      "山本健はAoba リニューアルのリーダーで、オーナーは毎週金曜に進み具合を共有している。",
      "Priya Nair leads the Harbor app redesign, and the owner shares progress with her every Friday.",
    ),
    importance: 850,
    daysAgo: 60,
    entities: both(["Aoba リニューアル", "山本健"], ["Harbor app redesign", "Priya Nair"]),
    people: ["ken"],
  },
  {
    key: "studio",
    category: "relationship",
    text: both(
      "友人の中村凛は陶芸工房を営んでいて、オーナーは土曜にそこの教室に通っている。",
      "The owner's friend Sam Whitfield runs a ceramics studio, and the owner takes a class there on Saturdays.",
    ),
    importance: 550,
    daysAgo: 95,
    entities: both(["陶芸", "工房"], ["ceramics", "studio"]),
    people: ["nakamura"],
  },
  {
    key: "project",
    category: "project",
    text: both(
      "Aoba リニューアルでは、今月末までにエンジニアへ画面デザインを引き渡す予定。",
      "For the Harbor app redesign, the owner plans to hand the screen designs to engineering by the end of this month.",
    ),
    importance: 900,
    daysAgo: 30,
    entities: both(
      ["Aoba リニューアル", "デザイン引き渡し"],
      ["Harbor app redesign", "design handoff"],
    ),
    people: ["ken"],
    updates: [
      {
        daysAgo: 7,
        text: both(
          "Aoba リニューアルの引き渡し対象は、ホームと設定の2画面を先に出す形に絞った。",
          "For the Harbor redesign handoff, the owner narrowed the first delivery to the home and settings screens.",
        ),
      },
    ],
  },
  {
    key: "review",
    category: "project",
    text: both(
      "デザインレビューは毎週金曜の15時にある。",
      "The weekly design review is every Friday at 3 pm.",
    ),
    importance: 700,
    daysAgo: 60,
    entities: both(["デザインレビュー"], ["design review"]),
    people: ["ken"],
  },
  {
    key: "marathon",
    category: "goal",
    text: both(
      "オーナーは来年3月のフルマラソン完走を目指して、週3回、朝6時半に走っている。",
      "The owner is training to finish a full marathon next March, running three mornings a week at 6:30.",
    ),
    importance: 800,
    daysAgo: 45,
    entities: both(["フルマラソン"], ["marathon"]),
  },
  {
    key: "mugs",
    category: "goal",
    text: both(
      "オーナーは陶芸で、同じ形のマグカップを4つ作れるようになりたい。",
      "The owner wants to get good enough at pottery to make a matching set of four mugs.",
    ),
    importance: 450,
    daysAgo: 40,
    entities: both(["陶芸", "マグカップ"], ["pottery", "mugs"]),
    people: ["nakamura"],
  },
  {
    key: "gym-old",
    category: "event",
    text: both(
      "オーナーは月曜の夜にジムに通っている。",
      "The owner goes to the gym on Monday evenings.",
    ),
    importance: 300,
    daysAgo: 85,
    entities: both(["ジム"], ["gym"]),
    replacedBy: "gym",
  },
  {
    key: "gym",
    category: "event",
    text: both(
      "オーナーはジムの日を月曜から水曜の夜に変えた。月曜は残業が多いため。",
      "The owner moved the gym day from Monday to Wednesday evening because Mondays often run late.",
    ),
    importance: 300,
    daysAgo: 25,
    entities: both(["ジム"], ["gym"]),
  },
  {
    key: "music",
    category: "preference",
    text: both(
      "オーナーは作業中にクラシック音楽を聴くことが多いようだ。",
      "The owner seems to listen to classical music while working.",
    ),
    importance: 250,
    confidence: 550,
    daysAgo: 3,
    entities: both(["クラシック音楽"], ["classical music"]),
    inference: true,
    tentative: true,
  },
];

const MAIL_SPECS: readonly MailSpec[] = [
  {
    key: "order",
    threadKey: "order",
    offsetMinutes: -2 * 1440 - 180,
    from: both(
      { name: "つむぎ雑貨店", address: "shop@tsumugi-zakka.example" },
      { name: "Willow & Pine Goods", address: "orders@willowpine.example" },
    ),
    subject: both(
      "ご注文ありがとうございます（注文番号 TZ-48213907）",
      "Thanks for your order (order number WP-48213907)",
    ),
    body: both(
      "オーナー様\n\nご注文を承りました。\n\n注文番号：TZ-48213907\n商品：手ぬぐいセット（2枚）\nお届け予定：{day+2}\n\n発送が完了しましたらあらためてご連絡します。\n\nつむぎ雑貨店",
      "Hi there,\n\nWe've received your order.\n\nOrder number: WP-48213907\nItems: linen tea towel set (2)\nExpected delivery: {day+2}\n\nWe'll email you again as soon as it ships.\n\nWillow & Pine Goods",
    ),
    categories: ["updates"],
  },
  {
    key: "review-moved",
    threadKey: "review",
    offsetMinutes: -2 * 1440,
    from: both(
      { name: "山本 健", address: "ken.yamamoto@aoba-soft.example" },
      { name: "Priya Nair", address: "priya.nair@harborapps.example" },
    ),
    subject: both(
      "金曜のデザインレビュー、16時に変更できますか",
      "Can we move Friday's design review to 4 pm?",
    ),
    body: both(
      "お疲れさまです。山本です。\n\n金曜のデザインレビューですが、別件が入ったので15時から16時に変更できないでしょうか。難しければそのままで大丈夫です。\n\n山本",
      "Hi,\n\nSomething came up on my side. Could we move Friday's design review from 3 pm to 4 pm? If that's hard for you, 3 pm still works.\n\nPriya",
    ),
    participants: ["ken.yamamoto@aoba-soft.example", "priya.nair@harborapps.example"],
  },
  {
    key: "review-ok",
    threadKey: "review",
    offsetMinutes: -2 * 1440 + 90,
    from: both(
      { name: "オーナー", address: "demo@himawari.example" },
      { name: "Demo Owner", address: "demo@himawari.example" },
    ),
    subject: both(
      "Re: 金曜のデザインレビュー、16時に変更できますか",
      "Re: Can we move Friday's design review to 4 pm?",
    ),
    body: both(
      "山本さん\n\n16時で大丈夫です。変更しておきます。\n\n",
      "Priya,\n\n4 pm works for me. I'll update the invite.\n\n",
    ),
    sentByOwner: true,
    participants: ["ken.yamamoto@aoba-soft.example", "priya.nair@harborapps.example"],
  },
  {
    key: "newsletter",
    threadKey: "newsletter",
    offsetMinutes: -1500,
    from: both(
      { name: "週刊デザインノート", address: "digest@design-note.example" },
      { name: "Design Weekly", address: "digest@designweekly.example" },
    ),
    subject: both(
      "今週のデザイン記事まとめ：余白とタイポグラフィ",
      "This week in design: whitespace and typography",
    ),
    body: both(
      "今週のおすすめ記事です。\n\n1. 余白で見せる情報の優先順位\n2. 日本語タイポグラフィの基本\n3. 小さな画面のナビゲーション事例\n\n配信停止はこちら。",
      "This week's picks:\n\n1. Using whitespace to rank information\n2. Typography basics for mobile\n3. Navigation patterns on small screens\n\nUnsubscribe anytime.",
    ),
    categories: ["promotions"],
  },
  {
    key: "mockups",
    threadKey: "review",
    offsetMinutes: 5,
    from: both(
      { name: "山本 健", address: "ken.yamamoto@aoba-soft.example" },
      { name: "Priya Nair", address: "priya.nair@harborapps.example" },
    ),
    subject: both(
      "Re: 金曜のデザインレビュー、16時に変更できますか",
      "Re: Can we move Friday's design review to 4 pm?",
    ),
    body: both(
      "ありがとうございます、16時で押さえました。\n\n一つお願いがあります。レビューの前に、エンジニアが先に見られるよう、ホームと設定の最終モックを明後日の正午までに共有フォルダに入れてもらえませんか。\n\n山本",
      "Thanks, I've booked 4 pm.\n\nOne request: so engineering can look before the review, could you put the final mockups for the home and settings screens in the shared folder by noon the day after tomorrow?\n\nPriya",
    ),
    participants: ["demo@himawari.example", "priya.nair@harborapps.example"],
  },
  {
    key: "delivery",
    threadKey: "order",
    offsetMinutes: 30,
    from: both(
      { name: "ハコビ宅配", address: "notice@hakobi-delivery.example" },
      { name: "SwiftLane Delivery", address: "notice@swiftlane.example" },
    ),
    subject: both(
      "お荷物の再配達について（注文番号 TZ-48213907）",
      "Your package missed delivery (order number WP-48213907)",
    ),
    body: both(
      "ご不在のため、お荷物をお届けできませんでした。\n\n注文番号：TZ-48213907\n再配達のご希望は、本日15時までにこちらからご連絡ください。ご連絡がない場合は明日の18時から20時にお届けします。",
      "We couldn't deliver your package because nobody was available.\n\nOrder number: WP-48213907\nTo choose a new time, please respond by 3 pm today. Otherwise we'll try again tomorrow between 6 pm and 8 pm.",
    ),
    categories: ["updates"],
  },
  {
    key: "sale",
    threadKey: "sale",
    offsetMinutes: 70,
    from: both(
      { name: "ミナト百貨店", address: "campaign@minato-store.example" },
      { name: "Lakeside Mall", address: "offers@lakesidemall.example" },
    ),
    subject: both(
      "【本日限定】全品20%OFF、お見逃しなく",
      "Today only: 20% off everything, don't miss it",
    ),
    body: both(
      "本日限定のセールを開催中です。人気商品は数に限りがあります。今すぐチェック！",
      "Our sale is on today only. Popular items are going fast. Take a look now.",
    ),
    categories: ["promotions"],
  },
  {
    key: "security",
    threadKey: "security",
    offsetMinutes: 200,
    from: both(
      { name: "アカウントセキュリティ", address: "no-reply@accounts-secure.example" },
      { name: "Account Security", address: "no-reply@accounts-secure.example" },
    ),
    subject: both(
      "新しい端末からのログインがありました",
      "New sign-in from an unrecognized device",
    ),
    body: both(
      "お使いのアカウントに、見覚えのない端末からログインがありました。\n\n心当たりがない場合は、パスワードを変更してください。心当たりがある場合は、このメールは無視して構いません。",
      "Your account was signed in to from a device we don't recognize.\n\nIf this wasn't you, change your password. If it was you, you can ignore this message.",
    ),
    categories: ["updates"],
  },
  {
    key: "dinner",
    threadKey: "dinner",
    offsetMinutes: 1440 + 120,
    from: both(
      { name: "佐藤 美咲", address: "misaki.sato@family.example" },
      { name: "Jordan Reyes", address: "jordan.reyes@family.example" },
    ),
    subject: both("誕生日ごはん、土曜の夜どう？", "Birthday dinner on Saturday?"),
    body: both(
      "ねえ、今度の土曜の夜、誕生日のごはんに付き合ってくれない？駅の近くのお店を予約したいから、都合がよければ明日の夜までに返事ちょうだい。\n\n美咲",
      "Hey,\n\nWould you be free for my birthday dinner this Saturday evening? I'd like to book a place near the station, so can you let me know by tomorrow night?\n\nJordan",
    ),
    participants: ["demo@himawari.example", "misaki.sato@family.example"],
  },
  {
    key: "invoice",
    threadKey: "invoice",
    offsetMinutes: 1440 + 300,
    from: both(
      { name: "コワーキングスペース ひなた", address: "billing@hinata-space.example" },
      { name: "Daybreak Coworking", address: "billing@daybreak.example" },
    ),
    subject: both(
      "今月分のご利用料金のお知らせ（請求番号 HN-20193384）",
      "Your monthly invoice is ready (invoice number DB-20193384)",
    ),
    body: both(
      "今月分のご利用料金をご案内します。\n\n請求番号：HN-20193384\nお支払い期限：{day+4}\n\nお支払い方法の変更は、マイページからお手続きください。",
      "Your monthly invoice is ready.\n\nInvoice number: DB-20193384\nPayment due: {day+4}\n\nTo change how you pay, open your account page.",
    ),
    categories: ["updates"],
  },
  {
    key: "run-club",
    threadKey: "run",
    offsetMinutes: 2 * 1440 + 60,
    from: both(
      { name: "中村 凛", address: "rin.nakamura@studio.example" },
      { name: "Sam Whitfield", address: "sam.whitfield@studio.example" },
    ),
    subject: both("日曜の朝ラン、7時に公園集合", "Sunday morning run, meet at the park at 7"),
    body: both(
      "日曜の朝、7時に川沿いの公園で集まって走ります。ペースはゆっくりめ。来られそうなら一言ください。\n\n凛",
      "A few of us are running Sunday morning at 7, meeting at the riverside park. Easy pace. Let me know if you can make it.\n\nSam",
    ),
    categories: ["social"],
    participants: ["demo@himawari.example", "rin.nakamura@studio.example"],
  },
  {
    key: "feedback",
    threadKey: "feedback",
    offsetMinutes: 3 * 1440 + 90,
    from: both(
      { name: "山本 健", address: "ken.yamamoto@aoba-soft.example" },
      { name: "Priya Nair", address: "priya.nair@harborapps.example" },
    ),
    subject: both("レビューのフィードバックをまとめました", "Design review feedback, summarized"),
    body: both(
      "金曜のレビューで出た意見をまとめました。大きな変更はなく、設定画面の文言だけ調整が必要です。来週の水曜までに反映版をもらえれば間に合います。\n\n山本",
      "Here's the summary from Friday's review. No big changes, only the copy on the settings screen needs adjusting. If I can have the updated version by Wednesday next week, we'll stay on schedule.\n\nPriya",
    ),
    participants: ["demo@himawari.example", "ken.yamamoto@aoba-soft.example"],
  },
  {
    key: "library",
    threadKey: "library",
    offsetMinutes: 5 * 1440 + 30,
    from: both(
      { name: "市立図書館", address: "info@city-library.example" },
      { name: "City Library", address: "info@citylibrary.example" },
    ),
    subject: both("貸出期限が近づいています", "Your borrowed items are due soon"),
    body: both(
      "お借りの資料「釉薬の基本」の返却期限が{day+2}です。延長は貸出ページから一度だけできます。",
      'Your borrowed item "The Glaze Handbook" is due on {day+2}. You can renew it once from your account page.',
    ),
    categories: ["updates"],
  },
];

export function demoPeople(locale: DemoLocale): readonly DemoPerson[] {
  return PERSON_SPECS.map((person) =>
    Object.freeze({
      key: person.key,
      name: person.name[locale],
      relation: person.relation[locale],
      reverseRelation: person.reverseRelation[locale],
      aliases: person.aliases[locale],
    }),
  );
}

export function demoMemories(locale: DemoLocale): readonly DemoMemory[] {
  return MEMORY_SPECS.map((memory) =>
    Object.freeze({
      key: memory.key,
      category: memory.category,
      text: memory.text[locale],
      importancePermille: memory.importance,
      confidencePermille: memory.confidence ?? 950,
      daysAgo: memory.daysAgo,
      entities: memory.entities?.[locale] ?? [],
      people: memory.people ?? [],
      pinned: memory.pinned ?? false,
      inference: memory.inference ?? false,
      tentative: memory.tentative ?? false,
      replacedBy: memory.replacedBy ?? null,
      updates: (memory.updates ?? []).map((update) => ({
        daysAgo: update.daysAgo,
        text: update.text[locale],
      })),
    }),
  );
}

const MONTHS_EN = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function localDate(locale: DemoLocale, timeZone: string, instantMs: number, days: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date(instantMs));
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value ?? "1");
  const shifted = new Date(Date.UTC(part("year"), part("month") - 1, part("day") + days));
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  return locale === "ja" ? `${month}月${day}日` : `${MONTHS_EN[month - 1]} ${day}`;
}

export function demoMailScript(
  locale: DemoLocale,
  anchor: string,
  timeZone: string = DEMO_TIME_ZONES[locale],
): readonly DemoMail[] {
  const anchorMs = Date.parse(anchor);
  return MAIL_SPECS.map((mail) => {
    const arrivalMs = anchorMs + mail.offsetMinutes * 60_000;
    const render = (text: string) =>
      text.replace(/\{day\+(\d+)\}/gu, (_whole, days: string) =>
        localDate(locale, timeZone, arrivalMs, Number(days)),
      );
    return Object.freeze({
      key: mail.key,
      threadKey: mail.threadKey,
      offsetMinutes: mail.offsetMinutes,
      fromName: mail.from[locale].name,
      fromAddress: mail.from[locale].address,
      subject: render(mail.subject[locale]),
      body: render(mail.body[locale]),
      categories: mail.categories ?? [],
      sentByOwner: mail.sentByOwner ?? false,
      participants: mail.participants ?? [],
    });
  });
}
