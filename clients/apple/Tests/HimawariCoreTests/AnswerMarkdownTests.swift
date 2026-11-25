@testable import HimawariCore
import Testing

@Suite struct AnswerMarkdownTests {
    @Test func theTrainAnswerFromThePrototypeBecomesParagraphListAndTable() {
        let answer = """
        三班里 **9:30 那班最合适**：

        - 7:00：太早，到了要等 4 个小时
        - **9:30**：12:03 到，能吃午饭
        - 11:00：13:33 到，太赶

        | 出发 | 到达 | 指定席 |
        | --- | --- | --- |
        | 9:30 | 12:03 | 还有 |
        | 11:00 | 13:33 | 只剩靠过道 |
        """
        #expect(AnswerMarkdown.blocks(answer) == [
            .paragraph("三班里 **9:30 那班最合适**："),
            .bullets(["7:00：太早，到了要等 4 个小时", "**9:30**：12:03 到，能吃午饭", "11:00：13:33 到，太赶"]),
            .table(header: ["出发", "到达", "指定席"], rows: [["9:30", "12:03", "还有"], ["11:00", "13:33", "只剩靠过道"]]),
        ])
    }

    @Test func plainTextStaysOneParagraphAndKeepsItsAsterisks() {
        #expect(AnswerMarkdown.blocks("5*3 等于 15") == [.paragraph("5*3 等于 15")])
        #expect(AnswerMarkdown.blocks("第一行\n第二行") == [.paragraph("第一行\n第二行")])
        #expect(AnswerMarkdown.blocks("") == [])
    }

    @Test func headingsCodeQuotesNumbersAndRules() {
        let answer = """
        ## 步骤
        1. 打开设置
        2) 点通知

        > 晚上 11 点以后不响

        ```swift
        let x = 1
        ```
        ---
        """
        #expect(AnswerMarkdown.blocks(answer) == [
            .heading(level: 2, text: "步骤"),
            .numbered(start: 1, items: ["打开设置", "点通知"]),
            .quote("晚上 11 点以后不响"),
            .code(language: "swift", text: "let x = 1"),
            .rule,
        ])
    }

    @Test func aHashWithoutSpaceOrABarWithoutDelimiterIsJustText() {
        #expect(AnswerMarkdown.blocks("#话题 不是标题") == [.paragraph("#话题 不是标题")])
        #expect(AnswerMarkdown.blocks("A | B 都行") == [.paragraph("A | B 都行")])
        #expect(AnswerMarkdown.blocks("*斜体* 开头") == [.paragraph("*斜体* 开头")])
    }

    @Test func tableRowsArePaddedOrCutToTheHeader() {
        let answer = "| a | b |\n|:-|-:|\n| 1 |\n| 2 | 3 | 4 |\n后面的话"
        #expect(AnswerMarkdown.blocks(answer) == [
            .table(header: ["a", "b"], rows: [["1", ""], ["2", "3"]]),
            .paragraph("后面的话"),
        ])
    }

    @Test func whileStreamingAnOpenBoldIsClosedSoNoStarsShow() {
        #expect(AnswerMarkdown.settled("三班里 **9:30 那") == "三班里 **9:30 那**")
        #expect(AnswerMarkdown.settled("三班里 **") == "三班里 ")
        #expect(AnswerMarkdown.settled("三班里 *") == "三班里 ")
        #expect(AnswerMarkdown.settled("用 `npm") == "用 `npm`")
        #expect(AnswerMarkdown.settled("**好**") == "**好**")
        #expect(AnswerMarkdown.settled("5*3") == "5*3")
        #expect(AnswerMarkdown.blocks("- **9:30**：12:0", streaming: true) == [.bullets(["**9:30**：12:0"])])
    }

    @Test func whileStreamingAnOpenCodeFenceStaysCode() {
        #expect(AnswerMarkdown.settled("```\nlet a = **b") == "```\nlet a = **b")
        #expect(AnswerMarkdown.blocks("说明\n```js\nconst a", streaming: true) == [
            .paragraph("说明"),
            .code(language: "js", text: "const a"),
        ])
    }

    @Test func escapedBarsStayInsideACell() {
        #expect(AnswerMarkdown.cells("| a \\| b | c |") == ["a | b", "c"])
    }
}
