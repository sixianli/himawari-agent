import Foundation

extension M {
    static var transferTitle: String { text("导出和导入", ja: "エクスポートとインポート", en: "Export and import") }

    static var exportGroup: String { text("导出", ja: "エクスポート", en: "Export") }
    static var exportAction: String { text("导出记忆和规则", ja: "記憶とルールをエクスポート", en: "Export memories and rules") }
    static var exportNote: String {
        text(
            "得到一个压缩包：逐条的数据，加上能直接读的 Markdown。密码、证件号等机密只留占位符，其余是明文，请妥善保管。",
            ja: "ZIP ファイルになります。項目ごとのデータと、そのまま読める Markdown が入っています。パスワードや身分証番号などの機密はプレースホルダーだけを残し、それ以外は平文なので大切に保管してください。",
            en: "You get a ZIP file with item-by-item data and readable Markdown. Passwords, ID numbers and other secrets are left as placeholders; everything else is plain text, so keep it safe."
        )
    }
    static var exportWorking: String { text("正在生成导出文件……", ja: "エクスポートファイルを作成しています……", en: "Preparing the export…") }
    static func exportProgress(read: Int, total: Int) -> String {
        text("已读 \(read) / \(total) 段文字", ja: "\(total) 件中 \(read) 件を読み込み済み", en: "Read \(read) of \(total) texts")
    }
    static func exportDone(memories: Int, rules: Int, withheld: Int) -> String {
        text(
            "已导出 \(memories) 条记忆、\(rules) 条正在执行的规则；\(withheld) 处机密只留了占位符。",
            ja: "記憶 \(memories) 件と実行中のルール \(rules) 件をエクスポートしました。機密 \(withheld) か所はプレースホルダーだけです。",
            en: "Exported \(memories) memories and \(rules) active rules; \(withheld) secrets were left as placeholders."
        )
    }
    static var exportSave: String { text("存到文件", ja: "ファイルに保存", en: "Save to Files") }
    static var exportSaved: String { text("已保存", ja: "保存しました", en: "Saved") }
    static var exportFailed: String { text("导出失败，请稍后再试。", ja: "エクスポートできませんでした。しばらくしてからもう一度お試しください。", en: "The export failed. Try again later.") }
    static var confirmExport: String { text("导出记忆和规则", ja: "記憶とルールをエクスポート", en: "Export memories and rules") }

