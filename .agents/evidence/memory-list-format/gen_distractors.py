import json, os, random, re, ssl, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
HERE = os.path.dirname(os.path.abspath(__file__))
URL = "https://opencode.ai/inference/go/v1/chat/completions"
CTX = ssl.create_default_context(cafile=os.environ.get("SSL_CERT_FILE", "/root/.ccr/ca-bundle.crt"))
THEMES = [
    ("人物", "主人认识的其他人：老同学、前同事、朋友、亲戚、邻居、网友，每条写一个人的一件具体事（职业、住哪、爱好、和主人的交情、上次见面做了什么）"),
    ("人物", "主人求职圈和技术圈认识的人：猎头、面过他的面试官以外的业内朋友、开源项目维护者、学长学姐，每条一个具体事实"),
    ("偏好", "主人在穿衣、购物、旅行、看剧、读新闻、用App、写作风格、沟通方式上的具体偏好"),
    ("偏好", "主人对餐厅、零食、饮料（不含咖啡）、甜点、做饭方式的具体偏好"),
    ("健康", "主人的运动（不含跑步）、体态、皮肤、牙齿以外的小毛病、看过的医生、吃过的维生素等具体健康信息"),
    ("项目", "主人在做的 Himawari 个人 AI 助理项目的技术细节：架构、遇到的 bug、用过的库、部署、设计取舍"),
    ("项目", "主人的其他副业和学习计划：开源贡献、读过的论文、做过的小工具、课程"),
    ("工作", "主人过去的实习和工作经历、做过的项目、学到的技能、写过的技术文章"),
    ("财务", "主人的订阅服务、保险、银行账户用途、报销、大件消费、记账习惯"),
    ("日程", "主人每周和每年的固定活动（不含睡觉、约会、写代码时间），以及过去发生过的具体事件和日期"),
    ("地点", "主人去过的城市、常去的店（不含咖啡店、健身房、超市）、搬家史、喜欢的散步路线"),
    ("设备", "主人的相机镜头、显示器、键盘、平板、智能家居、充电器、软件订阅等设备细节（不含手机和电脑内存）"),
    ("兴趣", "主人看过的电影和剧、玩过的游戏、拍照去过的地方、关注的体育赛事和博主"),
    ("兴趣", "主人的收藏、手工、语言学习（不含日语考试）、旅行愿望清单"),
]
FORBID = ["Mika", "咖啡", "过敏", "睡", "出生", "生日", "北海道", "鼻炎", "牙", "面试", "房租", "转账", "手机", "JLPT", "N1", "香菜", "血型", "孩子", "护照", "跑步", "投了", "年薪", "近视", "隐形眼镜", "套餐", "周杰伦", "米津", "世田谷", "健身房", "困", "推荐人", "妹妹", "小雨", "简历", "推送", "喝水", "三体", "存款", "内存", "可能", "好像", "也许", "待确认", "女朋友", "饭局", "妈妈"]
PROMPT = "为一个测试数据集编写关于“主人”（一位住东京、在找AI产品工作的中国留学生Andy）的长期记忆条目。主题：{theme}。\n要求：写 {n} 条，每条一行，只写记忆内容本身，不加编号或符号；每条是一个确定的事实，12 到 30 个字，像个人助理笔记本里的一行；内容具体、互不重复；其中约十分之一以数字开头（例如“3年前…”“2023年…”）。不要写任何不确定的说法。不要提到这些词：" + "、".join(FORBID) + "。只输出这些行。"

def call(theme, n, seed):
    body = json.dumps({"model": "deepseek-v4.1-flash", "temperature": 1.0, "max_tokens": 4000, "thinking": {"type": "disabled"},
        "messages": [{"role": "user", "content": PROMPT.format(theme=theme, n=n) + f"\n（批次 {seed}）"}]}).encode()
    for attempt in range(6):
        try:
            req = urllib.request.Request(URL, data=body, headers={"Authorization": "Bearer dummy", "Content-Type": "application/json", "x-opencode-session": f"memfmt-gen-{seed}", "User-Agent": "curl/8.5.0"})
            with urllib.request.urlopen(req, context=CTX, timeout=180) as r:
                return json.load(r)["choices"][0]["message"].get("content") or ""
        except Exception as e:
            print("retry", seed, attempt, e, flush=True)
            time.sleep(15 * (attempt + 1))
    return ""

jobs = [(c, t, s) for s in range(int(os.environ.get("BATCHES", "2"))) for c, t in THEMES]
def one(j):
    out = (j[0], call(j[1], 40, f"b{j[2]}-t{THEMES.index((j[0], j[1]))}"))
    print("done", j[0], j[2], len(out[1].splitlines()), flush=True)
    return out
with ThreadPoolExecutor(max_workers=int(os.environ.get("WORKERS", "4"))) as ex:
    outs = list(ex.map(one, jobs))
seen, items = set(), []
for cat, text in outs:
    for line in text.splitlines():
        line = re.sub(r"^\s*(?:[-*•]|\d+[.、)])\s*", "", line).strip()
        if not (8 <= len(line) <= 40) or "\t" in line or line in seen:
            continue
        if any(w in line for w in FORBID):
            continue
        seen.add(line)
        items.append((cat, line))
json.dump(items, open(os.path.join(HERE, "distractors.json"), "w"), ensure_ascii=False, indent=0)
print(len(items))
