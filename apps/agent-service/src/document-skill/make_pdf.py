import json
import re
import sys
from pathlib import Path

from pypdf import PdfReader
from weasyprint import CSS, HTML

TEMPLATE = Path(__file__).resolve().with_name('a4.css')
CJK = re.compile(r'[぀-ヿ㐀-鿿가-힯]')


def font_report(reader):
    fonts = {}
    for page in reader.pages:
        resources = page.get('/Resources') or {}
        for font in (resources.get('/Font') or {}).values():
            font = font.get_object()
            descendants = font.get('/DescendantFonts')
            described = descendants[0].get_object() if descendants else font
            descriptor = described.get('/FontDescriptor')
            descriptor = descriptor.get_object() if descriptor else {}
            embedded = any(key in descriptor for key in ('/FontFile', '/FontFile2', '/FontFile3'))
            fonts[str(font.get('/BaseFont'))] = embedded
    return fonts


def check(pdf):
    reader = PdfReader(pdf)
    text = ''.join(page.extract_text() or '' for page in reader.pages)
    fonts = font_report(reader)
    problems = []
    if not reader.pages:
        problems.append('PDF 没有页面')
    if not text.strip():
        problems.append('PDF 里提取不到文字')
    problems += ['字体没有嵌入：' + name for name, embedded in fonts.items() if not embedded]
    if CJK.search(text) and not any('CJK' in name for name in fonts):
        problems.append('有中日韩文字，但没有用 Noto CJK 字体')
    return {'pdf': str(pdf), 'pages': len(reader.pages), 'fonts': sorted(fonts), 'problems': problems}


def main(arguments):
    if len(arguments) != 2 or not arguments[0].endswith(('.html', '.htm')) or not arguments[1].endswith('.pdf'):
        print('用法：python3 make_pdf.py 输入.html 输出.pdf', file=sys.stderr)
        return 2
    source, target = Path(arguments[0]), Path(arguments[1])
    HTML(filename=str(source), base_url=str(source.resolve().parent)).write_pdf(str(target), stylesheets=[CSS(filename=str(TEMPLATE))])
    report = check(target)
    print(json.dumps(report, ensure_ascii=False))
    return 1 if report['problems'] else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