    static var importGroup: String { text("导入记忆", ja: "記憶をインポート", en: "Import memories") }
    static func importSource(_ source: MemoryImportSource) -> String {
        switch source {
        case .codex: text("Codex 的记忆文件", ja: "Codex の記憶ファイル", en: "Codex memory files")
        case .assistant: text("ChatGPT、Claude 等其他 AI", ja: "ChatGPT、Claude など他の AI", en: "ChatGPT, Claude and other AIs")
        case .himawari: text("以前导出的 JSON 文件", ja: "以前エクスポートした JSON ファイル", en: "An earlier JSON export")
        }
    }
    static func importSourceHelp(_ source: MemoryImportSource) -> String {
        switch source {
        case .codex:
            text(
                "选 memory_summary.md、MEMORY.md，也可以加上 AGENTS.md，可以多选",
                ja: "memory_summary.md、MEMORY.md を選びます。AGENTS.md も追加でき、複数選択できます",
                en: "Pick memory_summary.md and MEMORY.md, and AGENTS.md if you like. You can pick several"
            )
        case .assistant:
            text("让它把关于你的记忆列出来，再贴到这里", ja: "あなたについての記憶を書き出してもらい、ここに貼り付けます", en: "Ask it to list what it remembers about you, then paste it here")
        case .himawari:
            text(
                "只认以前下载的 himawari-memories.json；现在导出的压缩包不能在这里导入",
                ja: "以前ダウンロードした himawari-memories.json だけです。今のエクスポートの ZIP はここではインポートできません",
                en: "Only the himawari-memories.json downloaded earlier. Today's ZIP export can't be imported here"
            )
        }
    }
    static var aiStep1: String { text("第 1 步：复制下面这段话，发给你在用的 AI。", ja: "ステップ 1：下の文をコピーして、使っている AI に送ります。", en: "Step 1: Copy the text below and send it to the AI you use.") }
    static var aiPrompt: String {
        text(
            "请把你记住的关于我的所有信息逐条列出来，包括我的身份、偏好、习惯、正在做的事、身边的人，以及我对你提过的做事要求。每条一行，以“- ”开头，尽量用我当时的原话。不要列出密码、证件号、银行卡号这类信息。只列信息，不要加解释。",
            ja: "あなたが覚えている私についての情報を、1 行に 1 つずつすべて書き出してください。私の身元、好み、習慣、取り組んでいること、身近な人、あなたへの頼み方も含めます。各行は「- 」で始め、できるだけ私の言葉どおりに書いてください。パスワード、身分証番号、カード番号のような情報は書かないでください。説明は付けず、情報だけを書いてください。",
            en: "List everything you remember about me, one item per line: who I am, my preferences, habits, what I'm working on, the people around me, and how I've asked you to do things. Start each line with \"- \" and use my own words where you can. Leave out passwords, ID numbers and card numbers. Only list the facts, no explanations."
        )
    }
    static var copyPrompt: String { text("复制这段话", ja: "この文をコピー", en: "Copy this text") }
    static var copied: String { text("已复制", ja: "コピーしました", en: "Copied") }
    static var aiStep2: String { text("第 2 步：把它的回答整段贴到这里。", ja: "ステップ 2：その回答をまるごとここに貼り付けます。", en: "Step 2: Paste its whole answer here.") }
    static var splitIntoItems: String { text("拆成一条条", ja: "項目に分ける", en: "Split into items") }
    static var importReading: String { text("正在拆分、分类、核对是否已经记着……", ja: "分けて、分類して、もう覚えているか確かめています……", en: "Splitting, sorting and checking what's already remembered…") }
    static func importSummary(found: Int, shown: Int, on: Int) -> String {
        if found > shown {
            return text(
                "找到 \(found) 条，这次列出前 \(shown) 条，已勾 \(on) 条",
                ja: "\(found) 件見つかり、最初の \(shown) 件を表示、\(on) 件にチェック",
                en: "Found \(found), showing the first \(shown), \(on) ticked"
            )
        }
        return text("找到 \(found) 条，已勾 \(on) 条", ja: "\(found) 件見つかり、\(on) 件にチェック", en: "Found \(found), \(on) ticked")
    }
    static func importFlag(_ flag: String) -> String? {
        switch flag {
        case "duplicate": return text("已经记着，跳过", ja: "もう覚えているので飛ばします", en: "Already remembered, skipped")
        case "secret": return text("像是密码或证件号，默认不导入", ja: "パスワードや身分証番号のようなので、既定ではインポートしません", en: "Looks like a password or ID number, off by default")
        case "unclassified": return text("没能分类，默认不导入", ja: "分類できなかったので、既定ではインポートしません", en: "Couldn't be sorted, off by default")
        case "similar": return text("可能已经记着，默认不导入", ja: "もう覚えているかもしれないので、既定ではインポートしません", en: "May already be remembered, off by default")
        case "unchecked": return text("没能核对是否重复，默认不导入", ja: "重複を確かめられなかったので、既定ではインポートしません", en: "Couldn't check for duplicates, off by default")
        case "coding": return text("写代码的经验，默认不导入", ja: "コーディングの知見なので、既定ではインポートしません", en: "A coding tip, off by default")
        default: return nil
        }
    }
    static func importCommit(_ count: Int) -> String { text("导入勾选的 \(count) 条", ja: "チェックした \(count) 件をインポート", en: "Import \(count) ticked") }
    static func confirmImport(_ count: Int) -> String { text("导入 \(count) 条记忆", ja: "記憶 \(count) 件をインポート", en: "Import \(count) memories") }
    static func importDone(_ count: Int) -> String { text("已导入 \(count) 条", ja: "\(count) 件をインポートしました", en: "Imported \(count)") }
    static var importEmpty: String {
        text("没有找到可以导入的内容。确认选对了文件，或贴的是那个 AI 的回答。", ja: "インポートできる内容が見つかりません。ファイルが正しいか、AI の回答を貼り付けたか確かめてください。", en: "Nothing to import. Check you picked the right file or pasted the AI's answer.")
    }
    static var importUnreadable: String { text("文件读不出来，或者格式不对。", ja: "ファイルを読めないか、形式が違います。", en: "The file can't be read or isn't in the right format.") }
    static func importTooMany(_ maximum: Int) -> String { text("一次最多选 \(maximum) 个文件。", ja: "一度に選べるのは \(maximum) ファイルまでです。", en: "Pick at most \(maximum) files at a time.") }
    static func importTooLong(_ name: String, _ maximum: Int) -> String {
        text("“\(name)”超过 \(maximum) 个字，请拆开分几次导入。", ja: "「\(name)」が \(maximum) 文字を超えています。分けてインポートしてください。", en: "“\(name)” is over \(maximum) characters. Split it and import in parts.")
    }

