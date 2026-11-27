#!/usr/bin/env python3
"""Source excerpts and chat planning (item С-13). Needs poppler (pdftotext, pdfinfo, pdftoppm)
and, for scans, tesseract.

  python3 tools/vyderzhki.py info FILE_OR_FOLDER...
      pages, kind (текст / плохой слой / скан) and weight of every PDF, without reading it for content;
      files already named in corrections/source-dates.tsv weigh 0. About 8 weight units fit one chat.

  python3 tools/vyderzhki.py text FILE "term1|term2" [--mode and|or|terms|dates] [--pages A-B]
                                  [--max 6000] [--ocr spa+eng]
      paragraphs with dates and/or the given names. mode: and = a term AND a date (default),
      or = either, terms = terms only, dates = dates only. --ocr recognises the pages instead of
      reading the text layer (language files: Claude outputs/tessdata/).
"""
import argparse, re, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TESSDATA = ROOT / 'Claude outputs' / 'tessdata'
DATE = re.compile(r'(\d[\d,. ]{2,6}\s*(±|\+/-|\+-)\s*\d{2,4})|\b\d{1,2}[,.]?\d{3}\s*(B\.?P|RCYBP|cal|BC|B\.C|л\. ?н|a\.?P)'
                  r'|до н\. ?э|\b(Beta|WSU|GaK|SFU|UCR|UCLA|LJ|WIS|RL|GX|Tx|SI|CAMS|AA|UGa|Wk|NZA|TO|RIDDL|OS|OxA|Gif|Ly|KIA|Poz|LU|SOAN|S|I)-\s?\d{2,6}')


def pdf_text(path, first=None, last=None):
    args = ['pdftotext', '-layout']
    if first: args += ['-f', str(first), '-l', str(last)]
    return subprocess.run(args + [str(path), '-'], capture_output=True, text=True, errors='replace').stdout


def page_count(path):
    out = subprocess.run(['pdfinfo', str(path)], capture_output=True, text=True, errors='replace').stdout
    m = re.search(r'^Pages:\s+(\d+)', out, re.M)
    return int(m.group(1)) if m else 0


def kind_of(text, pages):
    letters = sum(c.isalpha() for c in text)
    if pages and letters / pages < 250:
        return 'скан'
    words = re.findall(r'\S+', text)
    if not words:
        return 'скан'
    junk = sum(1 for w in words if '�' in w or (len(w) == 1 and w.isalpha() and w.lower() not in 'aiвикосуя')
               or re.search(r'[^\W\d_][^\w\s\'’\-.,:;()/\[\]«»"“”–—]+[^\W\d_]', w))
    return 'плохой слой' if junk / len(words) > 0.08 else 'текст'


def weight(kind, pages):
    base = max(0.5, min(pages / 25, 3))          # an "average" article (about 25 pages) = 1
    return round(base * (1 if kind == 'текст' else 2.5), 1)


def cmd_info(a):
    files = []
    for p in map(Path, a.paths):
        files += sorted(p.rglob('*')) if p.is_dir() else [p]
    opis = (ROOT / 'corrections' / 'source-dates.tsv').read_text(encoding='utf-8-sig')
    total = 0
    print('Вес\tСтраниц\tТип\tУже в описи\tФайл')
    for f in files:
        if not f.is_file():
            continue
        if f.suffix.lower() != '.pdf':
            print(f'?\t?\t{f.suffix or "без расширения"}\t\t{f.name}')
            continue
        n = page_count(f)
        kind = kind_of(pdf_text(f, 1, min(n, 15)) if n else '', min(n, 15))
        seen = f.name in opis
        w = 0 if seen else weight(kind, n)
        total += w
        print(f'{w}\t{n}\t{kind}\t{"да" if seen else ""}\t{f.name}')
    print(f'\nВсего вес {round(total, 1)} ≈ чатов разбора: {max(1, round(total / 8))} (≈ 8 на чат)')


def ocr_pages(path, first, last, lang):
    out = []
    with tempfile.TemporaryDirectory() as d:
        subprocess.run(['pdftoppm', '-r', '200', '-gray', '-f', str(first), '-l', str(last), '-png', str(path), f'{d}/p'], check=True)
        for img in sorted(Path(d).glob('p*.png')):
            extra = ['--tessdata-dir', str(TESSDATA)] if TESSDATA.is_dir() else []
            r = subprocess.run(['tesseract', str(img), '-', '-l', lang] + extra, capture_output=True, text=True, errors='replace')
            if r.returncode:
                sys.exit(r.stderr)
            out.append(r.stdout)
    return out


def cmd_text(a):
    n = page_count(a.file)
    first, last = (map(int, a.pages.split('-')) if a.pages else (1, n))
    pages = ocr_pages(a.file, first, last, a.ocr) if a.ocr else pdf_text(a.file, first, last).split('\f')
    terms = re.compile(a.terms, re.I)
    out = []
    for i, page in enumerate(pages):
        for par in re.split(r'\n\s*\n', page):
            d, t = bool(DATE.search(par)), bool(terms.search(par))
            if {'and': d and t, 'or': d or t, 'terms': t, 'dates': d}[a.mode]:
                out.append(f'[p{i + first}] ' + re.sub(r'[ \t]+', ' ', par.strip()))
    res = '\n---\n'.join(out)
    kind = 'распознано' if a.ocr else kind_of('\f'.join(pages), len(pages))
    print(f'{kind}; абзацев {len(out)}, знаков {len(res)}')
    print(res[:a.max])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    i = sub.add_parser('info'); i.add_argument('paths', nargs='+'); i.set_defaults(fn=cmd_info)
    t = sub.add_parser('text'); t.add_argument('file'); t.add_argument('terms')
    t.add_argument('--mode', choices=['and', 'or', 'terms', 'dates'], default='and')
    t.add_argument('--pages'); t.add_argument('--max', type=int, default=6000); t.add_argument('--ocr')
    t.set_defaults(fn=cmd_text)
    a = ap.parse_args()
    a.fn(a)


if __name__ == '__main__':
    main()