    static var serverStatusTitle: String { text("服务器状态", ja: "サーバーの状態", en: "Server status") }
    static var statusOverall: String { text("整体", ja: "全体", en: "Overall") }
    static var statusOverallDefinition: String {
        text("服务器自检：每个必需的部件都正常才算正常", ja: "サーバーの自己診断：必要な部品がすべて正常なときだけ正常です", en: "The server's self-check: normal only when every required part is")
    }
    static func statusOverallValue(_ status: String) -> String {
        switch status {
        case "healthy": text("正常", ja: "正常", en: "Normal")
        case "degraded": text("有部件不正常", ja: "一部に問題あり", en: "Partly down")
        case "not_ready": text("还没准备好", ja: "準備中", en: "Not ready")
        default: text("没在运行", ja: "停止中", en: "Not running")
        }
    }
    static var statusWorker: String { text("后台执行程序", ja: "バックグラウンド実行プログラム", en: "Background runner") }
    static var statusWorkerDefinition: String {
        text("跑工具和后台任务的程序，看服务器最近一次自检", ja: "ツールやバックグラウンド作業を動かすプログラム。サーバーの直近の自己診断の結果です", en: "The program that runs tools and background work, from the server's latest self-check")
    }
    static func statusWorkerValue(_ healthy: Bool) -> String { healthy ? text("正常", ja: "正常", en: "Normal") : text("不正常", ja: "問題あり", en: "Down") }
    static var statusVersion: String { text("版本", ja: "バージョン", en: "Version") }
    static var statusVersionDefinition: String {
        text("服务器正在运行的代码对应的提交号", ja: "サーバーで動いているコードのコミット番号", en: "The commit of the code the server is running")
    }
    static var statusDeployed: String { text("上次上线", ja: "前回のリリース", en: "Last deployed") }
    static var statusDeployedDefinition: String {
        text("这个版本装到服务器上的时间", ja: "このバージョンをサーバーに入れた時刻", en: "When this version was installed on the server")
    }
    static var statusDisk: String { text("磁盘剩余", ja: "ディスクの空き", en: "Disk free") }
    static var statusDiskDefinition: String {
        text("存数据的那块磁盘上还能写入的空间，后面是总容量", ja: "データを置くディスクにまだ書き込める容量。後ろは全体の容量です", en: "Space still writable on the disk that holds the data, then its total size")
    }
    static func statusDiskValue(available: Int64, total: Int64) -> String {
        let style = ByteCountFormatter.CountStyle.file
        return "\(ByteCountFormatter.string(fromByteCount: available, countStyle: style)) / \(ByteCountFormatter.string(fromByteCount: total, countStyle: style))"
    }
    static func statusCheckedAt(_ date: Date) -> String {
        let time = date.formatted(date: .omitted, time: .shortened)
        return text("\(time) 查的，下拉刷新", ja: "\(time) に確認。引っ張って更新", en: "Checked at \(time). Pull to refresh")
    }
}
